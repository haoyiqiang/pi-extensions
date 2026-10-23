// Actual supported Pi runtime/provider. Only provider IO and terminal hosting are controlled.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import childBridge from "../../pi-extension/subagents/subagent-done.ts";
import subagents from "../../pi-extension/subagents/index.ts";
import { waitFor } from "../harness.ts";

const root = process.env.SUBAGENT_TEST_TERMINAL!;
const executionId = process.env.PI_SUBAGENT_ID!;
const sessionFile = process.env.PI_SUBAGENT_SESSION!;
const args = process.argv.slice(2);
writeFileSync(join(root, "control-pid"), String(process.pid));
mkdirSync(dirname(sessionFile), { recursive: true });
if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: executionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n");
const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
let request = 0;
modelRuntime.registerProvider("fixture", {
  api: "inbox-fixture", apiKey: "fixture-only", baseUrl: "http://unused.invalid",
  models: [{ id: "parent-model", name: "Controlled inbox provider", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple(model, context) {
    const stream = createAssistantMessageEventStream();
    const call = `${executionId}-${++request}`;
    const inputs = context.messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : m.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
    appendFileSync(join(root, "provider-input.jsonl"), JSON.stringify({ call, executionId, inputs }) + "\n");
    const nested = inputs.find((input) => /NEST_(PARENT|CHILD|LEAF)/.test(input));
    const spawnRole = nested?.includes("NEST_PARENT") ? "branch" : nested?.includes("NEST_CHILD") ? "leaf" : undefined;
    const spawned = context.messages.some((m) => m.role === "toolResult" && m.toolName === "subagent");
    const nestedCalls = spawnRole && !spawned ? [{ type: "toolCall" as const, id: "nested-spawn", name: "subagent", arguments: { agent: spawnRole, task: spawnRole === "branch" ? "NEST_CHILD" : "NEST_LEAF" } }] : [];
    const ask = inputs.some((input) => input.includes("ASK_TWO")) && !context.messages.some((m) => m.role === "toolResult" && m.toolName === "ask_question");
    const questionCalls = ["Which API version?", "Which region?"].map((question, index) => ({ type: "toolCall" as const, id: `question-${index}`, name: "ask_question", arguments: { question } }));
    const output = nested ? `${nested.includes("NEST_PARENT") ? "Parent" : nested.includes("NEST_CHILD") ? "Child" : "Leaf"} incorporated: ${inputs.at(-1)}` : `Completed request ${request}.`;
    const calls = ask ? questionCalls : nestedCalls;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: calls.length ? calls : [{ type: "text", text: output }], stopReason: "pending",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message });
    void (async () => {
      await waitFor(() => existsSync(join(root, `release-${call}`)) ? true : undefined, "provider release", 120_000);
      if (calls.length) for (const [contentIndex, toolCall] of calls.entries()) {
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
      }
      else {
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: output, partial: message });
      }
      message.stopReason = calls.length ? "toolUse" : "stop";
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    })();
    return stream;
  },
});
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const tools = args[args.indexOf("--tools") + 1].split(",");
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir, settingsManager, extensionFactories: [childBridge, ...(tools.includes("subagent") ? [subagents] : []), (pi) => {
  pi.on("before_agent_start", async () => {
    if (!existsSync(join(root, "gate-preparation"))) return;
    writeFileSync(join(root, "preparing"), "waiting before agent_start");
    await waitFor(() => existsSync(join(root, "release-preparation")) ? true : undefined, "initial prompt preparation release", 120_000);
  });
}],
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
const { session } = await createAgentSession({ cwd: process.cwd(), agentDir, modelRuntime, model: modelRuntime.getModel("fixture", "parent-model")!, thinkingLevel: "off", tools,
  sessionManager: SessionManager.open(sessionFile), settingsManager, resourceLoader: loader });
let settlements = 0;
session.subscribe((event) => { if (event.type === "agent_settled") writeFileSync(join(root, "settlements"), String(++settlements)); });
const keepAlive = setInterval(() => {}, 1000);
await session.bindExtensions({ shutdownHandler: () => { clearInterval(keepAlive); session.dispose(); } });
writeFileSync(join(root, "received.json"), JSON.stringify({ args, executionId }));
let commandId: string | undefined;
setInterval(() => {
  if (!existsSync(join(root, "runtime-command.json"))) return;
  const command = JSON.parse(readFileSync(join(root, "runtime-command.json"), "utf8"));
  if (command.id === commandId) return;
  commandId = command.id;
  void (async () => {
    if (command.action === "reload") await session.reload();
    else await session.prompt(command.text, { streamingBehavior: "steer", expandPromptTemplates: false });
    writeFileSync(join(root, `command-${command.id}-done`), "done");
  })();
}, 20).unref();
if (process.env.PI_SUBAGENT_INBOX_ONLY !== "1") {
  const taskArg = args.at(-1)!;
  const task = taskArg.startsWith("@") ? readFileSync(taskArg.slice(1), "utf8") : taskArg;
  await session.prompt(task, { expandPromptTemplates: false });
}
