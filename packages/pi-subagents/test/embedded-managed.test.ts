/** Real SDK, persisted JSONL, tools and lifecycle. Only model responses/auth are faux. */
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage, fauxToolCall, getCurrentTools, getSystemMessageText,
  type FauxResponseStep, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, SessionManager, type AgentSession, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultMaxTurns, getGraceTurns, setDefaultMaxTurns, setGraceTurns } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createEmbeddedExecutionBackend } from "../src/backends/embedded-adapter.js";
import { createManagedEmbeddedExecutionBackend, type ManagedEmbeddedConfig } from "../src/backends/embedded-managed.js";
import type { ExecutionSession } from "../src/backends/session.js";
import type { PersistentSessionReference } from "../src/backends/session-reference.js";
import type { AgentExecutionBackend, ExecutionRestoreOptions, ExecutionRunOptions } from "../src/backends/types.js";
import { i18n } from "../src/i18n.js";
import { createStructuredCapture, structuredFailure } from "../src/structured-output.js";
import type { AgentConfig } from "../src/types.js";
import { compileJsonSchema, type CompiledSchema } from "../src/workflow/json-schema.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });
const TYPE = "embedded-managed-offline";
// Native retry defaults stay enabled. This is intentionally not a transient error.
const FATAL = "invalid request: offline provider rejected the prompt";
const text = (value: string) => fauxAssistantMessage(value);
const structured = (payload: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall("StructuredOutput", payload), { stopReason: "toolUse" });
const readTurn = () => fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" });
function compile(schema: Record<string, unknown>): CompiledSchema {
  const result = compileJsonSchema(schema);
  if (!result.ok) throw new Error(result.message);
  return result.compiled;
}
const ANSWER = compile({
  type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false,
});
const COUNT = compile({
  type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((block) => block.type === "text" ? block.text : "").join("") : "";
}
function reference(session: ExecutionSession): PersistentSessionReference<"embedded"> {
  expect(session.reference.backend).toBe("embedded");
  expect(session.reference.sessionFile).toBeTypeOf("string");
  return session.reference as PersistentSessionReference<"embedded">;
}
const lockPath = (ref: PersistentSessionReference) => `${ref.sessionFile}.pi-subagents.lock`;
const recordPath = (ref: PersistentSessionReference) => `${ref.sessionFile}.pi-subagents.json`;
const record = (ref: PersistentSessionReference) => JSON.parse(readFileSync(recordPath(ref), "utf8"));
const rows = (ref: PersistentSessionReference) => readFileSync(ref.sessionFile, "utf8").trimEnd().split("\n").map((row) => JSON.parse(row));
type CreateOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

// No vi.mock: every launch/restore uses the real loader, AgentSession, invocation
// executor, native tool registry, managed store and neutral-handle adapter.
describe("managed embedded sessions (offline real SDK)", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let sessionDir: string;
  let previousAgentDir: string | undefined;
  let previousMax: number | undefined;
  let previousGrace: number;
  let faux: ReturnType<typeof registerFauxProvider>;
  let runtime: ReturnType<typeof fauxModelBackend>;
  let ctx: ExtensionContext;
  let pi: ExtensionAPI;
  let config: AgentConfig;
  let pending: Promise<unknown>[];
  let releases: Array<() => void>;
  let handles: Array<{ backend: AgentExecutionBackend; session: ExecutionSession }>;
  let natives: AgentSession[];
  let creations: CreateOptions[];

  function configure(overrides: Partial<AgentConfig> = {}) {
    config = {
      name: TYPE, description: "Offline managed session fixture", displayName: "Managed fixture",
      builtinToolNames: ["read"], systemPrompt: "Keep the original managed policy.", promptMode: "replace",
      extensions: false, skills: false, inheritContext: false, isolated: true, persistSession: true,
      ...overrides,
    };
    registerAgents(new Map([[TYPE, config]]));
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.push(promise);
    // Some expected failures happen before a test can install its assertion.
    void promise.catch(() => {});
    return promise;
  }
  function own(backend: AgentExecutionBackend, session: ExecutionSession): ExecutionSession {
    if (!handles.some((entry) => entry.session === session)) handles.push({ backend, session });
    return session;
  }
  function factory(options: ManagedEmbeddedConfig = {}, hooks: {
    beforeCreate?: (options: CreateOptions) => Promise<void>;
    afterCreate?: (session: AgentSession, options: CreateOptions) => Promise<void> | void;
  } = {}) {
    return createManagedEmbeddedExecutionBackend({ agentDir, sessionDir, ...options }, {
      createSession: (options = {}) => track((async () => {
        creations.push(options);
        await hooks.beforeCreate?.(options);
        const result = await createAgentSession(options);
        natives.push(result.session);
        await hooks.afterCreate?.(result.session, options);
        return result;
      })()),
    });
  }
  async function run(backend: AgentExecutionBackend, options: Partial<ExecutionRunOptions> = {}, prompt = "Initial task") {
    return track(backend.run(ctx, TYPE, prompt, {
      pi, isolated: true, ...options,
      onSessionCreated: (session) => { own(backend, session); options.onSessionCreated?.(session); },
    }));
  }
  async function restore(backend: AgentExecutionBackend, ref: PersistentSessionReference, options: ExecutionRestoreOptions = {}) {
    return own(backend, await track(backend.reattach!(ref, { ctx, ...options })));
  }
  async function fork(backend: AgentExecutionBackend, ref: PersistentSessionReference, options: ExecutionRestoreOptions = {}) {
    return own(backend, await track(backend.fork!(ref, { ctx, ...options })));
  }
  function script(...steps: FauxResponseStep[]) {
    const start = faux.state.callCount;
    const requests: TranscriptContext[] = [];
    const aborted: boolean[] = [];
    faux.setResponses(steps.map((step): FauxResponseStep => (context, options, state, model) => {
      requests.push(context);
      aborted.push(options?.signal?.aborted === true);
      return typeof step === "function" ? step(context, options, state, model) : step;
    }));
    return { requests, calls: () => faux.state.callCount - start, realCalls: () => aborted.filter((value) => !value).length };
  }
  function gate() {
    const entered = deferred<AbortSignal | undefined>();
    const release = deferred<void>();
    releases.push(() => release.resolve());
    const step: FauxResponseStep = async (_context, options) => {
      entered.resolve(options?.signal);
      await release.promise;
      return text("late provider completion must not escape cancellation");
    };
    return {
      step, release: () => release.resolve(),
      wait: (running: Promise<unknown>) => Promise.race([
        entered.promise,
        running.then(() => { throw new Error("Invocation settled before provider gate"); }),
      ]),
    };
  }
  async function seed(backend: AgentExecutionBackend, structuredOutput?: CompiledSchema) {
    script(...(structuredOutput ? [structured({ answer: "seed" })] : []), text("seed response"));
    const result = await run(backend, { structuredOutput });
    expect(result.responseText).toBe("seed response");
    expect(result.aborted).not.toBe(true);
    expect(result.failure).toBeUndefined();
    return result.session;
  }

  beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousMax = getDefaultMaxTurns();
    previousGrace = getGraceTurns();
    // macOS temp directories can have /var -> /private/var aliases; references
    // compare canonical paths, not machine-specific temporary path spelling.
    root = realpathSync(mkdtempSync(join(tmpdir(), "embedded-managed-")));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    sessionDir = join(root, "sessions");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(cwd, "fixture.txt"), "Offline tool result.\n");
    setDefaultMaxTurns(undefined);
    setGraceTurns(5);
    configure();
    faux = registerFauxProvider({
      provider: TYPE, models: [{ id: "offline", contextWindow: 200_000, reasoning: false }],
      tokenSize: { min: 8, max: 8 },
    });
    runtime = fauxModelBackend(faux.getModel());
    runtime.modelRegistry.runtime = runtime.modelRuntime;
    ctx = {
      cwd, model: faux.getModel(), modelRegistry: runtime.modelRegistry,
      sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "Offline parent",
    } as unknown as ExtensionContext;
    pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
    pending = []; releases = []; handles = []; natives = []; creations = [];
  });
  afterEach(async () => {
    for (const release of releases) release();
    const shutdowns = handles.map(({ backend, session }) => backend.shutdown(session));
    await Promise.allSettled([...pending, ...shutdowns]);
    for (const native of natives) { await native.abort(); native.dispose(); }
    faux.unregister();
    registerAgents(new Map());
    setDefaultMaxTurns(previousMax);
    setGraceTurns(previousGrace);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("reattaches immediately with the same persisted identity, history and read-only live view", async () => {
    const first = factory();
    const session = await seed(first);
    const native = natives[0];
    const ref = reference(session);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.reference)).toBe(true);
    for (const control of ["prompt", "steer", "abort", "dispose", "agent", "sessionManager", "modelRuntime"]) {
      expect(session).not.toHaveProperty(control);
    }
    expect(session.messages).toBe(native.messages);
    expect(session.model).toEqual({ provider: faux.getModel().provider, id: "offline", name: "offline" });
    expect(session.getSessionStats()).toEqual(native.getSessionStats());
    expect(existsSync(lockPath(ref))).toBe(true);
    const history = structuredClone(session.messages);
    const raw = readFileSync(ref.sessionFile);
    await first.shutdown(session);
    expect(record(ref).state).toBe("ready");
    expect(existsSync(lockPath(ref))).toBe(false);

    const second = factory();
    const noModel = script(text("must not be consumed by reattach"));
    const restored = await restore(second, ref);
    expect(restored).not.toBe(session);
    expect(natives[1]).not.toBe(native);
    expect(restored.reference).toEqual(ref);
    expect(restored.messages).toEqual(history);
    expect(restored.messages).toBe(natives[1].messages);
    expect(restored.model).toEqual(session.model);
    expect(restored.thinkingLevel).toBe(session.thinkingLevel);
    expect(restored.getSessionStats()).toEqual(session.getSessionStats());
    expect(readFileSync(ref.sessionFile)).toEqual(raw);
    expect(noModel.calls()).toBe(0);

    const events: string[] = [];
    const unsubscribe = restored.subscribe((event) => events.push(event.type));
    script(readTurn(), text("continued with native read"));
    const resumed = await track(second.resume(restored, "Read fixture.txt"));
    expect(resumed.text).toBe("continued with native read");
    expect(restored.messages.some((message) => message.role === "toolResult"
      && messageText(message.content).includes("Offline tool result."))).toBe(true);
    expect(events.filter((event) => event === "turn_end")).toHaveLength(2);
    unsubscribe();
    const previousEvents = events.length;
    script(text("last response"));
    await track(second.resume(restored, "One more task"));
    expect(events).toHaveLength(previousEvents);
  });

  it.each(["same-factory idle", "other-factory released"] as const)(
    "forks raw active history into a new identity without changing the %s source", async (mode) => {
      const first = factory();
      script(text("raw response"));
      const source = (await run(first, { onTurnEnd: () => {
        // Real native entries are added while the managed invocation owns the
        // writer. Include data that a messages-only fork would silently lose.
        const manager = natives[0].sessionManager;
        const user = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
        const leaf = manager.getLeafId()!;
        manager.appendCustomEntry("abandoned-branch", { discarded: true });
        manager.branch(leaf);
        manager.appendCompaction("saved summary", user.id, 12);
        manager.appendContextEdit(user.id, { content: "projected task" });
        manager.appendCustomEntry("opaque-offline", { nested: [1, "kept"] });
      } })).session;
      const ref = reference(source);
      const branch = structuredClone(natives[0].sessionManager.getBranch());
      const projection = natives[0].sessionManager.buildSessionContext().messages;
      if (mode === "other-factory released") await first.shutdown(source);
      const before = readFileSync(ref.sessionFile);
      const beforeRecord = readFileSync(recordPath(ref));
      const target = mode === "same-factory idle" ? first : factory();
      const noModel = script(text("must wait for explicit fork invocation"));
      const child = await fork(target, ref);
      const childRef = reference(child);
      expect(childRef.sessionId).not.toBe(ref.sessionId);
      expect(childRef.sessionFile).not.toBe(ref.sessionFile);
      expect(rows(childRef)[0].parentSession).toBe(ref.sessionFile);
      expect(rows(childRef).slice(1)).toEqual(branch);
      expect(child.messages).toEqual(projection);
      expect(rows(childRef).some((entry) => entry.customType === "abandoned-branch")).toBe(false);
      expect(record(childRef).policy).toEqual(record(ref).policy);
      expect(noModel.calls()).toBe(0);
      script(text("fork-only continuation"));
      await track(target.resume(child, "Continue only this fork"));
      expect(readFileSync(ref.sessionFile)).toEqual(before);
      expect(readFileSync(recordPath(ref))).toEqual(beforeRecord);
      expect(readFileSync(childRef.sessionFile, "utf8")).toContain("fork-only continuation");
    },
  );

  it("rejects foreign/closed handles and busy source forks without dispatching another child", async () => {
    const first = factory();
    const second = factory();
    const session = await seed(first);
    const ref = reference(session);
    const noModel = script(text("not requested"));
    await expect(second.resume(session, "foreign")).rejects.toThrow(i18n.t("backend.invalidSession"));
    await expect(second.steer(session, "foreign")).rejects.toThrow(i18n.t("backend.invalidSession"));
    await expect(second.shutdown(session)).rejects.toThrow(i18n.t("backend.invalidSession"));
    await expect(first.steer(session, "idle")).rejects.toThrow(i18n.t("invocation.notRunning"));
    await expect(first.reattach!(ref, { ctx })).rejects.toThrow(i18n.t("sessionStore.alreadyOwned"));
    for (const operation of [second.reattach!, second.fork!]) {
      await expect(operation(ref, { ctx })).rejects.toThrow(i18n.t("sessionStore.busy"));
    }
    expect(noModel.calls()).toBe(0);
    const blocked = gate();
    const inFlight = script(blocked.step);
    const running = track(first.resume(session, "busy task"));
    await blocked.wait(running);
    await expect(first.resume(session, "second prompt")).rejects.toThrow(i18n.t("invocation.busy"));
    await expect(first.fork!(ref, { ctx })).rejects.toThrow(i18n.t("invocation.busy"));
    expect(creations).toHaveLength(1);
    expect(inFlight.calls()).toBe(1);
    blocked.release();
    await running;
    const shutdown = first.shutdown(session);
    expect(first.shutdown(session)).toBe(shutdown);
    await expect(first.fork!(ref, { ctx })).rejects.toThrow(i18n.t("backend.closedSession"));
    await expect(first.resume(session, "closed")).rejects.toThrow(i18n.t("backend.closedSession"));
    await expect(first.steer(session, "closed")).rejects.toThrow(i18n.t("backend.closedSession"));
    await shutdown;
    await first.shutdown(undefined);
  });

  it.each(["explicit", "agent", "global"] as const)(
    "restores the resolved %s turn/grace policy, schema, builtin tools, prompt and effective thinking", async (source) => {
      setDefaultMaxTurns(source === "global" ? 3 : 8);
      setGraceTurns(1);
      configure({ maxTurns: source === "agent" ? 3 : undefined, thinking: "high" });
      const first = factory();
      script(structured({ answer: "seed" }), text("seed prose"));
      const original = (await run(first, { structuredOutput: ANSWER, ...(source === "explicit" ? { maxTurns: 3 } : {}) })).session;
      const ref = reference(original);
      const prompt = natives[0].systemPrompt;
      const saved = record(ref).policy;
      expect(saved).toMatchObject({ maxTurns: 3, graceTurns: 1, thinkingLevel: "off", tools: ["read"], structuredSchema: ANSWER.schema });
      expect(original.thinkingLevel).toBe("off"); // requested high is clamped on this non-reasoning model
      config.maxTurns = 9;
      config.builtinToolNames = ["write"];
      configure({ builtinToolNames: ["write"], systemPrompt: "REPLACEMENT POLICY MUST NOT LEAK", maxTurns: 9, thinking: "low" });
      setDefaultMaxTurns(9);
      setGraceTurns(8);
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "high", defaultTools: ["write"] }));
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "low", defaultTools: [] }));
      await first.shutdown(original);
      const second = factory();
      const restored = await restore(second, ref, { structuredOutput: ANSWER });
      const child = await fork(second, ref, { structuredOutput: ANSWER });
      for (const session of [restored, child]) {
        const native = natives.filter((item) => item.sessionId === session.reference.sessionId).at(-1)!;
        expect(native.systemPrompt).toBe(prompt);
        expect(native.getActiveToolNames().sort()).toEqual(["StructuredOutput", "read"]);
        expect(session.thinkingLevel).toBe("off");
        expect(record(reference(session)).policy).toEqual(saved);
        for (let invocation = 0; invocation < 2; invocation++) {
          const calls = script(...Array.from({ length: 10 }, readTurn));
          const result = await track(second.resume(session, `bounded invocation ${invocation}`));
          expect(result.aborted).toBe(true);
          expect(result.steered).toBe(true);
          expect(result.failure).toBe(i18n.t("terminalPolicy.turnLimit"));
          expect(calls.realCalls()).toBe(4); // saved 3 + 1, never current 9 + 8
          expect(result.structuredJson).toBeUndefined();
          expect(result.structuredRetried).not.toBe(true);
          expect(getCurrentTools(calls.requests[0].messages).map((tool) => tool.name).sort()).toEqual(["StructuredOutput", "read"]);
          expect(getCurrentTools(calls.requests[0].messages).find((tool) => tool.name === "StructuredOutput")?.parameters).toEqual(ANSWER.schema);
          const system = calls.requests[0].messages.filter((message) => message.role === "system").map(getSystemMessageText).join("\n");
          expect(system).toContain("Keep the original managed policy.");
          expect(system).not.toContain("REPLACEMENT POLICY MUST NOT LEAK");
        }
        script(structured({ answer: "fresh capture" }), text("short recovery"));
        const recovery = await track(second.resume(session, "short invocation"));
        expect(recovery).toMatchObject({ text: "short recovery", structuredJson: '{"answer":"fresh capture"}', aborted: false, steered: false });
      }
    },
  );

  it("keeps explicit zero unlimited after reattach rather than adopting changed defaults", async () => {
    setDefaultMaxTurns(1);
    setGraceTurns(1);
    configure({ maxTurns: 1 });
    const first = factory();
    script(text("unlimited seed"));
    const session = (await run(first, { maxTurns: 0 })).session;
    await first.shutdown(session);
    const second = factory();
    const restored = await restore(second, reference(session));
    const calls = script(...Array.from({ length: 5 }, readTurn), text("unlimited finish"));
    const result = await track(second.resume(restored, "take five tool turns"));
    expect(result).toMatchObject({ text: "unlimited finish", aborted: false, steered: false });
    expect(calls.calls()).toBe(6);
    expect(record(reference(restored)).policy.maxTurns).toBeUndefined();
  });

  it("uses in-memory native defaults with warming off instead of loading or rewriting user settings", async () => {
    const settings = JSON.stringify({
      retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "idle",
      defaultTools: ["write"], defaultThinkingLevel: "high", defaultProvider: "not-the-faux-provider",
    });
    for (const path of [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")]) writeFileSync(path, settings);
    const backend = factory();
    const session = await seed(backend);
    const nativeSettings = creations[0].settingsManager!;
    expect(nativeSettings.getRetryEnabled()).toBe(true);
    expect(nativeSettings.getCompactionEnabled()).toBe(true);
    expect(nativeSettings.getCacheWarmingMode()).toBe("off");
    expect(nativeSettings.getDefaultTools()).toBeUndefined();
    expect(natives[0].getActiveToolNames()).toEqual(["read"]);
    await backend.shutdown(session);
    for (const path of [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")]) expect(readFileSync(path, "utf8")).toBe(settings);
  });

  it("resets structured capture, retry allowance, callbacks and provider failures for each restored invocation", async () => {
    const first = factory();
    const original = await seed(first, ANSWER);
    await first.shutdown(original);
    const backend = factory();
    const session = await restore(backend, reference(original), { structuredOutput: ANSWER });
    const activity: string[] = [];
    const usage: unknown[] = [];
    const retried = script(text("forgot tool"), structured({ answer: "retry value" }), text("retry prose"));
    const result = await track(backend.resume(session, "retry this task", {
      onToolActivity: (event) => activity.push(`${event.type}:${event.toolName}`), onAssistantUsage: (value) => usage.push(value),
    }));
    expect(result).toMatchObject({ text: "retry prose", structuredJson: '{"answer":"retry value"}', structuredRetried: true });
    expect(retried.calls()).toBe(3);
    expect(activity).toEqual(["start:StructuredOutput", "end:StructuredOutput"]);
    expect(usage).toHaveLength(3);
    script(structured({ answer: "clean value" }), text("clean prose"));
    const clean = await track(backend.resume(session, "clean invocation"));
    expect(clean.structuredJson).toBe('{"answer":"clean value"}');
    expect(clean.structuredRetried).not.toBe(true);
    expect(activity).toHaveLength(2);
    expect(usage).toHaveLength(3);

    script(structured({ wrong: "first" }), text("bad first"), structured({ wrong: "second" }), text("bad retry"));
    const invalid = await track(backend.resume(session, "invalid output"));
    expect(invalid.structuredJson).toBeUndefined();
    expect(invalid.structuredRetried).toBe(true);
    expect(invalid.failure).toContain("StructuredOutput");
    const missing = script(text("missing"), text("still missing"));
    const noCall = await track(backend.resume(session, "missing output"));
    expect(noCall.failure).toBe(structuredFailure(createStructuredCapture()));
    expect(noCall.structuredJson).toBeUndefined();
    expect(missing.calls()).toBe(2);

    for (const stopReason of ["error", "length", "aborted"] as const) {
      const start = session.messages.length;
      const calls = script(fauxAssistantMessage([], { stopReason, ...(stopReason === "error" ? { errorMessage: FATAL } : {}) }));
      const failed = await track(backend.resume(session, `provider ${stopReason}`));
      expect(calls.calls()).toBe(1);
      expect(failed.text).toBe("");
      expect(failed.structuredJson).toBeUndefined();
      expect(failed.structuredRetried).not.toBe(true);
      if (stopReason === "error") expect(failed.failure).toBe(FATAL);
      if (stopReason === "length") expect(failed.failure).toBe(i18n.t("invocation.outputLimit"));
      if (stopReason === "aborted") expect(failed.aborted).toBe(true);
      expect(session.messages.slice(start).filter((message) => message.role === "user")).toHaveLength(1);
      expect(record(reference(session)).state).toBe("ready");
    }
    script(structured({ answer: "recovered" }), text("recovered prose"));
    expect((await track(backend.resume(session, "recover"))).structuredJson).toBe('{"answer":"recovered"}');
  });

  it.each(["reattach", "fork"] as const)("requires the matching caller validator before %s can create a child", async (operation) => {
    const first = factory();
    const source = await seed(first, ANSWER);
    await first.shutdown(source);
    const ref = reference(source);
    const backend = factory();
    const calls = script(text("not requested"));
    for (const options of [{ ctx }, { ctx, structuredOutput: { schema: ANSWER.schema } as CompiledSchema }]) {
      await expect(backend[operation]!(ref, options)).rejects.toThrow(i18n.t("sessionStore.validatorRequired"));
    }
    await expect(backend[operation]!(ref, { ctx, structuredOutput: COUNT })).rejects.toThrow(i18n.t("sessionStore.schemaMismatch"));
    expect(creations).toHaveLength(1);
    expect(calls.calls()).toBe(0);
    expect(existsSync(lockPath(ref))).toBe(false);
    // Runtime-only caller validation is not replaced by the serializable schema.
    let validations = 0;
    const validator: CompiledSchema = { schema: ANSWER.schema, check: (value) => {
      validations++;
      return (value as { answer?: string }).answer === "caller approved" || "offline caller rejected this answer";
    } };
    const session = own(backend, await track(backend[operation]!(ref, { ctx, structuredOutput: validator })));
    script(structured({ answer: "not approved" }), text("first prose"), structured({ answer: "caller approved" }), text("approved prose"));
    const result = await track(backend.resume(session, "use rebound validator"));
    expect(validations).toBe(2);
    expect(result.structuredRetried).toBe(true);
    expect(result.structuredJson).toBe('{"answer":"caller approved"}');
  });

  it.each(["reattach", "fork"] as const)("rejects missing runtime and changed model fingerprints before %s SDK construction", async (operation) => {
    const first = factory();
    const source = await seed(first);
    await first.shutdown(source);
    const ref = reference(source);
    const backend = factory();
    const before = readFileSync(ref.sessionFile);
    const filesBefore = readdirSync(sessionDir).sort();
    const calls = script(text("not requested"));
    for (const badCtx of [undefined, { ...ctx, modelRegistry: {} } as ExtensionContext]) {
      await expect(backend[operation]!(ref, { ctx: badCtx })).rejects.toThrow(i18n.t("managedEmbedded.contextRequired"));
    }
    // Same provider/id is not enough: changing the resolved transport is unsafe.
    for (const change of [{ baseUrl: "https://offline.invalid/changed" }, { api: "different-offline-api" }, { id: "missing-model" }]) {
      const changed = { ...faux.getModel(), ...change };
      const changedRuntime = fauxModelBackend(changed);
      changedRuntime.modelRegistry.runtime = changedRuntime.modelRuntime;
      const badCtx = { ...ctx, model: changed, modelRegistry: changedRuntime.modelRegistry } as ExtensionContext;
      await expect(backend[operation]!(ref, { ctx: badCtx })).rejects.toThrow(i18n.t("managedEmbedded.modelMismatch"));
    }
    expect(creations).toHaveLength(1);
    expect(calls.calls()).toBe(0);
    expect(readFileSync(ref.sessionFile)).toEqual(before);
    expect(readdirSync(sessionDir).sort()).toEqual(filesBefore);
    expect(existsSync(lockPath(ref))).toBe(false);
    own(backend, await track(backend[operation]!(ref, { ctx })));
  });

  it.each(["isolated", "inheritContext", "resumeSessionFile", "memory", "persistSession"] as const)(
    "rejects unsupported %s before creating any native child", async (feature) => {
      const backend = factory();
      const calls = script(text("not requested"));
      const options: Partial<ExecutionRunOptions> = {};
      if (feature === "isolated") options.isolated = false;
      if (feature === "inheritContext") options.inheritContext = true;
      if (feature === "resumeSessionFile") options.resumeSessionFile = join(root, "raw.jsonl");
      if (feature === "memory") configure({ memory: "project" });
      if (feature === "persistSession") configure({ persistSession: false });
      await expect(run(backend, options)).rejects.toThrow(i18n.t("managedEmbedded.unsupported", {
        feature: feature === "isolated" ? "isolated=false" : feature === "persistSession" ? "persistSession=false" : feature,
      }));
      expect(creations).toHaveLength(0);
      expect(calls.calls()).toBe(0);
      expect(existsSync(sessionDir)).toBe(false);
      expect(createEmbeddedExecutionBackend().reattach).toBeUndefined();
      expect(createEmbeddedExecutionBackend().fork).toBeUndefined();
    },
  );

  it.each([false, true])("checkpoints a settled canceled invocation safely and can resume (during retry: %s)", async (retry) => {
    const backend = factory();
    const session = await seed(backend, ANSWER);
    const ref = reference(session);
    const blocked = gate();
    const calls = script(...(retry ? [text("retry needed")] : []), blocked.step);
    const controller = new AbortController();
    const running = track(backend.resume(session, "cancel active invocation", { signal: controller.signal }));
    const providerSignal = await blocked.wait(running);
    controller.abort();
    expect(providerSignal?.aborted).toBe(true);
    expect(record(ref).state).toBe("running");
    await expect(backend.resume(session, "must wait for cancellation settlement")).rejects.toThrow(i18n.t("invocation.busy"));
    blocked.release();
    const aborted = await running;
    expect(aborted.aborted).toBe(true);
    expect(aborted.structuredJson).toBeUndefined();
    expect(Boolean(aborted.structuredRetried)).toBe(retry);
    expect(aborted.text).not.toContain("seed");
    expect(aborted.text).not.toContain("late provider completion");
    expect(calls.calls()).toBe(retry ? 2 : 1);
    expect(record(ref).state).toBe("ready");
    expect(existsSync(lockPath(ref))).toBe(true);
    script(structured({ answer: "after cancellation" }), text("clean recovery"));
    const resumed = await track(backend.resume(session, "after cancellation"));
    expect(resumed).toMatchObject({ text: "clean recovery", structuredJson: '{"answer":"after cancellation"}', aborted: false });
    expect(resumed.structuredRetried).not.toBe(true);
    await backend.shutdown(session);
    await restore(factory(), ref, { structuredOutput: ANSWER });
  });

  it("skips pre-aborted fresh and owned invocations without changing the checkpoint or capture", async () => {
    const backend = factory();
    const controller = new AbortController();
    controller.abort(new Error("offline pre-cancel"));
    const calls = script(text("not requested"));
    await expect(run(backend, { signal: controller.signal })).rejects.toThrow("offline pre-cancel");
    expect(creations).toHaveLength(0);
    expect(calls.calls()).toBe(0);
    const session = await seed(backend, ANSWER);
    const ref = reference(session);
    const before = readFileSync(ref.sessionFile);
    const checkpoint = readFileSync(recordPath(ref));
    const noModel = script(text("not requested"));
    const result = await track(backend.resume(session, "pre-cancel resume", { signal: controller.signal }));
    expect(result).toMatchObject({ text: "", aborted: true });
    expect(result.structuredJson).toBeUndefined();
    expect(result.structuredRetried).not.toBe(true);
    expect(noModel.calls()).toBe(0);
    expect(readFileSync(ref.sessionFile)).toEqual(before);
    expect(readFileSync(recordPath(ref))).toEqual(checkpoint);
  });

  it("delivers steering literally to the model and never queues it for the next invocation", async () => {
    const backend = factory();
    const session = await seed(backend);
    const native = natives[0];
    let interactiveSteers = 0;
    // Observe, but do not replace, SDK behavior. Native steer performs input /
    // template expansion; the managed path must use literal custom messages.
    const steer = native.steer.bind(native);
    native.steer = async (...args) => { interactiveSteers++; return steer(...args); };
    const deliveries: Array<Parameters<AgentSession["sendCustomMessage"]>> = [];
    const sendCustomMessage = native.sendCustomMessage.bind(native);
    native.sendCustomMessage = async (...args) => { deliveries.push(args); return sendCustomMessage(...args); };
    const blocked = gate();
    const literal = "/skill:not-an-expansion {{literal}} @fixture.txt";
    const calls = script(blocked.step, text("acknowledged literal steer"));
    const running = track(backend.resume(session, "wait for steering"));
    await blocked.wait(running);
    await backend.steer(session, literal);
    expect(interactiveSteers).toBe(0);
    expect(deliveries).toEqual([[{ customType: "pi-subagents-steer", content: literal, display: true }, { deliverAs: "steer" }]]);
    blocked.release();
    expect((await running).text).toBe("acknowledged literal steer");
    expect(calls.calls()).toBe(2);
    expect(calls.requests[1].messages.filter((message) => message.role === "user").map((message) => messageText(message.content))).toContain(literal);
    expect(session.messages.filter((message) => message.role === "custom" && messageText(message.content) === literal)).toHaveLength(1);
    const start = session.messages.length;
    const clean = script(text("next invocation only"));
    await track(backend.resume(session, "next invocation"));
    expect(clean.calls()).toBe(1);
    expect(session.messages.slice(start).map((message) => messageText(message.content))).not.toContain(literal);
    expect(clean.requests[0].messages.filter((message) => message.role === "user" && messageText(message.content) === literal)).toHaveLength(1);
  });

  it("does not carry an undelivered steer across cancellation into the next invocation", async () => {
    const backend = factory();
    const session = await seed(backend);
    const blocked = gate();
    const controller = new AbortController();
    script(blocked.step);
    const running = track(backend.resume(session, "cancel before queued steering is delivered", { signal: controller.signal }));
    await blocked.wait(running);
    const literal = "/skill:cancelled-steer must not run in a later invocation";
    await backend.steer(session, literal);
    controller.abort();
    blocked.release();
    expect((await running).aborted).toBe(true);
    const start = session.messages.length;
    const calls = script(text("independent recovery"));
    const recovered = await track(backend.resume(session, "new invocation after canceled steer"));
    expect(recovered).toMatchObject({ text: "independent recovery", aborted: false });
    expect(calls.calls()).toBe(1);
    expect(session.messages.slice(start).map((message) => messageText(message.content))).not.toContain(literal);
    expect(calls.requests[0].messages.filter((message) => message.role === "user").map((message) => messageText(message.content))).not.toContain(literal);
  });

  it.each(["tools", "thinking", "native history", "disk history", "policy record"] as const)(
    "quarantines %s tampering before another invocation and retains its lease", async (kind) => {
      const backend = factory();
      const session = await seed(backend);
      const ref = reference(session);
      const native = natives[0];
      if (kind === "tools") native.setActiveToolsByName([]);
      if (kind === "thinking") native.sessionManager.appendThinkingLevelChange("high");
      if (kind === "native history") native.sessionManager.appendCustomEntry("unexpected-writer", { unsafe: true });
      if (kind === "disk history") {
        const entries = rows(ref);
        appendFileSync(ref.sessionFile, JSON.stringify({
          type: "custom", customType: "external-writer", data: {}, id: "external01", parentId: entries.at(-1).id, timestamp: new Date().toISOString(),
        }) + "\n");
      }
      if (kind === "policy record") {
        const changed = record(ref);
        changed.policy.systemPrompt = "tampered policy";
        writeFileSync(recordPath(ref), JSON.stringify(changed) + "\n");
      }
      const calls = script(text("not requested"));
      await expect(backend.resume(session, "unsafe resume")).rejects.toThrow(i18n.t(
        kind === "tools" ? "managedEmbedded.policyMismatch" : kind === "policy record" ? "sessionStore.invalidRecord" : "sessionStore.invalidFile",
      ));
      await expect(backend.resume(session, "still unsafe")).rejects.toThrow(i18n.t("managedEmbedded.quarantined"));
      await backend.shutdown(session);
      if (kind !== "policy record") expect(record(ref).state).toBe("quarantined");
      expect(existsSync(lockPath(ref))).toBe(true);
      await expect(factory().reattach!(ref, { ctx })).rejects.toThrow(i18n.t("sessionStore.busy"));
      expect(calls.calls()).toBe(0);
      expect(creations).toHaveLength(1);
    },
  );

  it("never releases quarantine after a shutdown timeout, including late native completion", async () => {
    const backend = factory({ shutdownTimeoutMs: 25 });
    const session = await seed(backend);
    const ref = reference(session);
    const blocked = gate();
    script(blocked.step);
    const running = track(backend.resume(session, "request that outlives shutdown"));
    const providerSignal = await blocked.wait(running);
    const shutdown = track(backend.shutdown(session));
    expect(backend.shutdown(session)).toBe(shutdown);
    await expect(shutdown).rejects.toThrow(i18n.t("managedEmbedded.retirementTimeout"));
    expect(providerSignal?.aborted).toBe(true);
    expect(record(ref).state).toBe("quarantined");
    expect(existsSync(lockPath(ref))).toBe(true);
    blocked.release();
    await expect(running).rejects.toThrow(i18n.t("managedEmbedded.quarantined"));
    await natives[0].waitForIdle();
    expect(record(ref).state).toBe("quarantined");
    expect(existsSync(lockPath(ref))).toBe(true);
    await expect(factory().reattach!(ref, { ctx })).rejects.toThrow(i18n.t("sessionStore.busy"));
    await expect(backend.resume(session, "late completion cannot reopen handle")).rejects.toThrow(i18n.t("backend.closedSession"));
  });

  it.each(["before native construction", "after native construction"] as const)(
    "cancels startup %s before createSession resolves and retires the late session with its lease retained", async (phase) => {
    const entered = deferred<PersistentSessionReference<"embedded">>();
    const release = deferred<void>();
    const disposed = deferred<void>();
    releases.push(() => release.resolve());
    let disposals = 0;
    const backend = factory({}, {
      beforeCreate: async (options) => {
        if (phase !== "before native construction") return;
        entered.resolve({ backend: "embedded", sessionId: options.sessionManager!.getSessionId(), sessionFile: options.sessionManager!.getSessionFile()! });
        await release.promise;
      },
      afterCreate: async (native) => {
        const dispose = native.dispose.bind(native);
        native.dispose = () => { disposals++; dispose(); disposed.resolve(); };
        if (phase !== "after native construction") return;
        entered.resolve({ backend: "embedded", sessionId: native.sessionId, sessionFile: native.sessionFile! });
        await release.promise;
      },
    });
    const controller = new AbortController();
    const calls = script(text("startup must not prompt"));
    const running = track(run(backend, { signal: controller.signal }));
    const ref = await Promise.race([entered.promise, running.then(() => { throw new Error("Startup unexpectedly settled"); })]);
    expect(natives).toHaveLength(phase === "before native construction" ? 0 : 1);
    controller.abort(new Error("cancel pending SDK create"));
    await expect(running).rejects.toThrow("cancel pending SDK create");
    expect(disposals).toBe(0);
    expect(record(ref).state).toBe("quarantined");
    expect(existsSync(lockPath(ref))).toBe(true);
    expect(handles).toHaveLength(0);
    release.resolve();
    await disposed.promise;
    expect(disposals).toBe(1);
    expect(natives[0].isIdle).toBe(true);
    expect(record(ref).state).toBe("quarantined");
    expect(existsSync(lockPath(ref))).toBe(true);
    await expect(factory().reattach!(ref, { ctx })).rejects.toThrow(i18n.t("sessionStore.busy"));
    expect(calls.calls()).toBe(0);
  });

  it("handles shutdown reentrantly from the first handle callback without a child request or a lost lease", async () => {
    const backend = factory();
    const calls = script(text("must not prompt"));
    let shutdown: Promise<void> | undefined;
    const result = await run(backend, { onSessionCreated: (session) => { shutdown = track(backend.shutdown(session)); } });
    expect(result.aborted).toBe(true);
    expect(shutdown).toBeDefined();
    await shutdown;
    const ref = reference(result.session);
    expect(calls.calls()).toBe(0);
    expect(record(ref).state).toBe("ready");
    expect(existsSync(lockPath(ref))).toBe(false);
    const restored = await restore(factory(), ref);
    expect(restored.reference).toEqual(ref);
  });
});
