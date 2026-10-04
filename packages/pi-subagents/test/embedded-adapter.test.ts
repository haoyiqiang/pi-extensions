import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createEmbeddedExecutionBackend,
  type EmbeddedExecutionBackendPorts,
} from "../src/backends/embedded-adapter.js";
import type { ExecutionSession } from "../src/backends/session.js";
import { i18n } from "../src/i18n.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type RunPort = NonNullable<EmbeddedExecutionBackendPorts["runAgent"]>;
type ResumePort = NonNullable<EmbeddedExecutionBackendPorts["resumeAgent"]>;
type SteerPort = NonNullable<EmbeddedExecutionBackendPorts["steerEmbeddedSession"]>;
type ShutdownPort = NonNullable<EmbeddedExecutionBackendPorts["shutdownEmbeddedSession"]>;

interface NativeHarness {
  native: AgentSession;
  value: Record<string, any>;
  callbacks: Array<(event: AgentSessionEvent) => void>;
  unsubscribers: Array<ReturnType<typeof vi.fn>>;
  emit(event: AgentSessionEvent): void;
  emitLate(index: number, event: AgentSessionEvent): void;
}

function nativeSession(overrides: Record<string, unknown> = {}): NativeHarness {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const callbacks: Array<(event: AgentSessionEvent) => void> = [];
  const unsubscribers: Array<ReturnType<typeof vi.fn>> = [];
  const value: Record<string, any> = {
    sessionId: "sdk-session",
    sessionFile: undefined,
    sessionManager: {
      getSessionId: vi.fn(() => "manager-session"),
      getSessionFile: vi.fn(() => undefined),
    },
    messages: [],
    model: {
      provider: "provider-a",
      id: "model-a",
      name: "Model A",
      apiKey: "must-not-leak",
      baseUrl: "https://credentials.invalid",
    },
    thinkingLevel: "high",
    getSessionStats: vi.fn(() => ({
      tokens: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, total: 10 },
      contextUsage: { percent: 25 },
      cost: 99,
    })),
    subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
      callbacks.push(listener);
      listeners.add(listener);
      let active = true;
      const unsubscribe = vi.fn(() => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      });
      unsubscribers.push(unsubscribe);
      return unsubscribe;
    }),
    steer: vi.fn(async () => {}),
    dispose: vi.fn(),
    extensionRunner: {
      hasHandlers: vi.fn(() => false),
      emit: vi.fn(async () => {}),
    },
    ...overrides,
  };
  return {
    native: value as AgentSession,
    value,
    callbacks,
    unsubscribers,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    emitLate(index, event) {
      callbacks[index]?.(event);
    },
  };
}

function result(session: AgentSession) {
  return {
    responseText: "done",
    session,
    aborted: false,
    steered: false,
  };
}

function backendReturning(
  harness: NativeHarness,
  overrides: EmbeddedExecutionBackendPorts = {},
) {
  const runAgent = vi.fn<RunPort>((_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(harness.native);
    return Promise.resolve(result(harness.native));
  });
  return {
    backend: createEmbeddedExecutionBackend({ runAgent, ...overrides }),
    runAgent,
  };
}

const ctx = {} as ExtensionContext;
const pi = {} as Parameters<RunPort>[3]["pi"];

async function open(
  backend: ReturnType<typeof createEmbeddedExecutionBackend>,
  prompt = "prompt",
  onSessionCreated?: (session: ExecutionSession) => void,
): Promise<ExecutionSession> {
  return (await backend.run(ctx, "general-purpose", prompt, { pi, onSessionCreated })).session;
}

describe("embedded execution backend adapter", () => {
  it("preserves synchronous startup failures instead of acknowledging a failed launch", () => {
    const error = new Error("failed before session creation");
    const backend = createEmbeddedExecutionBackend({ runAgent: () => { throw error; } });
    expect(() => backend.run(ctx, "general-purpose", "prompt", { pi })).toThrow(error);
  });

  it("rejects a malformed runner result without inventing a session handle", async () => {
    const backend = createEmbeddedExecutionBackend({
      runAgent: async () => ({ responseText: "missing session", aborted: false, steered: false } as any),
    });
    await expect(backend.run(ctx, "general-purpose", "prompt", { pi }))
      .rejects.toThrow(i18n.t("backend.missingSession"));
  });

  it("creates stable frozen handles and references for persisted and in-memory sessions without native leaks", async () => {
    const persisted = nativeSession({
      sessionId: "sdk-persisted",
      sessionFile: "/sessions/persisted.jsonl",
      sessionManager: {
        getSessionId: vi.fn(() => "manager-ignored"),
        getSessionFile: vi.fn(() => "/sessions/manager-ignored.jsonl"),
      },
    });
    const memory = nativeSession({
      sessionId: undefined,
      sessionFile: null,
      sessionManager: {
        getSessionId: vi.fn(() => "manager-memory"),
        getSessionFile: vi.fn(() => null),
      },
    });
    const partial = nativeSession({
      sessionId: undefined,
      sessionFile: undefined,
      sessionManager: undefined,
      messages: undefined,
      model: undefined,
      thinkingLevel: undefined,
      getSessionStats: undefined,
      subscribe: undefined,
    });
    const sessions = new Map([
      ["persisted", persisted.native],
      ["memory", memory.native],
      ["partial", partial.native],
    ]);
    const runAgent = vi.fn<RunPort>((_ctx, _type, prompt, options) => {
      const native = sessions.get(prompt)!;
      options.onSessionCreated?.(native);
      return Promise.resolve(result(native));
    });
    const backend = createEmbeddedExecutionBackend({ runAgent });

    let created: ExecutionSession | undefined;
    const persistedHandle = await open(backend, "persisted", (session) => { created = session; });
    expect(created).toBe(persistedHandle);
    expect(Object.isFrozen(persistedHandle)).toBe(true);
    expect(Object.isFrozen(persistedHandle.reference)).toBe(true);
    expect(persistedHandle.reference).toEqual({
      backend: "embedded",
      sessionId: "sdk-persisted",
      sessionFile: "/sessions/persisted.jsonl",
    });

    expect(persistedHandle.model).toEqual({
      provider: "provider-a",
      id: "model-a",
      name: "Model A",
    });
    expect(Object.keys(persistedHandle.model!)).toEqual(["provider", "id", "name"]);
    expect(persistedHandle.model).not.toHaveProperty("apiKey");
    expect(persistedHandle.model).not.toHaveProperty("baseUrl");
    for (const forbidden of [
      "steer", "abort", "dispose", "prompt", "sessionManager", "extensionRunner", "modelRuntime",
    ]) {
      expect(persistedHandle).not.toHaveProperty(forbidden);
    }

    persisted.value.model = {
      provider: "provider-b",
      id: "model-b",
      credential: "still-private",
    };
    persisted.value.thinkingLevel = "minimal";
    expect(persistedHandle.model).toEqual({ provider: "provider-b", id: "model-b" });
    expect(persistedHandle.thinkingLevel).toBe("minimal");

    const memoryHandle = await open(backend, "memory");
    expect(memoryHandle.reference).toEqual({
      backend: "embedded",
      sessionId: "manager-memory",
    });
    expect(memoryHandle.reference.sessionFile).toBeUndefined();

    const partialHandle = await open(backend, "partial");
    expect(partialHandle.reference.backend).toBe("embedded");
    expect(partialHandle.reference.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(partialHandle.reference.sessionFile).toBeUndefined();
    expect(partialHandle.messages).toEqual([]);
  });

  it("preserves transcript identities, observes compaction replacements, and forwards native stats", async () => {
    const originalBlock = { type: "text", text: "before", providerCache: { token: "opaque" } };
    const originalMessage = {
      role: "assistant",
      content: [originalBlock],
      providerMetadata: { signature: "keep" },
    };
    const originalMessages = [originalMessage];
    const stats = {
      tokens: { input: 8, output: 5, cacheWrite: 3 },
      contextUsage: { percent: 42 },
      extra: "native-field",
    };
    const harness = nativeSession({
      messages: originalMessages,
      getSessionStats: vi.fn(() => stats),
    });
    const { backend } = backendReturning(harness);
    const handle = await open(backend);

    expect(handle.messages).toBe(originalMessages);
    expect(handle.messages[0]).toBe(originalMessage);
    expect((handle.messages[0].content as readonly unknown[])[0]).toBe(originalBlock);
    expect((handle.messages[0] as any).providerMetadata).toEqual({ signature: "keep" });
    expect(handle.getSessionStats()).toBe(stats);

    const compactedMessage = { role: "assistant", content: [{ type: "text", text: "after" }] };
    const compactedMessages = [compactedMessage];
    harness.value.messages = compactedMessages;
    expect(handle.messages).toBe(compactedMessages);
    expect(handle.messages[0]).toBe(compactedMessage);

    const partial = nativeSession({
      messages: undefined,
      getSessionStats: undefined,
    });
    const partialHandle = await open(backendReturning(partial).backend);
    expect(partialHandle.messages).toEqual([]);
    expect(partialHandle.getSessionStats()).toEqual({
      tokens: { input: 0, output: 0, cacheWrite: 0 },
      contextUsage: { percent: null },
    });
  });

  it("narrows native events and makes unsubscribe idempotent with late callback suppression", async () => {
    const harness = nativeSession();
    const { backend } = backendReturning(harness);
    const handle = await open(backend);
    const observed: unknown[] = [];
    const unsubscribe = handle.subscribe((event) => observed.push(event));

    harness.emit({ type: "turn_end" } as AgentSessionEvent);
    harness.emit({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
    harness.emit({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: { tokensBefore: 100 },
    } as AgentSessionEvent);
    harness.emit({
      type: "compaction_end",
      reason: "overflow",
      aborted: true,
      willRetry: false,
      result: undefined,
    } as AgentSessionEvent);
    harness.emit({ type: "agent_settled" } as AgentSessionEvent);

    expect(observed).toEqual([
      { type: "turn_end" },
      { type: "compaction_start" },
      { type: "compaction_end", aborted: false, result: true },
      { type: "compaction_end", aborted: true, result: false },
      { type: "changed" },
    ]);

    unsubscribe();
    unsubscribe();
    expect(harness.unsubscribers[0]).toHaveBeenCalledOnce();
    harness.emitLate(0, { type: "turn_end" } as AgentSessionEvent);
    expect(observed).toHaveLength(5);
  });

  it("closes every observation before shutdown and suppresses callbacks delayed past disposal", async () => {
    const harness = nativeSession();
    const order: string[] = [];
    const nativeSubscribe = harness.value.subscribe;
    harness.value.subscribe = vi.fn((listener: (event: AgentSessionEvent) => void) => {
      const unsubscribe = nativeSubscribe(listener);
      return vi.fn(() => {
        order.push("unsubscribe");
        unsubscribe();
      });
    });
    const shutdownResult = deferred<void>();
    const shutdownEmbeddedSession = vi.fn<ShutdownPort>((native) => {
      expect(native).toBe(harness.native);
      order.push("shutdown");
      return shutdownResult.promise;
    });
    const { backend } = backendReturning(harness, { shutdownEmbeddedSession });
    const handle = await open(backend);
    const observed: unknown[] = [];
    handle.subscribe((event) => observed.push(event));
    handle.subscribe((event) => observed.push(event));

    const closing = backend.shutdown(handle);
    expect(order).toEqual(["unsubscribe", "unsubscribe", "shutdown"]);
    expect(backend.shutdown(handle)).toBe(closing);
    expect(shutdownEmbeddedSession).toHaveBeenCalledOnce();

    harness.emitLate(0, { type: "turn_end" } as AgentSessionEvent);
    harness.emitLate(1, { type: "compaction_start", reason: "manual" } as AgentSessionEvent);
    expect(observed).toEqual([]);

    const subscriptionsBefore = harness.value.subscribe.mock.calls.length;
    const lateUnsubscribe = handle.subscribe(() => { throw new Error("must not run"); });
    lateUnsubscribe();
    expect(harness.value.subscribe).toHaveBeenCalledTimes(subscriptionsBefore);

    shutdownResult.resolve();
    await closing;
  });

  it("retains synchronous native disposal when the default lifecycle has no shutdown handlers", async () => {
    const harness = nativeSession();
    const { backend } = backendReturning(harness);
    const handle = await open(backend);
    const unsubscribe = handle.subscribe(() => {});

    const closing = backend.shutdown(handle);
    expect(harness.unsubscribers[0]).toHaveBeenCalledOnce();
    expect(harness.value.extensionRunner.hasHandlers).toHaveBeenCalledWith("session_shutdown");
    expect(harness.value.extensionRunner.emit).not.toHaveBeenCalled();
    expect(harness.value.dispose).toHaveBeenCalledOnce();

    unsubscribe();
    await closing;
  });

  it("keeps factory ownership isolated and rejects invalid, foreign, and closed controls before native access", async () => {
    const harnessA = nativeSession({ sessionId: "A" });
    const harnessB = nativeSession({ sessionId: "B" });
    const resumeB = vi.fn<ResumePort>(async () => ({ text: "unexpected" }));
    const steerB = vi.fn<SteerPort>(async () => {});
    const shutdownB = vi.fn<ShutdownPort>(async () => {});
    const backendA = backendReturning(harnessA, {
      shutdownEmbeddedSession: vi.fn<ShutdownPort>(async () => {}),
    }).backend;
    const backendB = backendReturning(harnessB, {
      resumeAgent: resumeB,
      steerEmbeddedSession: steerB,
      shutdownEmbeddedSession: shutdownB,
    }).backend;
    const handleA = await open(backendA, "A");
    await open(backendB, "B");

    await expect(backendB.resume(handleA, "foreign")).rejects.toThrow(
      i18n.t("backend.invalidSession"),
    );
    await expect(backendB.steer(handleA, "foreign")).rejects.toThrow(
      i18n.t("backend.invalidSession"),
    );
    await expect(backendB.shutdown(handleA)).rejects.toThrow(
      i18n.t("backend.invalidSession"),
    );
    const forged = Object.freeze({}) as ExecutionSession;
    await expect(backendB.steer(forged, "forged")).rejects.toThrow(
      i18n.t("backend.invalidSession"),
    );
    expect(resumeB).not.toHaveBeenCalled();
    expect(steerB).not.toHaveBeenCalled();
    expect(shutdownB).not.toHaveBeenCalled();

    const closing = backendA.shutdown(handleA);
    expect(backendA.shutdown(handleA)).toBe(closing);
    await closing;
    await expect(backendA.resume(handleA, "closed")).rejects.toThrow(
      i18n.t("backend.closedSession"),
    );
    await expect(backendA.steer(handleA, "closed")).rejects.toThrow(
      i18n.t("backend.closedSession"),
    );
  });

  it("forwards run, resume, steer, signals, errors, and native creation timing without an extra turn", async () => {
    const harness = nativeSession();
    const runResult = deferred<ReturnType<typeof result>>();
    const resumeResult = deferred<{ text: string; failure?: string }>();
    const steerResult = deferred<void>();
    const order: string[] = [];
    const runFailure = new Error("run failed");
    const resumeFailure = new Error("resume failed");
    const steerFailure = new Error("steer failed");
    let nativeRunOptions: Parameters<RunPort>[3] | undefined;

    const runAgent = vi.fn<RunPort>((_ctx, _type, prompt, options) => {
      order.push(`raw-run:${prompt}`);
      if (prompt === "fail-run") return Promise.reject(runFailure);
      nativeRunOptions = options;
      options.onSessionCreated?.(harness.native);
      order.push("raw-return");
      return runResult.promise;
    });
    const resumeAgent = vi.fn<ResumePort>((native, prompt, options) => {
      expect(native).toBe(harness.native);
      order.push(`resume:${prompt}`);
      if (prompt === "fail-resume") return Promise.reject(resumeFailure);
      expect(options?.signal).toBe(resumeSignal.signal);
      return resumeResult.promise;
    });
    const steerEmbeddedSession = vi.fn<SteerPort>((native, message) => {
      expect(native).toBe(harness.native);
      order.push(`steer:${message}`);
      return message === "fail-steer" ? Promise.reject(steerFailure) : steerResult.promise;
    });
    const backend = createEmbeddedExecutionBackend({
      runAgent,
      resumeAgent,
      steerEmbeddedSession,
      shutdownEmbeddedSession: vi.fn<ShutdownPort>(async () => {}),
    });
    const runSignal = new AbortController();
    const resumeSignal = new AbortController();
    let created: ExecutionSession | undefined;

    order.push("before");
    const running = backend.run(ctx, "general-purpose", "run", {
      pi,
      signal: runSignal.signal,
      onSessionCreated: (session) => {
        created = session;
        order.push("created");
      },
    });
    order.push("after");
    expect(order).toEqual(["before", "raw-run:run", "created", "raw-return", "after"]);
    expect(nativeRunOptions?.signal).toBe(runSignal.signal);

    runResult.resolve(result(harness.native));
    const completed = await running;
    expect(completed.session).toBe(created);

    const resuming = backend.resume(completed.session, "resume", { signal: resumeSignal.signal });
    expect(order.at(-1)).toBe("resume:resume");
    resumeResult.resolve({ text: "resumed" });
    await expect(resuming).resolves.toEqual({ text: "resumed" });

    const steering = backend.steer(completed.session, "steer");
    expect(order.at(-1)).toBe("steer:steer");
    let delivered = false;
    void steering.then(() => { delivered = true; });
    await Promise.resolve();
    expect(delivered).toBe(false);
    steerResult.resolve();
    await steering;
    expect(delivered).toBe(true);

    await expect(backend.run(ctx, "general-purpose", "fail-run", { pi })).rejects.toBe(runFailure);
    await expect(backend.resume(completed.session, "fail-resume")).rejects.toBe(resumeFailure);
    await expect(backend.steer(completed.session, "fail-steer")).rejects.toBe(steerFailure);
  });
});
