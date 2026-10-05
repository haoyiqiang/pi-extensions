import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { ExecutionSession } from "../src/backends/session.js";
import type { PersistentSessionReference } from "../src/backends/session-reference.js";
import type { AgentExecutionBackend, ExecutionRunResult } from "../src/backends/types.js";
import { i18n } from "../src/i18n.js";
import { cleanupWorktree, createWorktree, type WorktreeInfo } from "../src/worktree.js";

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
  isWorktreeIsolationEnabled: () => true,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function reference(id: string): PersistentSessionReference {
  return { backend: "terminal", sessionId: id, sessionFile: join(tmpdir(), "manager-scoped", `${id}.jsonl`) };
}

function session(ref = reference("late")): ExecutionSession {
  return {
    reference: ref,
    messages: [],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
    subscribe: () => () => {},
  };
}

function result(handle: ExecutionSession): ExecutionRunResult {
  return { session: handle, responseText: "done", aborted: false, steered: false };
}

const pi = {} as ExtensionAPI;
const ctx = { cwd: process.cwd() } as ExtensionContext;
const managers: AgentManager[] = [];
const metadata = { type: "Explore", description: "scoped ownership", workflowId: "workflow" };
const worktree: WorktreeInfo = { path: join(tmpdir(), "scoped-copy"), workPath: join(tmpdir(), "scoped-copy"), branch: "scoped", baseSha: "base" };

function fixture() {
  const backend = {
    kind: "terminal" as const,
    run: vi.fn<AgentExecutionBackend["run"]>(async (_ctx, _type, _prompt, options) => {
      const handle = session(reference(options.agentId!));
      options.onSessionCreated?.(handle);
      return result(handle);
    }),
    resume: vi.fn<AgentExecutionBackend["resume"]>(async () => ({ text: "resumed" })),
    reattach: vi.fn<NonNullable<AgentExecutionBackend["reattach"]>>(async ref => session(ref)),
    fork: vi.fn<NonNullable<AgentExecutionBackend["fork"]>>(async () => session(reference("fork"))),
    steer: vi.fn<AgentExecutionBackend["steer"]>(async () => {}),
    shutdown: vi.fn<AgentExecutionBackend["shutdown"]>(async () => {}),
  };
  const onComplete = vi.fn();
  const onStart = vi.fn();
  const manager = new AgentManager(onComplete, 1, onStart, undefined, undefined, backend);
  managers.push(manager);
  return { manager, backend, onComplete, onStart };
}

/** Promise-only scheduling: no sleeps or live backend required. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  vi.useRealTimers();
  vi.mocked(createWorktree).mockReset();
  vi.mocked(cleanupWorktree).mockReset().mockResolvedValue({ hasChanges: false });
});

describe("record retention", () => {
  it.each(["idle", "completed"] as const)("keeps multiple independent pins on a stale %s record until the last disposer", async state => {
    vi.useFakeTimers();
    const { manager, backend } = fixture();
    const { id, record } = state === "idle"
      ? await manager.restore(reference(state), metadata)
      : await manager.spawnAndWait(pi, ctx, "Explore", "first", { description: "first" });
    const handle = record.session;
    const first = manager.retain(id);
    const second = manager.retain(id);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(manager.getRecord(id)).toBe(record);
    expect(backend.shutdown).not.toHaveBeenCalled();
    first();
    first();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(id)).toBe(record);
    second();
    second();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(id)).toBeUndefined();
    expect(backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it.each(["clear", "release", "dispose"] as const)("lets explicit %s remove a retained record and invalidates its pins", async action => {
    vi.useFakeTimers();
    const { manager, backend } = fixture();
    const { id, record } = await manager.restore(reference("original"), metadata);
    const handle = record.session;
    const unpin = manager.retain(id);
    if (action === "clear") manager.clearCompleted(true);
    else if (action === "release") await manager.release(id);
    else await manager.dispose();
    expect(manager.getRecord(id)).toBeUndefined();
    expect(record.session).toBeUndefined();
    expect(backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
    expect(() => manager.retain(id)).toThrow(i18n.t("manager.unknownRecord", { id }));
    unpin();
    unpin();
    await manager.release(id);
    expect(backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it("invalidates old tokens at a session boundary without letting them consume a new pin", async () => {
    vi.useFakeTimers();
    const { manager } = fixture();
    const id = manager.spawn(pi, ctx, "Explore", "unconsumed", { description: "unconsumed", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    const old = manager.retain(id);
    manager.clearCompleted(true); // Unconsumed result survives, its old owner does not.
    expect(manager.getRecord(id)).toBe(record);
    const current = manager.retain(id);
    old();
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(manager.getRecord(id)).toBe(record);
    current();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("does not transfer old tokens to a newly adopted record of the same session", async () => {
    vi.useFakeTimers();
    const { manager } = fixture();
    const first = await manager.restore(reference("same-session"), metadata);
    const old = manager.retain(first.id);
    await manager.release(first.id);
    const next = await manager.restore(reference("same-session"), metadata);
    const current = manager.retain(next.id);
    old();
    expect(next.record).not.toBe(first.record);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(manager.getRecord(next.id)).toBe(next.record);
    current();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(next.id)).toBeUndefined();
  });

  it("keeps an owned predecessor available to fork through the same manager/backend after the GC window", async () => {
    vi.useFakeTimers();
    const { manager, backend } = fixture();
    const predecessor = await manager.restore(reference("predecessor"), metadata);
    const handle = predecessor.record.session!;
    const unpin = manager.retain(predecessor.id);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    backend.fork.mockImplementationOnce(async ref => {
      expect(ref).toEqual(handle.reference);
      expect(manager.getRecord(predecessor.id)?.session).toBe(handle);
      expect(backend.shutdown).not.toHaveBeenCalled();
      return session(reference("descendant"));
    });
    const fork = await manager.restore(handle.reference as PersistentSessionReference, { ...metadata, mode: "fork" });
    expect(backend.fork).toHaveBeenCalledOnce();
    await manager.release(predecessor.id);
    unpin();
    expect(manager.getRecord(fork.id)).toBe(fork.record);
    expect(backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it("clears a running record's pins at a session boundary without stopping the run", async () => {
    vi.useFakeTimers();
    const { manager, backend } = fixture();
    const pending = deferred<ExecutionRunResult>();
    backend.run.mockReturnValueOnce(pending.promise);
    const id = manager.spawn(pi, ctx, "Explore", "running", { description: "running" });
    const record = manager.getRecord(id)!;
    const unpin = manager.retain(id);
    manager.clearCompleted();
    expect(record.abortController?.signal.aborted).toBe(false);
    pending.resolve(result(session()));
    await record.promise;
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(manager.getRecord(id)).toBeUndefined();
    unpin();
  });

  it("rejects a retain for an unknown id, while release is an idempotent noop", async () => {
    const { manager, backend } = fixture();
    expect(() => manager.retain("unknown")).toThrow(i18n.t("manager.unknownRecord", { id: "unknown" }));
    await manager.release("unknown");
    expect(backend.shutdown).not.toHaveBeenCalled();
  });
});

describe("scoped release", () => {
  it("closes admission before backend callbacks and coalesces pending release without touching siblings", async () => {
    const { manager, backend } = fixture();
    const one = await manager.restore(reference("one"), metadata);
    const sibling = await manager.restore(reference("sibling"), metadata);
    const handle = one.record.session!;
    const closed = deferred<void>();
    let reentrant: Promise<void> | undefined;
    backend.shutdown.mockImplementationOnce(target => {
      expect(target).toBe(handle);
      expect(manager.getRecord(one.id)).toBeUndefined();
      reentrant = manager.release(one.id);
      return closed.promise;
    });
    const released = manager.release(one.id);
    expect(reentrant).toBe(released);
    expect(manager.release(one.id)).toBe(released);
    expect(one.record.session).toBeUndefined();
    await expect(manager.resume(one.id, "too late")).resolves.toBeUndefined();
    expect(manager.steer(one.id, "too late")).toBe(false);
    await expect(manager.restore(reference("one"), metadata)).rejects.toThrow(i18n.t("managerRestore.duplicate"));
    const done = vi.fn();
    void released.then(done);
    await flush();
    expect(done).not.toHaveBeenCalled();
    expect(manager.getRecord(sibling.id)).toBe(sibling.record);
    await manager.resume(sibling.id, "still usable");
    expect(sibling.record.result).toBe("resumed");
    closed.resolve();
    await released;
    await manager.release(one.id);
    expect(backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
    expect(manager.listAgents()).toEqual([sibling.record]);
    expect(manager.listTombstones()).toEqual([]);
  });

  it("does not wait for another record's pending shutdown", async () => {
    const { manager, backend } = fixture();
    const one = await manager.restore(reference("one"), metadata);
    const two = await manager.restore(reference("two"), metadata);
    const closed = deferred<void>();
    backend.shutdown.mockReturnValueOnce(closed.promise);
    const first = manager.release(one.id);
    await manager.release(two.id);
    expect(backend.shutdown).toHaveBeenCalledTimes(2);
    const done = vi.fn();
    void first.then(done);
    await flush();
    expect(done).not.toHaveBeenCalled();
    closed.resolve();
    await first;
  });

  it.each(["throw", "reject"] as const)("observes a backend shutdown %s exactly once", async failure => {
    const { manager, backend } = fixture();
    const { id } = await manager.restore(reference("failure"), metadata);
    backend.shutdown.mockImplementationOnce(() => {
      if (failure === "throw") throw new Error("uncertain retirement");
      return Promise.reject(new Error("uncertain retirement"));
    });
    await expect(manager.release(id)).resolves.toBeUndefined();
    await manager.release(id);
    expect(backend.shutdown).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it.each([false, true])("releases an active record, including one already stopped (%s), and drains its pool only on settlement", async stopped => {
    const { manager, backend, onComplete } = fixture();
    const running = deferred<ExecutionRunResult>();
    const closed = deferred<void>();
    const handle = session();
    backend.run.mockImplementationOnce((_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(handle);
      return running.promise;
    });
    backend.shutdown.mockReturnValueOnce(closed.promise);
    const id = manager.spawn(pi, ctx, "Explore", "active", { description: "active", isBackground: true });
    const record = manager.getRecord(id)!;
    const sibling = manager.spawn(pi, ctx, "Explore", "sibling", { description: "sibling", isBackground: true });
    if (stopped) manager.abort(id);
    const released = manager.release(id);
    const done = vi.fn();
    void released.then(done);
    expect(record.abortController?.signal.aborted).toBe(true);
    expect(record.status).toBe("stopped");
    expect(manager.getRecord(id)).toBeUndefined();
    await expect(manager.resume(id, "forbidden")).resolves.toBeUndefined();
    await flush();
    expect(done).not.toHaveBeenCalled();
    expect(manager.getRecord(sibling)?.status).toBe("queued");
    running.resolve({ ...result(handle), aborted: true });
    await flush();
    expect(done).not.toHaveBeenCalled();
    closed.resolve();
    await released;
    await record.promise;
    await manager.waitForAll();
    expect(manager.getRecord(sibling)?.status).toBe("completed");
    expect(backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0][0].id).toBe(sibling);
  });

  it.each([false, true])("closes foreground/background resume admission while its invocation is unsettled (background=%s)", async isBackground => {
    const { manager, backend } = fixture();
    const { id, record } = await manager.restore(reference("resuming"), metadata);
    const pending = deferred<{ text: string; aborted: boolean }>();
    backend.resume.mockReturnValueOnce(pending.promise);
    const resumed = manager.resume(id, "active", undefined, { isBackground });
    manager.abort(id);
    const controller = record.abortController;
    await manager.release(id);
    await expect(manager.resume(id, "forbidden")).resolves.toBeUndefined();
    expect(record.abortController).toBe(controller);
    expect(controller?.signal.aborted).toBe(true);
    pending.resolve({ text: "late partial", aborted: true });
    await resumed;
    await record.promise;
    expect(record.status).toBe("stopped");
    expect(record.session).toBeUndefined();
    expect(backend.resume).toHaveBeenCalledOnce();
    expect(backend.shutdown).toHaveBeenCalledOnce();
  });

  it.each(["foreground", "background"] as const)("removes a queued %s spawn and releases its gate without dispatch", async pool => {
    const { manager, backend } = fixture();
    manager.setMaxConcurrentForeground(1);
    const running = deferred<ExecutionRunResult>();
    backend.run.mockReturnValueOnce(running.promise);
    const foreground = pool === "foreground";
    const blocker = manager.spawn(pi, ctx, "Explore", "blocker", { description: "blocker", isBackground: !foreground, blocking: foreground });
    let queuedId!: string;
    const waiting = foreground
      ? manager.spawnAndWait(pi, ctx, "Explore", "queued", { description: "queued", onQueued: id => { queuedId = id; } })
      : undefined;
    if (!foreground) queuedId = manager.spawn(pi, ctx, "Explore", "queued", { description: "queued", isBackground: true });
    const queued = manager.getRecord(queuedId)!;
    expect(queued.status).toBe("queued");
    const gate = queued.startGate;
    await manager.release(queuedId);
    await gate;
    if (waiting) expect((await waiting).record).toBe(queued);
    expect(queued.status).toBe("stopped");
    expect(manager.getRecord(queuedId)).toBeUndefined();
    expect(manager.getRecord(blocker)?.status).toBe("running");
    expect(backend.shutdown).not.toHaveBeenCalled();
    running.resolve(result(session()));
    await manager.waitForAll();
    expect(backend.run).toHaveBeenCalledOnce();
  });

  it("removes a queued background resume and shuts only its existing handle", async () => {
    const { manager, backend } = fixture();
    const { id, record } = await manager.restore(reference("queued-resume"), { ...metadata, workflowId: undefined });
    const handle = record.session;
    const running = deferred<ExecutionRunResult>();
    backend.run.mockReturnValueOnce(running.promise);
    manager.spawn(pi, ctx, "Explore", "blocker", { description: "blocker", isBackground: true });
    await manager.resume(id, "queued", undefined, { isBackground: true });
    expect(record.status).toBe("queued");
    await manager.release(id);
    expect(backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
    running.resolve(result(session()));
    await manager.waitForAll();
    expect(backend.resume).not.toHaveBeenCalled();
    expect(manager.getRecord(id)).toBeUndefined();
  });
});

describe("startup and detached cleanup", () => {
  it.each([false, true])("awaits a released worktree startup and cleans its late copy once (also disposing=%s)", async dispose => {
    const { manager, backend } = fixture();
    const copy = deferred<WorktreeInfo>();
    const cleanup = deferred<{ hasChanges: boolean }>();
    vi.mocked(createWorktree).mockReturnValueOnce(copy.promise);
    vi.mocked(cleanupWorktree).mockReturnValueOnce(cleanup.promise);
    const id = manager.spawn(pi, ctx, "Explore", "copy", { description: "copy", isolation: "worktree" });
    const record = manager.getRecord(id)!;
    const released = manager.release(id);
    const done = vi.fn();
    void released.then(done);
    const disposing = dispose ? manager.dispose() : undefined;
    await flush();
    expect(done).not.toHaveBeenCalled();
    expect(record.abortController?.signal.aborted).toBe(true);
    copy.resolve(worktree);
    await flush();
    expect(cleanupWorktree).toHaveBeenCalledExactlyOnceWith(pi, ctx.cwd, worktree, "copy");
    expect(backend.run).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    cleanup.resolve({ hasChanges: false });
    await released;
    await disposing;
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("observes a rejected startup after release without resurrecting its record", async () => {
    const { manager, backend } = fixture();
    const copy = deferred<WorktreeInfo>();
    vi.mocked(createWorktree).mockReturnValueOnce(copy.promise);
    const id = manager.spawn(pi, ctx, "Explore", "copy", { description: "copy", isolation: "worktree" });
    const released = manager.release(id);
    copy.reject(new Error("copy failed"));
    await released;
    expect(manager.getRecord(id)).toBeUndefined();
    expect(backend.run).not.toHaveBeenCalled();
    expect(cleanupWorktree).not.toHaveBeenCalled();
  });

  it("awaits manager-owned cleanup after backend settlement without running cleanup twice", async () => {
    const { manager, backend } = fixture();
    const cleanup = deferred<{ hasChanges: boolean }>();
    vi.mocked(createWorktree).mockResolvedValueOnce(worktree);
    vi.mocked(cleanupWorktree).mockReturnValueOnce(cleanup.promise);
    const id = manager.spawn(pi, ctx, "Explore", "cleanup", { description: "cleanup", isolation: "worktree" });
    await flush();
    expect(cleanupWorktree).toHaveBeenCalledOnce();
    const released = manager.release(id);
    const done = vi.fn();
    void released.then(done);
    await flush();
    expect(done).not.toHaveBeenCalled();
    expect(backend.shutdown).toHaveBeenCalledOnce();
    cleanup.resolve({ hasChanges: false });
    await released;
    expect(cleanupWorktree).toHaveBeenCalledOnce();
  });

  it("does not dispatch after synchronous release in onStart", async () => {
    const { manager, backend, onStart } = fixture();
    let released: Promise<void> | undefined;
    onStart.mockImplementationOnce(record => { released = manager.release(record.id); });
    const id = manager.spawn(pi, ctx, "Explore", "start", { description: "start", isBackground: true });
    await released;
    expect(manager.getRecord(id)).toBeUndefined();
    expect(backend.run).not.toHaveBeenCalled();
    const next = manager.spawn(pi, ctx, "Explore", "next", { description: "next", isBackground: true });
    await manager.getRecord(next)?.promise;
    expect(manager.getRecord(next)?.status).toBe("completed");
  });

  it("leaves an opaque invocation's worktree alone until its late completion makes cleanup safe", async () => {
    const { manager, backend } = fixture();
    const running = deferred<ExecutionRunResult>();
    backend.run.mockReturnValueOnce(running.promise);
    vi.mocked(createWorktree).mockResolvedValueOnce(worktree);
    const id = manager.spawn(pi, ctx, "Explore", "opaque", { description: "opaque", isolation: "worktree" });
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    await manager.release(id);
    expect(cleanupWorktree).not.toHaveBeenCalled();
    expect(backend.shutdown).not.toHaveBeenCalled();
    const handle = session();
    running.resolve({ ...result(handle), aborted: true });
    await record.promise;
    expect(backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
    expect(cleanupWorktree).toHaveBeenCalledExactlyOnceWith(pi, ctx.cwd, worktree, "opaque");
  });

  it("awaits a handle published inside startup before release returns", async () => {
    const { manager, backend } = fixture();
    const running = deferred<ExecutionRunResult>();
    const closed = deferred<void>();
    const handle = session();
    backend.shutdown.mockReturnValueOnce(closed.promise);
    let released: Promise<void> | undefined;
    backend.run.mockImplementationOnce((_ctx, _type, _prompt, options) => {
      released = manager.release(options.agentId!);
      options.onSessionCreated?.(handle);
      return running.promise;
    });
    manager.spawn(pi, ctx, "Explore", "start", { description: "start" });
    const done = vi.fn();
    void released!.then(done);
    await flush();
    expect(backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
    expect(done).not.toHaveBeenCalled();
    closed.resolve();
    await released;
    running.resolve(result(handle));
    await manager.waitForAll();
    expect(backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it.each([false, true])("does not wait for opaque preflight and retires a late handle once (callback=%s)", async callback => {
    const { manager, backend, onComplete } = fixture();
    const pending = deferred<ExecutionRunResult>();
    backend.run.mockReturnValueOnce(pending.promise);
    const onSessionCreated = vi.fn();
    const id = manager.spawn(pi, ctx, "Explore", "preflight", { description: "preflight", onSessionCreated });
    const record = manager.getRecord(id)!;
    const options = backend.run.mock.calls[0][3];
    await manager.release(id);
    expect(options.signal?.aborted).toBe(true);
    expect(backend.shutdown).not.toHaveBeenCalled();
    const handle = session();
    if (callback) options.onSessionCreated?.(handle);
    pending.resolve({ ...result(handle), aborted: true, failure: "retirement unconfirmed" });
    await record.promise;
    expect(backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
    expect(record.session).toBeUndefined();
    expect(record).toMatchObject({ status: "stopped", error: "retirement unconfirmed" });
    expect(manager.listAgents()).toEqual([]);
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("aborted result diagnostics", () => {
  it.each([false, true])("preserves simultaneous fresh abort/failure metadata (externally stopped=%s)", async stopped => {
    const { manager, backend } = fixture();
    const pending = deferred<ExecutionRunResult>();
    backend.run.mockReturnValueOnce(pending.promise);
    const id = manager.spawn(pi, ctx, "Explore", "abort", { description: "abort" });
    const record = manager.getRecord(id)!;
    if (stopped) manager.abort(id);
    pending.resolve({ ...result(session()), aborted: true, steered: true, failure: "retirement unconfirmed", structuredJson: '{"partial":true}', structuredRetried: true });
    await record.promise;
    expect(record).toMatchObject({ status: stopped ? "stopped" : "aborted", error: "retirement unconfirmed", result: "done", structuredJson: '{"partial":true}', structuredRetried: true });
  });
});
