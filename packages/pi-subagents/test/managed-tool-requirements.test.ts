import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { createManagedEmbeddedExecutionBackend } from "../src/backends/embedded-managed.js";
import { ManagedSession } from "../src/backends/managed-session.js";
import { prepareManagedPolicy } from "../src/backends/managed-policy.js";
import type { ExecutionSession } from "../src/backends/session.js";
import { sessionWitness } from "../src/backends/session-witness.js";
import { createTerminalExecutionBackend } from "../src/backends/terminal/backend.js";
import type { ChildFeedback, TerminalSnapshot } from "../src/backends/terminal/bridge-protocol.js";
import type { TerminalExit } from "../src/backends/terminal/types.js";
import type { AgentExecutionBackend, ExecutionRunOptions } from "../src/backends/types.js";
import { i18n } from "../src/i18n.js";
import type { AgentConfig } from "../src/types.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const TYPE = "required-tools-offline";
const compiled = compileJsonSchema({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false });
if (!compiled.ok) throw new Error(compiled.message);
const schema = compiled.compiled;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  registerAgents(new Map());
  vi.restoreAllMocks();
});

function fixture(kind: "embedded" | "terminal", structured = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "managed-tools-")));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const artifactDir = join(root, "runs");
  mkdirSync(agentDir);
  const configure = (overrides: Partial<AgentConfig> = {}) => registerAgents(new Map([[TYPE, {
    name: TYPE, description: "Offline requirement fixture", builtinToolNames: ["read"], extensions: false,
    skills: false, systemPrompt: "Follow the task.", promptMode: "replace", persistSession: true, ...overrides,
  }]]));
  configure();
  const faux = registerFauxProvider({ provider: TYPE, models: [{ id: "model", contextWindow: 200_000 }] });
  const runtime = fauxModelBackend(faux.getModel());
  runtime.modelRegistry.runtime = runtime.modelRuntime;
  const ctx = { cwd: root, model: faux.getModel(), modelRegistry: runtime.modelRegistry,
    sessionManager: SessionManager.inMemory(root), getSystemPrompt: () => "Parent" } as ExtensionContext;
  const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "" }));
  const pi = { exec } as unknown as ExtensionAPI;
  const createSession = vi.fn(createAgentSession);
  const snapshot: TerminalSnapshot = { messages: [], model: { provider: TYPE, id: "model" },
    stats: { tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: null } } };
  const calls: Array<{ ready: () => void; exit: Promise<TerminalExit> }> = [];
  const bridge = vi.fn(async (run, feedback: (event: ChildFeedback) => void) => {
    const ready = deferred<TerminalSnapshot>();
    const settled = deferred<Extract<ChildFeedback, { type: "settled" }>>();
    const exit = deferred<TerminalExit>();
    calls.push({ ready: () => { feedback({ type: "ready", snapshot }); ready.resolve(snapshot); }, exit: exit.promise });
    return {
      endpoint: { host: "127.0.0.1" as const, port: 1, token: "offline" }, ready: ready.promise, settled: settled.promise,
      start: () => {
        const rows = readFileSync(run.session.sessionFile, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
        const final: Extract<ChildFeedback, { type: "settled" }> = {
          type: "settled", snapshot, text: "answer", aborted: false,
          witness: sessionWitness(SessionManager.inMemory(root, undefined, rows)),
          ...(structured ? { structuredJson: '{"answer":"value"}' } : {}),
        };
        feedback(final);
        settled.resolve(final);
        exit.resolve({ reason: "sentinel", exitCode: 0 });
      },
      admit: () => {}, steer: async () => {}, interrupt: async () => {}, abort: () => {}, close: async () => {},
    };
  });
  const backend: AgentExecutionBackend = kind === "embedded"
    ? createManagedEmbeddedExecutionBackend({ agentDir, sessionDir }, { createSession })
    : createTerminalExecutionBackend({ agentDir, sessionDir, artifactDir }, {
      bridge,
      waitForExit: () => calls.at(-1)!.exit,
      dependencies: {
        transport: {
          createSurface: () => `surface-${calls.length}`,
          sendCommand: () => { queueMicrotask(() => calls.at(-1)!.ready()); },
          sendEscape: () => {}, closeSurface: () => {}, waitForExit: () => calls.at(-1)!.exit,
        },
        artifacts: { prepare: () => ({ byteOffset: 0 }), readSummary: () => "answer" },
        now: Date.now, delay: async () => {},
      },
    });
  const handles = new Set<ExecutionSession>();
  function respond() {
    faux.setResponses([
      ...(structured ? [fauxAssistantMessage(fauxToolCall("StructuredOutput", { answer: "value" }), { stopReason: "toolUse" })] : []),
      fauxAssistantMessage("answer"),
    ]);
  }
  async function run(extra: Partial<ExecutionRunOptions> = {}) {
    respond();
    return backend.run(ctx, TYPE, "Task", {
      pi, isolated: true, ...(structured ? { structuredOutput: schema } : {}), ...extra,
      onSessionCreated: handle => { handles.add(handle); extra.onSessionCreated?.(handle); },
    });
  }
  cleanups.push(async () => {
    await Promise.allSettled([...handles].map(handle => backend.shutdown(handle)));
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  });
  const effects = () => ({ model: faux.state.callCount, boot: createSession.mock.calls.length, bridge: bridge.mock.calls.length, env: exec.mock.calls.length });
  return { root, sessionDir, artifactDir, backend, ctx, pi, exec, configure, run, respond, effects, handles };
}

function saved(session: ExecutionSession) {
  const file = session.reference.sessionFile!;
  return { transcript: readFileSync(file), record: readFileSync(`${file}.pi-subagents.json`) };
}
const missing = (tools: string) => i18n.t("toolRequirements.missing", { tools });
const invalid = () => i18n.t("toolRequirements.invalid", { maxTools: 256, maxNameLength: 256 });

describe.each(["embedded", "terminal"] as const)("managed %s required-tool preflight", kind => {
  it("rejects missing, denied and malformed fresh requirements before environment or child effects", async () => {
    const f = fixture(kind);
    f.configure({ builtinToolNames: ["read", "write"], disallowedTools: ["write"] });
    for (const name of ["write", "Read", "unknown", "StructuredOutput"]) {
      await expect(f.run({ requiredTools: [name] })).rejects.toThrow(missing(name));
    }
    for (const requiredTools of [["*"], ["read write"], "read"] as const) {
      await expect(f.run({ requiredTools: requiredTools as readonly string[] })).rejects.toThrow(invalid());
    }
    expect(f.effects()).toEqual({ model: 0, boot: 0, bridge: 0, env: 0 });
    expect(existsSync(f.sessionDir)).toBe(false);
    expect(existsSync(f.artifactDir)).toBe(false);
  });

  it("keeps fresh requirements immutable while asynchronous environment preparation yields", async () => {
    const f = fixture(kind);
    const entered = deferred<void>();
    const gate = deferred<void>();
    f.exec.mockImplementation(async () => { entered.resolve(); await gate.promise; return { code: 1, stdout: "", stderr: "" }; });
    const requiredTools = ["read", "read"];
    const options: ExecutionRunOptions = { pi: f.pi, isolated: true, requiredTools, onSessionCreated: handle => f.handles.add(handle) };
    f.respond();
    const running = f.backend.run(f.ctx, TYPE, "Task", options);
    void running.catch(() => {});
    try {
      await Promise.race([entered.promise, running.then(() => { throw new Error("Missing environment gate"); })]);
      requiredTools.push("write");
      options.requiredTools = ["bash"];
    } finally { gate.resolve(); }
    const result = await running;
    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("answer");
    const policy = JSON.parse(saved(result.session).record.toString()).policy;
    expect(policy.tools).toEqual(["read"]);
    expect(policy).not.toHaveProperty("requiredTools");
  });

  it("checks saved tools rather than changed defaults and leaves rejected resumes byte-for-byte clean", async () => {
    const f = fixture(kind);
    const { session } = await f.run({ requiredTools: ["read"] });
    f.configure({ builtinToolNames: ["write"], disallowedTools: ["read"] });
    const before = saved(session);
    const entries = readdirSync(f.sessionDir).sort();
    const effects = f.effects();
    const begin = vi.spyOn(ManagedSession.prototype, "beginRun");
    const checkpoint = vi.spyOn(ManagedSession.prototype, "checkpoint");
    const onToolActivity = vi.fn();
    const onAssistantUsage = vi.fn();
    for (const requiredTools of [["write"], ["StructuredOutput"], ["*"]]) {
      await expect(f.backend.resume(session, "Must not start", { requiredTools, onToolActivity, onAssistantUsage }))
        .rejects.toThrow(requiredTools[0] === "*" ? invalid() : missing(requiredTools[0]));
      expect(saved(session)).toEqual(before);
    }
    expect(readdirSync(f.sessionDir).sort()).toEqual(entries);
    expect(f.effects()).toEqual(effects);
    expect(begin).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(onToolActivity).not.toHaveBeenCalled();
    expect(onAssistantUsage).not.toHaveBeenCalled();
    // A rejected precondition does not poison, reserve, capture or change the policy.
    f.respond();
    await expect(f.backend.resume(session, "Still read-only", { requiredTools: ["read"] })).resolves.toMatchObject({ text: "answer" });
    expect(JSON.parse(saved(session).record.toString()).policy.tools).toEqual(["read"]);
    f.respond();
    await expect(f.backend.resume(session, "Empty constraint", { requiredTools: [] })).resolves.toMatchObject({ text: "answer" });
  });

  it("admits StructuredOutput only for an enabled saved schema and keeps caller validation", async () => {
    const f = fixture(kind, true);
    const { session } = await f.run({ requiredTools: ["read", "StructuredOutput"], structuredOutput: {
      schema: schema.schema, check: () => "caller rejected",
    } });
    const before = saved(session);
    const effects = f.effects();
    await expect(f.backend.resume(session, "Denied", { requiredTools: ["write"] })).rejects.toThrow(missing("write"));
    expect(saved(session)).toEqual(before);
    expect(f.effects()).toEqual(effects);
    f.respond();
    const result = await f.backend.resume(session, "Structured next task", { requiredTools: ["StructuredOutput", "read"] });
    // Meeting the minimum tools does not bypass the retained validator.
    expect(result.failure).toBeDefined();
    expect(result.structuredJson).toBeUndefined();
    expect(JSON.parse(saved(session).record.toString()).policy.tools).toEqual(["read"]);
    expect(JSON.parse(saved(session).record.toString()).state).toBe("ready");
  });
});

describe("managed policy requirement ordering", () => {
  it("fails minimum tool checks before model resolution callbacks or environment preparation", async () => {
    const f = fixture("embedded");
    f.configure({ model: "faux/configured" });
    const find = vi.fn(() => { throw new Error("model lookup must follow tool preflight"); });
    const ctx = { ...f.ctx, modelRegistry: { find } } as unknown as ExtensionContext;
    await expect(prepareManagedPolicy(ctx, TYPE, { pi: f.pi, isolated: true, requiredTools: ["write"] }))
      .rejects.toThrow(missing("write"));
    expect(find).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
  });
});
