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
test("supported Pi reports management refusals as tool failures without launching a child", { timeout: 30_000 }, async () => {
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
  writeFileSync(join(agents, "safe.md"), "---\nname: safe\ntools:\n---\nConversation and control only.\n");
  let session: AgentSession | undefined;
  try {
    let nextCall: ToolCall | undefined;
    let callSequence = 0;
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerProvider("contract-fixture", {
      api: "contract-fixture", apiKey: "fixture-only", baseUrl: "http://unused.invalid",
      models: [{ id: "parent", name: "Deterministic fixture", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        const toolCall = nextCall;
        nextCall = undefined;
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          content: toolCall ? [toolCall] : [{ type: "text", text: "Tool result received." }], stopReason: "pending",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: message });
        if (toolCall) {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
        } else {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: "Tool result received.", partial: message });
        }
        message.stopReason = toolCall ? "toolUse" : "stop";
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
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
    const call = async (name: string, args: ToolCall["arguments"]) => {
      const id = `contract-${++callSequence}`;
      nextCall = { type: "toolCall", id, name, arguments: args };
      await session!.prompt("Perform the next deterministic management operation.");
      const result = session!.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
      assert.ok(result && result.role === "toolResult", `Pi must execute ${name}`);
      return result;
    };
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
    const launched = await call("subagent", { agent: "safe", task: "Return the exact phrase: accepted asynchronously." });
    assert.equal(launched.isError, false);
    assert.ok(launched.details && typeof launched.details === "object" && "status" in launched.details);
    assert.equal(launched.details.status, "started");
    assert.match(JSON.stringify(launched.content), /running in the background/);
    const receipt = await waitFor(() => existsSync(join(terminal, "received.json")) ? JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")) : undefined, "supported Pi launch receipt");
    assert.equal(receipt.args[receipt.args.indexOf("--tools") + 1], "ask_question");
    assert.equal(session.messages.some((message) => message.role === "custom" && message.customType === "subagent_result"), false, "launch returns while child completion is still gated");
    assert.deepEqual(executionErrors, [true, true, true, true, true, false]);
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
