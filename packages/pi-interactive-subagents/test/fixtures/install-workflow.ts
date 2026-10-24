// Runs from a copied fixture in an independent npm consumer, never repo node_modules.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { AgentSessionRuntime, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { getMuxBackend, shellEscape } from "@kevinhao/pi-terminal-mux";
import { waitFor } from "./harness.ts";

const consumer = process.cwd();
const real = process.env.PI_SUBAGENT_SMOKE_BACKEND;
const root = join(consumer, `workflow-${process.argv[2]}`);
const project = join(root, "project");
const agentDir = join(root, "config");
const terminal = join(root, "terminal");
const bin = join(root, "bin");
for (const dir of [project, agentDir, terminal, bin]) mkdirSync(dir, { recursive: true });
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.SUBAGENT_TEST_TERMINAL = terminal;
process.env.SUBAGENT_TEST_TERMINAL_BASE = terminal;
const fixture = join(consumer, "fixtures/pi-runtime.ts");
writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${[process.execPath, "--import", import.meta.resolve("tsx"), fixture].map(shellEscape).join(" ")} "$@"\n`, { mode: 0o755 });
if (real) {
  assert.ok(real === "tmux" || real === "orca", "explicit smoke backend must be tmux or orca");
  assert.equal(getMuxBackend(), real, "run inside a disposable supported terminal with its real parent identity");
  const executable = execFileSync("which", [real], { encoding: "utf8" }).trim();
  // Native terminal servers do not inherit this harness process's changed PATH.
  // Forward every real CLI operation unchanged except for carrying the private
  // provider-host environment on the complete startup command. No server/global
  // environment or user configuration is modified; inventory/closure stay real.
  const environment = Object.entries({ PATH: `${bin}:${process.env.PATH}`, SUBAGENT_TEST_TERMINAL: terminal, SUBAGENT_TEST_TERMINAL_BASE: terminal })
    .map(([key, value]) => `${key}=${shellEscape(value)}`).join(" ");
  writeFileSync(join(bin, real), `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nconst args = process.argv.slice(2);\nconst index = ${JSON.stringify(real)} === 'tmux' && args[0] === 'split-window' && args.includes('--') ? args.length - 1 : args.includes('--command') ? args.indexOf('--command') + 1 : -1;\nif (index >= 0) args[index] = ${JSON.stringify(`export ${environment}; `)} + args[index];\nconst result = spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit' });\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`, { mode: 0o755 });
} else {
  copyFileSync(join(consumer, "terminal.mjs"), join(bin, "tmux"));
  Object.assign(process.env, { PI_TERMINAL_MUX: "tmux", TMUX: "fixture", TMUX_PANE: "%fixture-parent" });
}
process.env.PATH = `${bin}:${process.env.PATH}`;
process.chdir(project);
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
let next: ToolCall[] = [];
let sequence = 0;
modelRuntime.registerProvider("fixture", {
  api: "install-fixture", apiKey: "fixture-only", baseUrl: "http://unused.invalid",
  models: [{ id: "parent-model", name: "Local installation smoke", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple(model) {
    const stream = createAssistantMessageEventStream();
    const calls = next; next = [];
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: calls.length ? calls : [{ type: "text", text: "Native operation observed." }], stopReason: calls.length ? "toolUse" : "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message }); stream.end();
    return stream;
  },
});
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const extension = join(consumer, "node_modules", process.argv[2] === "root" ? "pi-extensions" : "pi-interactive-subagents");
let session: AgentSession;
const create = async (sessionManager: SessionManager) => {
  const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager,
    additionalExtensionPaths: [extension], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const created = await createAgentSession({ cwd: project, agentDir, modelRuntime, model: modelRuntime.getModel("fixture", "parent-model")!, thinkingLevel: "off",
    tools: ["subagent", "subagent_message", "subagents_list", "subagent_status", "subagent_stop"], sessionManager, settingsManager, resourceLoader });
  return { ...created, services: { cwd: project, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] }, diagnostics: [] };
};
const initial = await create(SessionManager.create(project, join(root, "sessions")));
session = initial.session;
const host = new AgentSessionRuntime(session, initial.services, async (options) => create(options.sessionManager));
const bind = async (fresh: AgentSession) => { session = fresh; await fresh.bindExtensions({ shutdownHandler: () => { void host.dispose(); } }); };
host.setRebindSession(bind);
await bind(session);
const call = async (name: string, args: ToolCall["arguments"]) => {
  await session.waitForIdle();
  const id = `install-${++sequence}`;
  // The full-suite root includes Distill's documented outputRequest contract.
  const parameters = session.extensionRunner!.getToolDefinition(name)!.parameters as any;
  next = [{ type: "toolCall", id, name, arguments: parameters.properties?.outputRequest ? { ...args, outputRequest: "RAW" } : args }];
  await session.prompt(`Execute native installation check ${id}.`);
  const result = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.isError, false, JSON.stringify(result.content));
  return result.details as any;
};
const requests = () => existsSync(join(terminal, "provider-input.jsonl")) ? readFileSync(join(terminal, "provider-input.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
const release = async (index: number) => {
  const request = await waitFor(() => requests()[index], `installed child request ${index}`, 30_000);
  writeFileSync(join(terminal, `release-${request.call}`), "release deterministic local provider");
  return request;
};
const status = async (id: string) => (await call("subagent_status", { id })).subagent;
const resultFor = (id: string, generation: number) => session.messages.find((m) => m.role === "custom" && m.customType === "subagent_result" && (m.details as any)?.id === id && (m.details as any)?.generation === generation);
try {
  const roles = await call("subagents_list", {});
  assert.match(JSON.stringify(roles), /scout/); assert.match(JSON.stringify(roles), /researcher/); assert.match(JSON.stringify(roles), /worker/);
  const started = await call("subagent", { agent: "scout", task: "ASK_TWO" });
  assert.equal(started.status, "started");
  assert.equal(resultFor(started.id, 1), undefined, "spawn is an asynchronous launch acknowledgement");
  await release(0); await release(1);
  const waiting = await waitFor(async () => {
    const state = await status(started.id);
    return state.questions.length === 2 && existsSync(join(terminal, "settlements")) ? state : undefined;
  }, "two installed-control questions", 30_000);
  assert.equal(resultFor(started.id, 1), undefined, "unanswered questions prevent final result");
  await session.reload();
  const restored = await status(started.id);
  assert.deepEqual(restored.questions.map((q: any) => q.questionId), waiting.questions.map((q: any) => q.questionId));
  assert.equal(restored.generation, 1, "reload did not replace the live writer");
  const multiline = "Use v2.\n  Preserve indentation.\r\n";
  await call("subagent_message", { id: started.id, replyTo: waiting.questions[0].questionId, message: multiline });
  assert.equal((await release(2)).inputs.at(-1), multiline);
  await call("subagent_message", { id: started.id, replyTo: waiting.questions[1].questionId, message: "Use eu-west" });
  assert.equal((await release(3)).inputs.at(-1), "Use eu-west");
  const result = await waitFor(() => resultFor(started.id, 1), "native installed settlement result", 30_000) as any;
  assert.equal(result.details.outcome, "succeeded"); assert.ok(existsSync(result.details.resultFile));
  assert.match(readFileSync(result.details.resultFile, "utf8"), /Completed request/);

  // A separately live task is suspended by actual public parent replacement,
  // then automatically continued from pinned history and stopped with evidence.
  const active = await call("subagent", { agent: "scout", task: "Known safe installation continuation" });
  await waitFor(() => requests()[4], "active work before parent replacement", 30_000);
  const parentFile = session.sessionFile!;
  await host.newSession();
  await host.switchSession(parentFile);
  const continuation = await waitFor(() => requests()[5], "automatic installed continuation", 30_000);
  assert.match(continuation.inputs.at(-1), /new continuation/);
  const continued = await waitFor(async () => {
    const state = await status(active.id);
    return state.generation === 2 && state.state === "running" ? state : undefined;
  }, "replacement writer ready before stop", 30_000);
  assert.equal(continued.generation, 2);
  assert.match(continued.loadout.toolAllowlist, /read/);
  assert.doesNotMatch(continued.loadout.toolAllowlist, /bash|write/);
  assert.equal((await call("subagent_stop", { id: active.id })).status, "stopped");
  const stopped = await status(active.id);
  assert.equal(stopped.state, "stopped"); assert.equal(stopped.closure, "confirmed");
  assert.equal(stopped.liveness.writer, "exited"); assert.ok(existsSync(stopped.sessionFile));
  await session.reload(); assert.equal((await status(active.id)).state, "stopped");
  for (const role of ["researcher", "worker"]) {
    const child = await call("subagent", { agent: role, task: "Verify bundled role resources without executing business tools" });
    const pinned = await status(child.id);
    for (const path of Object.values(pinned.loadout.extensions) as string[]) {
      assert.ok(path.startsWith(join(consumer, "node_modules")), `installed role backing extension must resolve inside the consumer: ${path}`);
      assert.ok(existsSync(path));
    }
    assert.equal((await call("subagent_stop", { id: child.id })).status, "stopped");
  }
  console.log(JSON.stringify({ installation: process.argv[2], backend: real ?? "isolated fixture", workflow: "discovery/spawn/send/ask/reply/settlement/result/reload/suspend/continue/stop", outcome: "passed" }));
} finally {
  await host.dispose();
  // Only isolated terminal stand-ins own process groups recorded here.
  if (!real) for (const file of readdirSync(terminal, { recursive: true }).map(String).filter((file) => file === "pid" || file.endsWith("/pid"))) {
    try { process.kill(-Number(readFileSync(join(terminal, file), "utf8")), "SIGKILL"); } catch {}
  }
}
