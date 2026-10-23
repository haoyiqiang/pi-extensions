import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import subagents from "../pi-extension/subagents/index.ts";
import { closeSurface, shellEscape } from "../pi-extension/subagents/tmux.ts";
import { plainTheme, waitFor } from "./harness.ts";

// Approved tool/lifecycle seam, but with the supported Pi AgentSession and real
// agent-core execution instead of calling registered execute() ourselves. Only
// the external provider and terminal/process boundary are deterministic fixtures.
test("supported Pi reports management refusals as tool failures without launching a child", { timeout: 60_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subagents-pi-contract-")));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const testDir = dirname(fileURLToPath(import.meta.url));
  const project = join(root, "project");
  const agentDir = join(root, "config");
  const terminal = join(root, "terminal");
  const bin = join(root, "bin");
  const agents = join(project, ".pi/agents");
  for (const dir of [agents, agentDir, terminal, bin]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(testDir, "fixtures/terminal.mjs"), join(bin, "tmux"));
  const command = [process.execPath, "--import", fileURLToPath(import.meta.resolve("tsx")), join(testDir, "fixtures/runtime.ts")].map(shellEscape).join(" ");
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o755 });
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, TMUX: "fixture", TMUX_PANE: "%fixture-parent", SUBAGENT_TEST_TERMINAL: terminal, PI_CODING_AGENT_DIR: agentDir, PI_TERMINAL_MUX: "tmux" });
  process.chdir(project);
  writeFileSync(join(agents, "unsafe.md"), "---\nname: unsafe\n---\nNo tools declaration.\n");
  writeFileSync(join(agents, "safe.md"), "---\nname: safe\ntools:\nsession-mode: fork\n---\nConversation and control only.\n");
  let session: AgentSession | undefined;
  try {
    let nextCalls: ToolCall[] = [];
    let callSequence = 0;
    let providerRequests = 0;
    let providerGate: Promise<void> | undefined;
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerProvider("contract-fixture", {
      api: "contract-fixture", apiKey: "fixture-only", baseUrl: "http://unused.invalid",
      models: [{ id: "parent", name: "Deterministic fixture", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model) {
        providerRequests++;
        const stream = createAssistantMessageEventStream();
        const toolCalls = nextCalls;
        nextCalls = [];
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          content: toolCalls.length ? toolCalls : [{ type: "text", text: "Tool result received." }], stopReason: "pending",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: message });
        const complete = () => {
          if (toolCalls.length) {
            for (const [contentIndex, toolCall] of toolCalls.entries()) {
              stream.push({ type: "toolcall_start", contentIndex, partial: message });
              stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
            }
          } else {
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: "Tool result received.", partial: message });
          }
          message.stopReason = toolCalls.length ? "toolUse" : "stop";
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        };
        if (providerGate) void providerGate.then(complete); else complete();
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager, extensionFactories: [subagents],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const model = modelRuntime.getModel("contract-fixture", "parent");
    assert.ok(model, "the deterministic local provider must be available");
    ({ session } = await createAgentSession({
      cwd: project, agentDir, modelRuntime, model,
      thinkingLevel: "off", tools: ["subagent", "subagent_message", "subagents_list", "subagent_status"],
      sessionManager: SessionManager.create(project, join(root, "sessions")), settingsManager, resourceLoader,
    }));
    await session.bindExtensions({});
    const executionErrors: boolean[] = [];
    session.subscribe((event) => { if (event.type === "tool_execution_end") executionErrors.push(event.isError); });
    const call = async (name: string, args: ToolCall["arguments"], siblings: ToolCall[] = []) => {
      const id = `contract-${++callSequence}`;
      nextCalls = [...siblings, { type: "toolCall", id, name, arguments: args }];
      await session!.prompt(`Perform the next deterministic management operation: ${id}.`);
      const result = session!.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
      assert.ok(result && result.role === "toolResult", `Pi must execute ${name}`);
      return result;
    };
    // Minimum supported Pi does not initially flush custom entries until an
    // assistant exists. A real bound API call can therefore return and its
    // manager can contain the notification while the actual file is absent.
    let releaseProvider!: () => void;
    providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const coldTool = session.extensionRunner!.getToolDefinition("subagent")!;
    const cold = await coldTool.execute("cold-parent", { agent: "safe", task: "Return the exact phrase: first parent notification." }, undefined, undefined, session.extensionRunner!.createContext());
    writeFileSync(join(terminal, "finish"), "complete before any parent assistant");
    await waitFor(() => providerRequests === 1 ? true : undefined, "actual Pi custom notification request before first assistant");
    const inMemory = session.sessionManager.getEntries().find((entry: any) => entry.type === "custom_message" && entry.customType === "subagent_result");
    assert.ok(inMemory, "the genuine Pi manager already contains the result");
    assert.equal(existsSync(session.sessionFile!), false, "Pi 0.87.1 has not flushed this new parent yet");
    const coldStatus = await session.extensionRunner!.getToolDefinition("subagent_status")!.execute("cold-status", { id: (cold.details as any).id }, undefined, undefined, session.extensionRunner!.createContext());
    assert.equal((coldStatus.details as any).subagent.notifications.find((event: any) => event.type === "subagent_result").state, "dispatched-unconfirmed", "in-memory inclusion is never a durable receipt");
    providerGate = undefined;
    releaseProvider();
    await session.waitForIdle();
    await waitFor(() => readFileSync(join(terminal, "surface"), "utf8") === "closed" ? true : undefined, "initial notification cleanup");
    for (const file of ["surface", "received.json", "finish"]) rmSync(join(terminal, file), { force: true });

    const refused = await call("subagent", { agent: "unsafe", task: "Must never run." });
    assert.match(JSON.stringify(refused.content), /explicitly declare tools/);
    assert.equal(refused.isError, true, "a resolved execute result must not turn a refused launch into success");
    assert.equal(existsSync(join(terminal, "surface")), false, "unsafe launch creates no runnable child");
    const missing = await call("subagent_message", { name: "unknown", message: "Must not launch." });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing.content), /No subagent named/);
    assert.equal(existsSync(join(terminal, "surface")), false);

    const foreign = await call("subagent_status", { id: "not-owned" });
    assert.equal(foreign.isError, true, "status ownership failures use Pi's actual exception contract");
    assert.match(JSON.stringify(foreign.content), /owned by this parent/);
    delete process.env.TMUX;
    const unsupported = await call("subagent", { agent: "safe", task: "Must not run headless." });
    process.env.TMUX = "fixture";
    assert.equal(unsupported.isError, true, "unsupported terminal refusals use Pi's actual failure contract");
    assert.match(JSON.stringify(unsupported.content), /headless.*not supported/);
    assert.equal(existsSync(join(terminal, "surface")), false);

    // Exceptions lose structured details in supported Pi. Render the actual
    // error result, not the richer object returned by a shallow execute mock.
    process.env.PI_SUBAGENT_SESSION = join(root, "invalid-caller.jsonl");
    const invalidCaller = await call("subagents_list", {});
    delete process.env.PI_SUBAGENT_SESSION;
    assert.equal(invalidCaller.isError, true);
    for (const [name, result] of [["subagent", refused], ["subagent_message", missing], ["subagents_list", invalidCaller]] as const) {
      const tool = session.extensionRunner!.getToolDefinition(name)!;
      const rendered = tool.renderResult!({ ...result, details: result.details }, { expanded: false, isPartial: false }, plainTheme as any, { isError: result.isError } as any).render(100).join("\n");
      assert.match(rendered, /declare tools|No subagent named|Cannot verify/);
      assert.doesNotMatch(rendered, /✓|started|resumed|No subagent definitions found/);
    }
    // Branch navigation is intentionally not followed by another append: the
    // physical tail remains abandoned while the live manager selects the fork.
    const manager = session.sessionManager;
    manager.appendMessage({ role: "user", content: "Summarized obsolete history.", timestamp: 1 });
    const retained = manager.appendMessage({ role: "user", content: "Obsolete raw context.", timestamp: 2 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Useful inherited result." }],
      api: model.api, provider: model.provider, model: model.id, timestamp: 3, stopReason: "stop",
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } } });
    manager.appendCompaction("The authoritative compaction summary.", retained, 50_000);
    const activeLeaf = manager.appendContextEdit(retained, { content: "Revised active context." });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Abandoned answer must not be inherited." }], stopReason: "stop" } as AssistantMessage);
    manager.branch(activeLeaf);
    const launched = await call("subagent", { agent: "safe", task: "Return the exact phrase: accepted asynchronously." },
      [{ type: "toolCall", id: "batch-sibling", name: "subagents_list", arguments: {} }]);
    assert.equal(launched.isError, false);
    assert.ok(launched.details && typeof launched.details === "object" && "status" in launched.details);
    assert.equal(launched.details.status, "started");
    assert.match(JSON.stringify(launched.content), /running in the background/);
    const receipt = await waitFor(() => existsSync(join(terminal, "received.json")) ? JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")) : undefined, "supported Pi launch receipt");
    assert.equal(receipt.args[receipt.args.indexOf("--tools") + 1], "ask_question");
    assert.ok(receipt.context.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("management operation: contract-6.")),
      "fork retains the triggering instruction, stopping before the executing tool batch rather than the last user text");
    assert.equal(receipt.context.some((message: any) => message.role === "assistant" && message.content.some((block: any) => block.type === "toolCall" && block.id === "contract-6")), false);
    assert.match(JSON.stringify(receipt.context), /The authoritative compaction summary\./);
    assert.match(JSON.stringify(receipt.context), /Revised active context\./);
    assert.doesNotMatch(JSON.stringify(receipt.context), /Summarized obsolete|Obsolete raw context|Abandoned answer|batch-sibling/);
    assert.match(receipt.task, /Return the exact phrase: accepted asynchronously\./, "the child task arrives as a new instruction");
    assert.equal(receipt.context.at(-1).role, "user");
    assert.equal(receipt.context.at(-1).content, receipt.task, "Pi's child context ends with the newly delegated instruction");
    assert.equal(session.messages.some((message) => message.role === "custom" && message.customType === "subagent_result" && (message.details as any)?.id === (launched.details as any).id), false, "launch returns while this child's completion is still gated");
    assert.deepEqual(executionErrors, [true, true, true, true, true, false, false]);
    const finish = async (id: string) => {
      writeFileSync(join(terminal, "finish"), "release");
      const result = await waitFor(() => session!.messages.find((message) => message.role === "custom" && message.customType === "subagent_result" && (message.details as any)?.id === id), "persisted native result");
      await session!.waitForIdle();
      rmSync(join(terminal, "received.json"));
      rmSync(join(terminal, "finish"));
      return result;
    };
    const forkResult = await finish((launched.details as any).id);
    assert.equal((forkResult as any).details.usage.generation.inputTokens, 10, "inherited context is not charged as current work");
    assert.equal((forkResult as any).details.usage.session.inputTokens, 110, "session totals retain inherited usage");
    for (const mode of ["standalone", "lineage-only"]) {
      writeFileSync(join(agents, `${mode}.md`), `---\nname: ${mode}\ntools:\nsession-mode: ${mode}\n---\n`);
      const started = await call("subagent", { agent: mode, task: `Return the exact phrase: ${mode} context.` });
      assert.equal(started.isError, false);
      const child = await waitFor(() => existsSync(join(terminal, "received.json")) ? JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")) : undefined, `${mode} child context`);
      assert.deepEqual(child.context.map((message: any) => [message.role, message.content]), [["user", child.task]], `${mode} contains only its new task instruction`);
      assert.equal(child.header.parentSession, mode === "lineage-only" ? session.sessionFile : undefined);
      assert.match(child.task, new RegExp(`${mode} context`));
      await finish((started.details as any).id);
    }
    const queued = await call("subagent_message", { id: (launched.details as any).id, message: "Return the exact phrase: structured queued input.", messageId: "contract-id" });
    assert.equal(queued.isError, false);
    assert.equal((queued.details as any).status, "queued");
    const conflict = await call("subagent_message", { id: (launched.details as any).id, message: "Different bytes", messageId: "contract-id" });
    assert.equal(conflict.isError, true, "message ID conflicts must use the actual Pi execution-failure contract");
    const invalidReply = await call("subagent_message", { id: (launched.details as any).id, message: "An invalid answer", replyTo: "not-this-childs-question" });
    assert.equal(invalidReply.isError, true, "invalid question references fail through supported Pi, not an isError property on a resolved execute object");
    assert.match(JSON.stringify(invalidReply.content), /question.*replyTo/);
    const unauthorized = await call("subagent_message", { id: (launched.details as any).id, authorization: { actionId: "not-an-uncertain-action", decision: "retry", reason: "Generic resume is insufficient" } });
    assert.equal(unauthorized.isError, true);
    assert.match(JSON.stringify(unauthorized.content), /exact.*actionId/);

    // Notification acknowledgement must come from actual supported-Pi JSONL,
    // not the ExtensionAPI's void return or its in-memory manager. Even an
    // abandoned, context-edited notification is a delivered logical event.
    const eventId = (forkResult as any).details.eventId;
    assert.equal(typeof eventId, "string");
    const persisted = () => readFileSync(session!.sessionFile!, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "custom_message" && entry.details?.eventId === eventId);
    assert.equal(persisted().length, 1);
    const deliveredEntry = manager.getEntries().find((entry: any) => entry.type === "custom_message" && entry.details?.eventId === eventId)!;
    manager.appendContextEdit(deliveredEntry.id, null);
    manager.branch(deliveredEntry.parentId!);
    const requestsBeforeReload = providerRequests;
    await session.reload();
    await session.waitForIdle();
    assert.equal(persisted().length, 1, "a lost outbox receipt must not duplicate the actual parent message");
    assert.equal(providerRequests, requestsBeforeReload, "reloading must not wake the parent again for a delivered event on an abandoned branch");
    const statusTool = session.extensionRunner!.getToolDefinition("subagent_status")!;
    const recovered = await statusTool.execute("history-proof", { id: (launched.details as any).id }, undefined, undefined, session.extensionRunner!.createContext());
    assert.ok((recovered.details as any).subagent.notifications.some((event: any) => event.eventId === eventId && event.state === "persisted"));
  } finally {
    await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    if (existsSync(join(terminal, "pid"))) {
      try { process.kill(-Number(readFileSync(join(terminal, "pid"), "utf8")), "SIGKILL"); } catch {}
    }
    // Watcher detachment is not authority to close work. Teardown owns this
    // isolated fixture explicitly, after terminating its known child process.
    if (existsSync(join(terminal, "surface"))) closeSurface("%fixture");
    process.chdir(previousCwd);
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
