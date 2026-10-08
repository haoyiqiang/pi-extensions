import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";
import { createEventBus, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withTempAgentDir } from "@maplezzk/pi-test-utils";
import { registerAskUserQuestionTool } from "../packages/pi-ask-user-question/ask-user-question.ts";
import { ASK_USER_BLOCKED_EVENT } from "../packages/pi-ask-user-question/events.ts";

test("the native parallel agent loop serializes two questionnaire calls from one response", async () => {
  await withTempAgentDir(async () => {
    let definition: ToolDefinition | undefined;
    const events = createEventBus();
    const blocked: boolean[] = [];
    events.on(ASK_USER_BLOCKED_EVENT, (data) => blocked.push((data as { active: boolean }).active));
    registerAskUserQuestionTool({
      events,
      on() { return () => {}; },
      registerTool(tool: ToolDefinition) { definition = tool; },
    } as ExtensionAPI);
    assert.ok(definition);
    let active = 0;
    let peak = 0;
    let dialogs = 0;
    const ctx = {
      hasUI: true,
      mode: "rpc",
      ui: {
        async select(_title: string, options: string[]) {
          dialogs++;
          active++;
          peak = Math.max(peak, active);
          await setImmediate();
          active--;
          return options[0];
        },
        async input() { return ""; },
      },
    } as unknown as ExtensionContext;
    const params = { questions: [{ question: "Choose?", header: "Choice", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] };
    const model: Model<Api> = {
      id: "offline", name: "Offline", provider: "offline", api: "openai-completions",
      baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
      contextWindow: 4096, maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    let requests = 0;
    const agent = new Agent({
      initialState: {
        model,
        tools: [{ ...definition, execute: (id, args, signal, update) => definition!.execute(id, args, signal, update, ctx) }],
      },
      toolExecution: "parallel",
      streamFn() {
        const isFirst = requests++ === 0;
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: isFirst
            ? [{ type: "toolCall", id: "ask-1", name: "ask_user_question", arguments: params }, { type: "toolCall", id: "ask-2", name: "ask_user_question", arguments: params }]
            : [{ type: "text", text: "Done" }],
          stopReason: isFirst ? "toolUse" : "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        const stream = new AssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(); });
        return stream;
      },
    });
    await agent.prompt("Ask two independent questions.");
    assert.equal(dialogs, 2);
    assert.equal(peak, 1, "only one native dialog may await input at a time");
    assert.deepEqual(blocked, [true, false, true, false]);
    assert.equal(agent.state.messages.filter((message) => message.role === "toolResult").length, 2);
  }, "pi-question-sequential-");
});
