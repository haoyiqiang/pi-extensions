import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInChildSessionContext } from "../src/child-context.js";
import { i18n } from "../src/i18n.js";
import type { ManagedWorkflowExecution } from "../src/workflow/execution-contract.js";
import * as providerModule from "../src/workflow/execution-provider.js";
import {
  WORKFLOW_EXECUTOR_DISCOVERY, type WorkflowExecutorExecution, type WorkflowExecutorOffer,
  type WorkflowExecutorRequest,
} from "../src/workflow/executor-protocol.js";
import { registerWorkflowExecutor } from "../src/workflow/pi-executor.js";
import { ConsumerCancellation, deferred, executionFixture, flush } from "./helpers/workflow-execution.js";

const fixtures: ReturnType<typeof fixture>[] = [];
function fixture() {
  const f = executionFixture();
  const bus = new Map<string, Set<(data: unknown) => void>>();
  const hooks = new Map<string, Set<(event: { type: string; reason: string }) => unknown>>();
  function on<T>(map: Map<string, Set<T>>, name: string, fn: T) {
    let listeners = map.get(name);
    if (!listeners) map.set(name, listeners = new Set());
    listeners.add(fn);
    return () => { listeners!.delete(fn); };
  }
  const pi = Object.assign(f.pi, {
    events: { on: (name: string, fn: (data: unknown) => void) => on(bus, name, fn),
      emit: (name: string, data: unknown) => { for (const fn of [...bus.get(name) ?? []]) fn(data); } },
    on: (name: string, fn: (event: { type: string; reason: string }) => unknown) => on(hooks, name, fn),
  }) as unknown as ExtensionAPI;
  const createBackend = vi.fn((_kind: "embedded" | "terminal", _sessionDir: string) => ({ ...f.backend, kind: _kind }));
  const registrations: ReturnType<typeof registerWorkflowExecutor>[] = [];
  function register() { const value = registerWorkflowExecutor(pi, { createBackend }); registrations.push(value); return value; }
  function discover() {
    const offers: WorkflowExecutorOffer[] = [];
    pi.events.emit(WORKFLOW_EXECUTOR_DISCOVERY, { version: 1, offer: (offer: WorkflowExecutorOffer) => offers.push(offer) });
    return offers;
  }
  function request(extra: Partial<WorkflowExecutorRequest> = {}): WorkflowExecutorRequest {
    return { observer: Object.assign({}, f.observer, f.ctx),
      run: { runId: "bridge-run", childSessionsDir: dirname(f.sessionDir), workflow: "example", input: "input" },
      settings: { profile: "managed", backend: "embedded" }, cancellationError: signal => new ConsumerCancellation(signal), ...extra };
  }
  const subject = { ...f, pi, bus, hooks, createBackend, registrations, register, discover, request,
    emit: async (name: string, reason = "quit") => {
      await Promise.all([...hooks.get(name) ?? []].map(fn => fn({ type: name, reason })));
    } };
  fixtures.push(subject);
  return subject;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.close();
    await Promise.allSettled(f.registrations.map(registration => registration.close()));
  }
});

function mockExecution(close: () => Promise<void>) {
  const host = {} as ManagedWorkflowExecution["host"];
  vi.spyOn(providerModule, "createWorkflowExecutionProvider").mockImplementation(() => ({
    createHost: () => ({ host, close, dispose: () => {} }),
  }));
}

const diagnostic = (key: string) => i18n.t(`workflowExecutor.${key}`);

describe("explicit Pi workflow executor discovery", () => {
  it("offers only the versioned protocol without allocating execution resources", async () => {
    const f = fixture();
    const registration = f.register();
    const offer = f.discover()[0];
    expect(offer).toMatchObject({ version: 1, id: "pi-subagents", backends: ["embedded", "terminal"] });
    expect(Object.isFrozen(offer)).toBe(true);
    const incompatible = vi.fn();
    for (const data of [null, {}, { version: 2, offer: incompatible }, { version: 1, offer: false }]) {
      f.pi.events.emit(WORKFLOW_EXECUTOR_DISCOVERY, data);
    }
    expect(incompatible).not.toHaveBeenCalled();
    expect(f.createBackend).not.toHaveBeenCalled();
    await registration.close();
    expect(f.discover()).toEqual([]);
    expect(() => offer.createExecution(f.request())).toThrow(diagnostic("closed"));
    expect([...f.hooks.values()].every(listeners => listeners.size === 0)).toBe(true);
  });

  it("does not install an executor while constructing a child session", async () => {
    const f = fixture();
    await runInChildSessionContext(async () => { await f.register().close(); });
    expect(f.discover()).toEqual([]);
    expect(f.hooks.size).toBe(0);
  });

  it("does not remove another registration during its own shutdown", async () => {
    const f = fixture();
    const first = f.register();
    f.register();
    expect(f.discover()).toHaveLength(2);
    await first.close();
    expect(f.discover()).toHaveLength(1);
  });

  it.each(["session_start", "session_before_switch", "session_before_fork", "session_before_tree"])("keeps offers through %s and retires managed work only on committed navigation", async event => {
    const f = fixture();
    f.register();
    const old = f.discover()[0];
    const execution = await old.createExecution(f.request());
    await f.emit(event);
    expect(execution.signal?.aborted).toBe(false);
    await f.emit("session_shutdown", "new");
    expect(execution.signal?.aborted).toBe(true);
    expect(() => old.createExecution(f.request())).toThrow(diagnostic("closed"));
    const next = await f.discover()[0].createExecution(f.request());
    expect(next.signal?.aborted).toBe(false);
  });
});

describe("executor admission and resource identity", () => {
  it("requires a current Pi context and a canonical consumer cancellation factory", () => {
    const f = fixture();
    f.register();
    const offer = f.discover()[0];
    expect(() => offer.createExecution(f.request({ observer: f.observer }))).toThrow(diagnostic("context"));
    expect(() => offer.createExecution(f.request({ cancellationError: undefined as never }))).toThrow(diagnostic("request"));
    expect(() => offer.createExecution(f.request({ settings: { profile: "managed", backend: "other" as never } }))).toThrow(diagnostic("request"));
    expect(f.createBackend).not.toHaveBeenCalled();
  });

  it("rejects pre-cancelled work with the consumer's actual error before backend construction", () => {
    const f = fixture();
    f.register();
    const signal = AbortSignal.abort("cancelled");
    const error = new ConsumerCancellation(signal);
    expect(() => f.discover()[0].createExecution(f.request({ signal, cancellationError: () => error }))).toThrow(error);
    expect(f.createBackend).not.toHaveBeenCalled();
  });

  it.each(["run", "observer"])("retains %s cancellation rather than discarding it", async source => {
    const f = fixture();
    f.register();
    const run = new AbortController();
    const observer = new AbortController();
    const request = f.request({ signal: run.signal });
    request.observer.signal = observer.signal;
    const execution = await f.discover()[0].createExecution(request);
    (source === "run" ? run : observer).abort();
    expect(execution.signal?.aborted).toBe(true);
    await expect(execution.host.spawnChild({ prompt: "must not run", withSession: async () => {} })).rejects.toBeInstanceOf(ConsumerCancellation);
    expect(f.backend.run).not.toHaveBeenCalled();
  });

  it("keeps saved backend identity sticky while rejecting changed global tool requirements", async () => {
    const f = fixture();
    f.register();
    const offer = f.discover()[0];
    const first = await offer.createExecution(f.request({ settings: { profile: "managed", backend: "terminal", requiredTools: ["read", "bash", "read"] } }));
    expect(first.identity).toMatchObject({ backend: "terminal", profile: "managed" });
    expect(Object.isFrozen(first.identity.promptBinding)).toBe(true);
    await first.close();
    const resumed = await offer.createExecution(f.request({ identity: first.identity,
      settings: { profile: "managed", backend: "embedded", requiredTools: ["bash", "read"] } }));
    expect(resumed.identity).toEqual(first.identity);
    expect(f.createBackend.mock.calls.map(call => call[0])).toEqual(["terminal", "terminal"]);
    expect(() => offer.createExecution(f.request({ identity: first.identity, settings: { profile: "managed", backend: "embedded", requiredTools: ["read"] } })))
      .toThrow(i18n.t("promptBinding.mismatch"));
    expect(f.createBackend).toHaveBeenCalledTimes(2);
  });

  it("rejects incompatible executor identity and a lying backend factory before dispatch", () => {
    const f = fixture();
    f.register();
    const offer = f.discover()[0];
    expect(() => offer.createExecution(f.request({ identity: { version: 1, executor: "foreign", backend: "embedded" } as never })))
      .toThrow(diagnostic("identity"));
    f.createBackend.mockReturnValueOnce({ ...f.backend, kind: "terminal" });
    expect(() => offer.createExecution(f.request())).toThrow(diagnostic("identity"));
    expect(f.backend.run).not.toHaveBeenCalled();
  });

  it("snapshots approved instructions and minimum tools and detects changed resources on resume", async () => {
    const f = fixture();
    f.register();
    const filePath = join(f.root, "SKILL.md");
    writeFileSync(filePath, "---\nname: build\ndescription: fixture\n---\nOriginal $ARGUMENTS");
    const settings = { profile: "managed" as const, backend: "embedded" as const, requiredTools: ["read"], skills: [
      { name: "build", filePath, baseDir: f.root, format: "positional-v1" as const, requiredTools: ["bash"] },
    ] };
    const offer = f.discover()[0];
    const first = await offer.createExecution(f.request({ settings }));
    const identity = first.identity;
    settings.requiredTools.push("write");
    writeFileSync(filePath, "---\nname: build\ndescription: fixture\n---\nChanged");
    await first.host.spawnChild({ prompt: "/skill:build task", withSession: async () => {} });
    expect(f.backend.run.mock.calls[0][2]).toContain("Original task");
    expect(f.backend.run.mock.calls[0][3]).toMatchObject({ requiredTools: ["read", "bash"], promptBinding: identity.promptBinding });
    await first.close();
    expect(() => offer.createExecution(f.request({ settings, identity }))).toThrow(i18n.t("promptBinding.mismatch"));
    expect(f.backend.run).toHaveBeenCalledOnce();
  });
});

describe("executor retirement barriers", () => {
  it("does not retire a new generation while waiting for the previous generation", async () => {
    const f = fixture();
    const gate = deferred<void>();
    const closes: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(providerModule, "createWorkflowExecutionProvider").mockImplementation(() => ({ createHost: () => {
      const close = vi.fn(() => closes.length === 1 ? gate.promise : Promise.resolve());
      closes.push(close);
      return { host: {} as never, dispose: () => {}, close };
    } }));
    f.register();
    await f.discover()[0].createExecution(f.request());
    const rotation = f.emit("session_shutdown", "new");
    const second = await f.discover()[0].createExecution(f.request());
    await flush();
    expect(closes[0]).toHaveBeenCalledOnce();
    expect(closes[1]).not.toHaveBeenCalled();
    gate.resolve();
    await rotation;
    expect(closes[1]).not.toHaveBeenCalled();
    await second.close();
  });

  it("publishes an idempotent close barrier before invoking reentrant cleanup", async () => {
    const f = fixture();
    const gate = deferred<void>();
    let execution!: WorkflowExecutorExecution;
    let reentered: Promise<void> | undefined;
    const close = vi.fn(() => { reentered = execution.close(); return gate.promise; });
    mockExecution(close);
    const registration = f.register();
    execution = await f.discover()[0].createExecution(f.request());
    const barrier = execution.close();
    expect(reentered).toBe(barrier);
    expect(execution.close()).toBe(barrier);
    const closing = registration.close();
    expect(registration.close()).toBe(closing);
    let settled = false;
    void closing.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    gate.resolve();
    await closing;
    expect(close).toHaveBeenCalledOnce();
  });

  it("awaits every retirement and preserves cleanup failure on session shutdown", async () => {
    const f = fixture();
    const gate = deferred<void>();
    const error = new Error("retirement failed");
    const close = vi.fn(() => gate.promise);
    mockExecution(close);
    const registration = f.register();
    const execution = await f.discover()[0].createExecution(f.request());
    const shutdown = f.emit("session_shutdown");
    const rejection = expect(shutdown).rejects.toBe(error);
    expect(f.discover()).toEqual([]);
    gate.reject(error);
    await rejection;
    await expect(registration.close()).rejects.toBe(error);
    await expect(execution.close()).rejects.toBe(error);
  });

  it("memoizes a synchronous cleanup failure instead of retrying or losing it", async () => {
    const f = fixture();
    const error = new Error("synchronous close failure");
    const close = vi.fn((): Promise<void> => { throw error; });
    mockExecution(close);
    f.register();
    const execution = await f.discover()[0].createExecution(f.request());
    const barrier = execution.close();
    expect(execution.close()).toBe(barrier);
    await expect(barrier).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
  });
});
