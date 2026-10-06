import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, isTopLevelAgent } from "../src/agent-manager.js";
import type { ExecutionSession } from "../src/backends/session.js";
import type { ExecutionBackendKind, PersistentSessionReference } from "../src/backends/session-reference.js";
import type { AgentExecutionBackend, ExecutionRunResult } from "../src/backends/types.js";
import { i18n } from "../src/i18n.js";
import { getAgentConversation } from "../src/transcript.js";
import { AgentWidget } from "../src/ui/agent-widget.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

vi.mock("../src/worktree.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worktree.js")>(),
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

function reference(id = "saved", backend: ExecutionBackendKind = "embedded"): PersistentSessionReference {
  return { backend, sessionId: id, sessionFile: join(tmpdir(), "manager-restore", `${id}.jsonl`) };
}

function session(ref = reference()): ExecutionSession {
  return {
    reference: ref,
    model: { provider: "faux", id: "saved-model", name: "Saved model" },
    thinkingLevel: "off",
    messages: [{ role: "assistant", content: [{ type: "text", text: "historical answer" }] }],
    getSessionStats: () => ({ tokens: { input: 9000, output: 800, cacheWrite: 400 } }),
    subscribe: vi.fn(() => () => {}),
  };
}

const ctx = { cwd: process.cwd() } as ExtensionContext;
const pi = {} as any;
const metadata = { type: "Explore", description: "Restored audit", name: "Audit" };
const managers: AgentManager[] = [];
const dirs: string[] = [];

function fixture(kind: ExecutionBackendKind = "embedded", maxConcurrent = 1) {
  let forkCount = 0;
  const backend = {
    kind,
    run: vi.fn<AgentExecutionBackend["run"]>(async (_ctx, _type, prompt, options) => {
      const handle = session(reference(options.agentId, kind));
      options.onSessionCreated?.(handle);
      return { session: handle, responseText: prompt, aborted: false, steered: false };
    }),
    resume: vi.fn<AgentExecutionBackend["resume"]>(async () => ({ text: "fresh answer" })),
    reattach: vi.fn<NonNullable<AgentExecutionBackend["reattach"]>>(async ref => session(ref)),
    fork: vi.fn<NonNullable<AgentExecutionBackend["fork"]>>(async () => session(reference(`fork-${++forkCount}`, kind))),
    steer: vi.fn<AgentExecutionBackend["steer"]>(async () => {}),
    shutdown: vi.fn<AgentExecutionBackend["shutdown"]>(async () => {}),
  };
  const onComplete = vi.fn();
  const onStart = vi.fn();
  const onUsage = vi.fn();
  const onCompact = vi.fn();
  const manager = new AgentManager(onComplete, maxConcurrent, onStart, onCompact, onUsage, backend);
  managers.push(manager);
  return { manager, backend, onComplete, onStart, onUsage, onCompact };
}

/** Drain promise-only cleanup without depending on wall-clock scheduling. */
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function expectNoInvocation(f: ReturnType<typeof fixture>) {
  expect(f.backend.run).not.toHaveBeenCalled();
  expect(f.backend.resume).not.toHaveBeenCalled();
  expect(f.backend.steer).not.toHaveBeenCalled();
  expect(f.onStart).not.toHaveBeenCalled();
  expect(f.onComplete).not.toHaveBeenCalled();
  expect(f.onUsage).not.toHaveBeenCalled();
  expect(f.onCompact).not.toHaveBeenCalled();
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  vi.useRealTimers();
  vi.mocked(createWorktree).mockReset();
  vi.mocked(cleanupWorktree).mockReset().mockResolvedValue({ hasChanges: false });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("private managed manager adoption", () => {
  it.each(["embedded", "terminal"] as const)("reattaches %s history as idle without replaying a result or usage", async kind => {
    const f = fixture(kind);
    const ref = reference("saved", kind);
    const handle = session(ref);
    f.backend.reattach.mockResolvedValueOnce(handle);
    const { id, record } = await f.manager.restore(ref, metadata);

    expect(id).not.toBe(ref.sessionId);
    expect(record).toBe(f.manager.getRecord(id));
    expect(record).toMatchObject({
      id, type: "Explore", description: "Restored audit", handle: "explore", alias: "audit",
      status: "idle", session: handle, sessionFile: ref.sessionFile, depth: 1,
      resultConsumed: true, toolUses: 0, compactionCount: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      invocation: { modelId: "faux/saved-model", modelName: "saved model", thinking: "off" },
    });
    for (const field of ["result", "error", "structuredJson", "structuredRetried", "completedAt", "promise", "startGate", "abortController", "isBackground", "blocking"]) {
      expect(record[field as keyof typeof record]).toBeUndefined();
    }
    expect(record.session?.reference).toBe(ref);
    expect(getAgentConversation(record.session!)).toContain("historical answer");
    expect(handle.subscribe).not.toHaveBeenCalled();
    expect(f.manager.resolveMention("AUDIT")).toEqual({ kind: "live", record });
    expect(f.manager.hasRunning()).toBe(false);
    expect(f.manager.abort(id)).toBe(false);
    expect(f.manager.steer(id, "not a run")).toBe(false);
    await f.manager.waitForAll();
    expectNoInvocation(f);
    await f.manager.dispose();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it.each(["reattach", "fork"] as const)("forwards validators, context and an adoption-only signal for %s", async mode => {
    const f = fixture();
    const structuredOutput = { schema: { type: "object", properties: { answer: { type: "number" } } }, check: vi.fn(() => true as const) };
    const abort = new AbortController();
    const ref = reference();
    const { record } = await f.manager.restore(ref, { ...metadata, mode, ctx, signal: abort.signal, structuredOutput });
    expect(f.backend[mode]).toHaveBeenCalledOnce();
    const [saved, options] = f.backend[mode].mock.calls[0];
    expect(saved).toEqual(ref);
    expect(saved).not.toBe(ref);
    expect(options?.ctx).toBe(ctx);
    expect(options?.structuredOutput).toBe(structuredOutput);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal).not.toBe(abort.signal);
    expect(options?.signal?.aborted).toBe(false);
    abort.abort();
    expect(options?.signal?.aborted).toBe(false);
    expect(record.status).toBe("idle");
    expectNoInvocation(f);
  });

  it("forks an already-owned idle source into independent session and manager identities", async () => {
    const f = fixture();
    const ref = reference();
    const original = await f.manager.restore(ref, metadata);
    const fork = await f.manager.restore(ref, { ...metadata, mode: "fork" });
    expect(fork.id).not.toBe(original.id);
    expect(fork.record.handle).toBe("explore-2");
    expect(fork.record.alias).toBe("audit-2");
    expect(fork.record.session?.reference.sessionId).not.toBe(ref.sessionId);
    expect(fork.record.sessionFile).not.toBe(ref.sessionFile);
    expect(fork.record.session?.messages).toEqual(original.record.session?.messages);
    expect(original.record.session?.reference).toEqual(ref);
    expect(original.record.status).toBe("idle");
    expect(fork.record.status).toBe("idle");
    expectNoInvocation(f);
  });

  it("snapshots caller metadata before asynchronous acquisition", async () => {
    const f = fixture();
    const pending = deferred<ExecutionSession>();
    f.backend.reattach.mockReturnValueOnce(pending.promise);
    const ref = { ...reference() };
    const options = { ...metadata };
    const restoring = f.manager.restore(ref, options);
    options.description = "mutated";
    options.type = "Plan";
    ref.sessionId = "mutated";
    await flush();
    const acquiredRef = f.backend.reattach.mock.calls[0][0];
    pending.resolve(session(acquiredRef));
    const { record } = await restoring;
    expect(record.description).toBe(metadata.description);
    expect(record.type).toBe(metadata.type);
    expect(record.session?.reference.sessionId).toBe("saved");
  });

  it("keeps restored nested and workflow ownership hidden without consuming handles", async () => {
    const f = fixture();
    const nested = await f.manager.restore(reference("nested"), {
      ...metadata, parentAgentId: "parent", depth: 2, maxSubagentDepth: 4, rootSessionId: "root",
    });
    const workflow = await f.manager.restore(reference("workflow"), { ...metadata, workflowId: "workflow" });
    for (const { id, record } of [nested, workflow]) {
      expect(record.handle).toBeUndefined();
      expect(record.alias).toBeUndefined();
      expect(isTopLevelAgent(record)).toBe(false);
      expect(f.manager.resolveMention(id)).toBeUndefined();
      expect(f.manager.getRecord(id)).toBe(record);
    }
    expect(nested.record).toMatchObject({ parentAgentId: "parent", depth: 2, maxSubagentDepth: 4, rootSessionId: "root" });
    expect(workflow.record.workflowId).toBe("workflow");
    const top = await f.manager.restore(reference("top"), metadata);
    expect(top.record.handle).toBe("explore");
    expect(top.record.alias).toBe("audit");
    expectNoInvocation(f);
  });
});

describe("adoption uses only subsequent resume invocations", () => {
  it("starts foreground resume with fresh results and accumulates only new usage", async () => {
    const f = fixture();
    const { id, record } = await f.manager.restore(reference(), metadata);
    const first = deferred<{ text: string; structuredJson: string; structuredRetried: boolean }>();
    f.backend.resume.mockImplementationOnce(async (_session, prompt, options) => {
      expect(prompt).toBe("new task");
      options?.onToolActivity?.({ type: "end", toolName: "read" });
      options?.onAssistantUsage?.({ input: 7, output: 3, cacheWrite: 2, cost: 0.01 });
      return first.promise;
    });
    const resumed = f.manager.resume(id, "new task");
    expect(record.status).toBe("running");
    expect(record.result).toBeUndefined();
    expect(record.structuredJson).toBeUndefined();
    first.resolve({ text: "new result", structuredJson: '{"answer":1}', structuredRetried: true });
    await expect(resumed).resolves.toBe(record);
    expect(record).toMatchObject({
      status: "completed", result: "new result", structuredJson: '{"answer":1}', structuredRetried: true,
      resultConsumed: true, toolUses: 1, lifetimeUsage: { input: 7, output: 3, cacheWrite: 2, cost: 0.01 },
    });
    await f.manager.resume(id, "another task");
    expect(record.result).toBe("fresh answer");
    expect(record.structuredJson).toBeUndefined();
    expect(record.structuredRetried).toBeUndefined();
    expect(f.backend.resume.mock.calls[0][0]).toBe(record.session);
    expect(f.onUsage).toHaveBeenCalledOnce();
    // Foreground resume keeps its historical inline (no start/complete notification) behavior.
    expect(f.onStart).not.toHaveBeenCalled();
    expect(f.onComplete).not.toHaveBeenCalled();
  });

  it("takes no background slot and queues only when an adopted session is resumed", async () => {
    const f = fixture();
    const run = deferred<ExecutionRunResult>();
    f.backend.run.mockReturnValueOnce(run.promise);
    const holder = f.manager.spawn(pi, ctx, "Plan", "holder", { description: "holder", isBackground: true });
    const { id, record } = await f.manager.restore(reference(), metadata);
    expect(record.status).toBe("idle");
    expect(f.onStart).toHaveBeenCalledOnce();
    expect(f.onComplete).not.toHaveBeenCalled();
    const started = vi.fn();
    await f.manager.resume(id, "background task", undefined, { isBackground: true, onStarted: started });
    expect(record.status).toBe("queued");
    expect(record.resultConsumed).toBe(false);
    expect(f.backend.resume).not.toHaveBeenCalled();
    run.resolve({ session: session(reference("holder")), responseText: "holder result", aborted: false, steered: false });
    await f.manager.getRecord(holder)?.promise;
    await record.promise;
    expect(started).toHaveBeenCalledOnce();
    expect(f.onStart).toHaveBeenCalledTimes(2);
    expect(f.onComplete).toHaveBeenCalledTimes(2);
    expect(record).toMatchObject({ status: "completed", result: "fresh answer", resultConsumed: false });
    expect(f.backend.resume).toHaveBeenCalledExactlyOnceWith(record.session, "background task", expect.any(Object));
    // A freed slot is usable; idle adoption neither incremented nor decremented it.
    const next = f.manager.spawn(pi, ctx, "Plan", "next", { description: "next", isBackground: true });
    expect(f.manager.getRecord(next)?.status).toBe("running");
    await f.manager.getRecord(next)?.promise;
  });

  it("does not wait on or consume a saturated foreground pool", async () => {
    const f = fixture();
    f.manager.setMaxConcurrentForeground(1);
    const held = deferred<ExecutionRunResult>();
    f.backend.run.mockReturnValueOnce(held.promise);
    const first = f.manager.spawnAndWait(pi, ctx, "Plan", "first", { description: "first" });
    const adopted = await f.manager.restore(reference(), metadata);
    const second = f.manager.spawnAndWait(pi, ctx, "Plan", "second", { description: "second" });
    expect(adopted.record.status).toBe("idle");
    expect(f.backend.run).toHaveBeenCalledOnce();
    expect(f.manager.listAgents().find(record => record.description === "second")?.status).toBe("queued");
    held.resolve({ session: session(reference("first")), responseText: "first", aborted: false, steered: false });
    await first;
    await second;
    expect(f.backend.run).toHaveBeenCalledTimes(2);
    expect(adopted.record.status).toBe("idle");
  });
});

describe("restore validation and duplicate ownership", () => {
  it("validates kind, capability, mode, identity and pre-cancellation without backend side effects", async () => {
    const f = fixture();
    await expect(f.manager.restore(reference("saved", "terminal"), metadata)).rejects.toThrow(i18n.t("managerRestore.backendMismatch"));
    await expect(f.manager.restore(reference(), { ...metadata, mode: "other" as any })).rejects.toThrow(i18n.t("managerRestore.invalidMode"));
    await expect(f.manager.restore({ ...reference(), sessionFile: "relative.jsonl" }, metadata)).rejects.toThrow(i18n.t("managerRestore.invalidReference"));
    const abort = new AbortController();
    abort.abort();
    await expect(f.manager.restore(reference(), { ...metadata, signal: abort.signal })).rejects.toThrow(i18n.t("managerRestore.cancelled"));
    for (const mode of ["reattach", "fork"] as const) {
      const method = f.backend[mode];
      (f.backend as AgentExecutionBackend)[mode] = undefined;
      await expect(f.manager.restore(reference(), { ...metadata, mode })).rejects.toThrow(i18n.t("managerRestore.unsupported", { mode, backend: "embedded" }));
      f.backend[mode] = method;
    }
    expect(f.backend.reattach).not.toHaveBeenCalled();
    expect(f.backend.fork).not.toHaveBeenCalled();
    expect(f.backend.shutdown).not.toHaveBeenCalled();
    expect(f.manager.listAgents()).toEqual([]);
    expectNoInvocation(f);
    await f.manager.dispose();
    await expect(f.manager.restore(reference(), metadata)).rejects.toThrow(i18n.t("managerRestore.disposed"));
    expect(f.backend.reattach).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"])("propagates backend %s and releases the reservation for retry", async behavior => {
    const f = fixture();
    const error = new Error("backend preparation failed");
    f.backend.reattach.mockImplementationOnce(() => {
      if (behavior === "throw") throw error;
      return Promise.reject(error);
    });
    await expect(f.manager.restore(reference(), metadata)).rejects.toBe(error);
    await flush();
    expect(f.manager.listAgents()).toEqual([]);
    expect(f.backend.shutdown).not.toHaveBeenCalled();
    const restored = await f.manager.restore(reference(), metadata);
    expect(restored.record.handle).toBe("explore");
    expectNoInvocation(f);
  });

  it("rejects concurrent reattach before a duplicate backend acquisition", async () => {
    const f = fixture();
    const acquired = deferred<ExecutionSession>();
    f.backend.reattach.mockReturnValueOnce(acquired.promise);
    const first = f.manager.restore(reference(), metadata);
    await expect(f.manager.restore(reference(), metadata)).rejects.toThrow(i18n.t("managerRestore.duplicate"));
    expect(f.backend.reattach).toHaveBeenCalledOnce();
    acquired.resolve(session());
    await first;
    for (const ref of [reference(), { ...reference("different"), sessionId: "saved" }, { ...reference(), sessionId: "different" }]) {
      await expect(f.manager.restore(ref, metadata)).rejects.toThrow(i18n.t("managerRestore.duplicate"));
    }
    expect(f.backend.reattach).toHaveBeenCalledOnce();
    expect(f.manager.listAgents()).toHaveLength(1);
  });

  it("converges canonical path aliases without depending on a backend lease", async () => {
    const f = fixture();
    const dir = mkdtempSync(join(tmpdir(), "pi-manager-restore-"));
    dirs.push(dir);
    const path = join(dir, "session.jsonl");
    const alias = join(dir, "alias.jsonl");
    writeFileSync(path, "");
    symlinkSync(path, alias);
    await f.manager.restore({ ...reference(), sessionFile: path }, metadata);
    await expect(f.manager.restore({ ...reference("alias"), sessionFile: alias }, metadata)).rejects.toThrow(i18n.t("managerRestore.duplicate"));
    expect(f.backend.reattach).toHaveBeenCalledOnce();
  });

  it("also guards sessions acquired by normal spawn", async () => {
    const f = fixture();
    const { record } = await f.manager.spawnAndWait(pi, ctx, "Plan", "existing", { description: "existing" });
    await expect(f.manager.restore(record.session!.reference as PersistentSessionReference, metadata)).rejects.toThrow(i18n.t("managerRestore.duplicate"));
    expect(f.backend.reattach).not.toHaveBeenCalled();
  });

  it.each(["kind", "reattach-id", "reattach-path", "fork-id", "fork-path"])("closes a backend handle with invalid %s identity", async problem => {
    const f = fixture();
    const ref = reference();
    const returned = problem === "kind" ? reference("saved", "terminal")
      : problem.endsWith("id") ? { ...ref, sessionId: "different" }
      : { ...ref, sessionFile: reference("different").sessionFile };
    const mode = problem.startsWith("fork") ? "fork" : "reattach";
    const handle = session(returned);
    f.backend[mode].mockResolvedValueOnce(handle);
    await expect(f.manager.restore(ref, { ...metadata, mode })).rejects.toThrow(i18n.t("managerRestore.invalidSession"));
    await flush();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
    expect(f.manager.listAgents()).toEqual([]);
    expectNoInvocation(f);
  });

  it("rejects duplicate fork destinations and closes only the unadopted handle", async () => {
    const f = fixture();
    const destination = reference("destination");
    const one = session(destination);
    const two = session(destination);
    f.backend.fork.mockResolvedValueOnce(one).mockResolvedValueOnce(two);
    const first = f.manager.restore(reference(), { ...metadata, mode: "fork" });
    const second = f.manager.restore(reference(), { ...metadata, mode: "fork" });
    await first;
    await expect(second).rejects.toThrow(i18n.t("managerRestore.duplicate"));
    await flush();
    expect(f.manager.listAgents()).toHaveLength(1);
    expect(f.manager.listAgents()[0].session).toBe(one);
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(two);
    // Even a broken backend returning the exact live handle must not close its owner.
    f.backend.fork.mockResolvedValueOnce(one);
    await expect(f.manager.restore(reference(), { ...metadata, mode: "fork" })).rejects.toThrow(i18n.t("managerRestore.duplicate"));
    await flush();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(two);
  });
});

describe("restoration cancellation and idle cleanup", () => {
  it("cancels promptly and awaits a late handle's cleanup during disposal", async () => {
    const f = fixture();
    const acquired = deferred<ExecutionSession>();
    const closed = deferred<void>();
    f.backend.reattach.mockReturnValueOnce(acquired.promise);
    f.backend.shutdown.mockReturnValueOnce(closed.promise);
    const abort = new AbortController();
    const restoring = f.manager.restore(reference(), { ...metadata, signal: abort.signal });
    await flush();
    abort.abort();
    await expect(restoring).rejects.toThrow(i18n.t("managerRestore.cancelled"));
    expect(f.backend.reattach.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(f.manager.restore(reference(), metadata)).rejects.toThrow(i18n.t("managerRestore.duplicate"));
    const disposed = vi.fn();
    const disposing = f.manager.dispose().then(disposed);
    await flush();
    expect(disposed).not.toHaveBeenCalled();
    const handle = session();
    acquired.resolve(handle);
    await flush();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
    expect(f.manager.listAgents()).toEqual([]);
    expect(disposed).not.toHaveBeenCalled();
    const disposedAgain = vi.fn();
    const secondDisposal = f.manager.dispose().then(disposedAgain);
    await flush();
    expect(disposedAgain).not.toHaveBeenCalled();
    closed.resolve();
    await Promise.all([disposing, secondDisposal]);
    expect(disposed).toHaveBeenCalledOnce();
    expect(disposedAgain).toHaveBeenCalledOnce();
    expectNoInvocation(f);
  });

  it.each(["reattach", "fork"] as const)("disposal invalidates pending %s without relying on backend cancellation", async mode => {
    const f = fixture();
    const acquired = deferred<ExecutionSession>();
    f.backend[mode].mockReturnValueOnce(acquired.promise);
    const restoring = f.manager.restore(reference(), { ...metadata, mode });
    await flush();
    const disposing = f.manager.dispose();
    await expect(restoring).rejects.toThrow(i18n.t("managerRestore.cancelled"));
    const late = session(reference(mode === "fork" ? "fork" : "saved"));
    acquired.resolve(late);
    await disposing;
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(late);
    expect(f.manager.listAgents()).toEqual([]);
    expectNoInvocation(f);
  });

  it("clears a session boundary while acquisition is pending without resurrecting old records", async () => {
    const f = fixture();
    const acquired = deferred<ExecutionSession>();
    f.backend.reattach.mockReturnValueOnce(acquired.promise);
    const restoring = f.manager.restore(reference(), metadata);
    await flush();
    f.manager.clearCompleted(true);
    await expect(restoring).rejects.toThrow(i18n.t("managerRestore.cancelled"));
    const fresh = await f.manager.restore(reference("new-session"), metadata);
    acquired.resolve(session());
    await flush();
    expect(f.manager.listAgents()).toEqual([fresh.record]);
    expect(fresh.record.handle).toBe("explore");
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
    expect(f.manager.listTombstones()).toEqual([]);
    expectNoInvocation(f);
  });

  it("cancels before deferred backend entry when reset happens in the calling tick", async () => {
    const f = fixture();
    const restoring = f.manager.restore(reference(), metadata);
    f.manager.clearCompleted();
    await expect(restoring).rejects.toThrow(i18n.t("managerRestore.cancelled"));
    await flush();
    expect(f.backend.reattach).not.toHaveBeenCalled();
    expect(f.backend.shutdown).not.toHaveBeenCalled();
  });

  it.each(["resolve-then-abort", "abort-during-metadata"])("never commits cancelled adoption at the %s race", async race => {
    const f = fixture();
    const abort = new AbortController();
    const acquired = deferred<ExecutionSession>();
    f.backend.reattach.mockReturnValueOnce(acquired.promise);
    const handle = session();
    if (race === "abort-during-metadata") Object.defineProperty(handle, "model", { get: () => { abort.abort(); return undefined; } });
    const restoring = f.manager.restore(reference(), { ...metadata, signal: abort.signal });
    await flush();
    acquired.resolve(handle);
    if (race === "resolve-then-abort") abort.abort();
    await expect(restoring).rejects.toThrow(i18n.t("managerRestore.cancelled"));
    await flush();
    expect(f.manager.listAgents()).toEqual([]);
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it.each(["throw", "reject"])("observes a late shutdown %s without masking cancellation or rejecting disposal", async failure => {
    const f = fixture();
    const acquired = deferred<ExecutionSession>();
    f.backend.reattach.mockReturnValueOnce(acquired.promise);
    f.backend.shutdown.mockImplementation(() => {
      if (failure === "throw") throw new Error("shutdown failed");
      return Promise.reject(new Error("shutdown failed"));
    });
    const restoring = f.manager.restore(reference(), metadata);
    await flush();
    const disposing = f.manager.dispose();
    await expect(restoring).rejects.toThrow(i18n.t("managerRestore.cancelled"));
    acquired.resolve(session());
    await expect(disposing).resolves.toBeUndefined();
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
  });

  it("observes a late backend rejection after cancellation", async () => {
    const f = fixture();
    const acquired = deferred<ExecutionSession>();
    f.backend.reattach.mockReturnValueOnce(acquired.promise);
    const abort = new AbortController();
    const restoring = f.manager.restore(reference(), { ...metadata, signal: abort.signal });
    await flush();
    abort.abort();
    await expect(restoring).rejects.toThrow(i18n.t("managerRestore.cancelled"));
    const disposing = f.manager.dispose();
    acquired.reject(new Error("late preparation error"));
    await expect(disposing).resolves.toBeUndefined();
    expect(f.backend.shutdown).not.toHaveBeenCalled();
  });

  it("removes consumed idle records on clear and waits for their detached shutdown", async () => {
    const f = fixture();
    const { id, record } = await f.manager.restore(reference(), metadata);
    const closed = deferred<void>();
    f.backend.shutdown.mockReturnValueOnce(closed.promise);
    f.manager.clearCompleted(true);
    expect(f.manager.getRecord(id)).toBeUndefined();
    expect(record.session).toBeUndefined();
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
    await expect(f.manager.restore(reference(), metadata)).rejects.toThrow(i18n.t("managerRestore.duplicate"));
    const disposed = vi.fn();
    const disposing = f.manager.dispose().then(disposed);
    await flush();
    expect(disposed).not.toHaveBeenCalled();
    closed.resolve();
    await disposing;
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
    expectNoInvocation(f);
  });

  it("retains idle records for the normal window instead of immediately treating them as ancient", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { id, record } = await f.manager.restore(reference(), metadata);
    const handle = record.session;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.manager.getRecord(id)).toBe(record);
    expect(f.backend.shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.manager.getRecord(id)).toBeUndefined();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
    expectNoInvocation(f);
  });
});

describe("manager invocation ownership through settlement", () => {
  it.each(["adopted", "spawned"])("tracks deferred foreground resume of an %s record in record.promise and waitForAll", async origin => {
    const f = fixture();
    const { id, record } = origin === "adopted"
      ? await f.manager.restore(reference(), metadata)
      : await f.manager.spawnAndWait(pi, ctx, "Explore", "seed", { description: "seed" });
    const previous = record.promise;
    const pending = deferred<{ text: string; structuredJson: string }>();
    f.backend.resume.mockReturnValueOnce(pending.promise);
    f.onStart.mockClear();
    f.onComplete.mockClear();
    const resumed = f.manager.resume(id, "follow-up");
    const invocation = record.promise;
    expect(invocation).toBeInstanceOf(Promise);
    expect(invocation).not.toBe(previous);
    const done = vi.fn();
    const all = f.manager.waitForAll().then(done);
    await flush();
    expect(done).not.toHaveBeenCalled();
    pending.resolve({ text: "new answer", structuredJson: '{"ok":true}' });
    await expect(invocation).resolves.toBe("new answer");
    expect(record).toMatchObject({ status: "completed", result: "new answer", structuredJson: '{"ok":true}' });
    await resumed;
    await all;
    expect(done).toHaveBeenCalledOnce();
    expect(f.onStart).not.toHaveBeenCalled();
    expect(f.onComplete).not.toHaveBeenCalled();
  });

  it.each(["fresh", "foreground", "background"])("refuses every resume after abort until the %s invocation settles", async path => {
    const f = fixture();
    const pending = deferred<{ text: string }>();
    const running = deferred<ExecutionRunResult>();
    let foreground: Promise<unknown> | undefined;
    let id: string;
    if (path === "fresh") {
      f.backend.run.mockImplementationOnce((_ctx, _type, _prompt, options) => {
        options.onSessionCreated?.(session());
        return running.promise;
      });
      id = f.manager.spawn(pi, ctx, "Explore", "fresh", { description: "fresh", isBackground: true });
    } else {
      ({ id } = await f.manager.restore(reference(), metadata));
      f.backend.resume.mockReturnValueOnce(pending.promise);
      if (path === "background") await f.manager.resume(id, "first", undefined, { isBackground: true });
      else foreground = f.manager.resume(id, "first");
    }
    const record = f.manager.getRecord(id)!;
    const controller = record.abortController;
    const invocation = record.promise;
    f.manager.abort(id);
    record.result = "partial work still owned";
    record.structuredJson = '{"old":true}';
    const state = { ...record };
    for (const isBackground of [false, true]) {
      await expect(f.manager.resume(id, "must refuse", undefined, { isBackground })).resolves.toBeUndefined();
      expect(record).toEqual(state);
      expect(record.promise).toBe(invocation);
      expect(record.abortController).toBe(controller);
    }
    const done = vi.fn();
    const all = f.manager.waitForAll().then(done);
    await flush();
    expect(done).not.toHaveBeenCalled();
    if (path === "fresh") running.resolve({ session: record.session!, responseText: "old final", aborted: true, steered: false });
    else pending.resolve({ text: "old final" });
    await invocation;
    await foreground;
    await all;
    expect(record.status).toBe("stopped");
    expect(record.result).toBe("old final");
    await expect(f.manager.resume(id, "now safe")).resolves.toMatchObject({ status: "completed", result: "fresh answer" });
    expect(record.abortController).not.toBe(controller);
  });

  it.each(["fresh", "background"])("holds %s ownership through output cleanup and onComplete callbacks", async path => {
    const f = fixture();
    const attempts: Promise<unknown>[] = [];
    const values: string[] = [];
    let id: string;
    const completion = (record: NonNullable<ReturnType<AgentManager["getRecord"]>>) => {
      values.push(record.result!);
      attempts.push(f.manager.resume(record.id, "reentrant", undefined, { isBackground: true }));
      expect(record.result).toBe(values[values.length - 1]);
    };
    f.onComplete.mockImplementationOnce(completion);
    if (path === "fresh") {
      id = f.manager.spawn(pi, ctx, "Explore", "fresh", {
        description: "fresh", isBackground: true,
        onSpawned: spawned => { f.manager.getRecord(spawned)!.outputCleanup = () => completion(f.manager.getRecord(spawned)!); },
      });
    } else {
      ({ id } = await f.manager.restore(reference(), metadata));
      await f.manager.resume(id, "background", undefined, {
        isBackground: true,
        onStarted: () => { f.manager.getRecord(id)!.outputCleanup = () => completion(f.manager.getRecord(id)!); },
      });
    }
    const record = f.manager.getRecord(id)!;
    await record.promise;
    expect(attempts).toHaveLength(2);
    await expect(Promise.all(attempts)).resolves.toEqual([undefined, undefined]);
    expect(f.onComplete).toHaveBeenCalledOnce();
    const before = f.backend.resume.mock.calls.length;
    await f.manager.resume(id, "after settlement");
    expect(f.backend.resume).toHaveBeenCalledTimes(before + 1);
  });

  it("reserves background resume before onStart and uses its new controller during reentrant abort", async () => {
    const f = fixture();
    const { id, record } = await f.manager.restore(reference(), metadata);
    const pending = deferred<{ text: string }>();
    f.backend.resume.mockReturnValueOnce(pending.promise);
    let attempt: Promise<unknown> | undefined;
    let stoppedController: AbortController | undefined;
    f.onStart.mockImplementationOnce(() => {
      stoppedController = record.abortController;
      f.manager.abort(id);
      attempt = f.manager.resume(id, "reentrant");
    });
    await f.manager.resume(id, "background", undefined, { isBackground: true });
    await expect(attempt).resolves.toBeUndefined();
    expect(record.abortController).toBe(stoppedController);
    expect(f.backend.resume.mock.calls[0][2]?.signal?.aborted).toBe(true);
    pending.resolve({ text: "aborted invocation" });
    await record.promise;
    expect(record.status).toBe("stopped");
    expect(f.backend.resume).toHaveBeenCalledOnce();
  });

  it("reserves fresh startup before a synchronous session-created callback aborts and resumes it", async () => {
    const f = fixture();
    const pending = deferred<ExecutionRunResult>();
    const handle = session();
    f.backend.run.mockImplementationOnce((_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(handle);
      return pending.promise;
    });
    let attempt: Promise<unknown> | undefined;
    let waiting: Promise<void> | undefined;
    const done = vi.fn();
    const id = f.manager.spawn(pi, ctx, "Explore", "fresh", {
      description: "fresh",
      onSessionCreated: () => {
        const current = f.manager.listAgents()[0];
        f.manager.abort(current.id);
        attempt = f.manager.resume(current.id, "reentrant");
        waiting = f.manager.waitForAll().then(done);
      },
    });
    await expect(attempt).resolves.toBeUndefined();
    await flush();
    expect(done).not.toHaveBeenCalled();
    pending.resolve({ session: handle, responseText: "stopped", aborted: true, steered: false });
    await f.manager.getRecord(id)!.promise;
    await waiting;
    expect(f.backend.resume).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it("keeps foreground ownership until owned-child abort callbacks finish", async () => {
    const f = fixture();
    const { id, record } = await f.manager.restore(reference(), metadata);
    const childRun = deferred<ExecutionRunResult>();
    let attempt: Promise<unknown> | undefined;
    f.backend.run.mockImplementationOnce((_ctx, _type, _prompt, options) => {
      options.signal?.addEventListener("abort", () => { attempt = f.manager.resume(id, "child callback"); }, { once: true });
      options.onSessionCreated?.(session(reference("child")));
      return childRun.promise;
    });
    const child = f.manager.spawn(pi, ctx, "Plan", "child", { description: "child", parentAgentId: id, isBackground: true });
    await f.manager.resume(id, "parent turn");
    await expect(record.promise).resolves.toBe("fresh answer");
    await expect(attempt).resolves.toBeUndefined();
    expect(f.manager.getRecord(child)?.status).toBe("stopped");
    expect(f.backend.resume).toHaveBeenCalledOnce();
    childRun.resolve({ session: f.manager.getRecord(child)!.session!, responseText: "child", aborted: true, steered: false });
    await f.manager.waitForAll();
  });

  it.each([false, true])("releases invocation ownership after a synchronous resume failure (background=%s)", async isBackground => {
    const f = fixture();
    const { id, record } = await f.manager.restore(reference(), metadata);
    f.backend.resume.mockImplementationOnce(() => { throw new Error("synchronous resume failure"); });
    await f.manager.resume(id, "fails", undefined, { isBackground });
    await record.promise;
    await f.manager.waitForAll();
    expect(record.status).toBe("error");
    expect(record.error).toBe("synchronous resume failure");
    await f.manager.resume(id, "retry");
    expect(record.result).toBe("fresh answer");
    expect(f.onComplete).toHaveBeenCalledTimes(isBackground ? 1 : 0);
  });
});

describe("malformed restore input and disposed launch guards", () => {
  it.each([undefined, null, 1, "file", [], {}, { ...reference(), sessionId: null }])("rejects malformed reference %j with a curated diagnostic", async ref => {
    const f = fixture();
    await expect(f.manager.restore(ref as any, metadata)).rejects.toThrow(i18n.t("managerRestore.invalidReference"));
    expect(f.backend.reattach).not.toHaveBeenCalled();
    expect(f.manager.listAgents()).toEqual([]);
  });

  it.each([undefined, null, 1, [], {}, { ...metadata, type: null }, { ...metadata, description: 1 }, { ...metadata, name: {} }, { ...metadata, signal: {} }])("rejects malformed options %j before acquisition", async options => {
    const f = fixture();
    await expect(f.manager.restore(reference(), options as any)).rejects.toThrow(i18n.t("managerRestore.invalidOptions"));
    expect(f.backend.reattach).not.toHaveBeenCalled();
    expect(f.manager.listAgents()).toEqual([]);
  });

  it("rejects malformed backend return values without leaking a cleanup rejection", async () => {
    const f = fixture();
    for (const value of [undefined, null, 1, {}]) {
      f.backend.reattach.mockResolvedValueOnce(value as any);
      await expect(f.manager.restore(reference(), metadata)).rejects.toThrow(i18n.t("managerRestore.invalidSession"));
      await flush();
    }
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith({});
    expect(f.manager.listAgents()).toEqual([]);
  });

  it("rejects new launches and restoration after disposal without allocating records", async () => {
    const f = fixture();
    await f.manager.dispose();
    expect(() => f.manager.spawn(pi, ctx, "Explore", "new", { description: "new" })).toThrow(i18n.t("managerRestore.disposed"));
    await expect(f.manager.spawnAndWait(pi, ctx, "Explore", "new", { description: "new" })).rejects.toThrow(i18n.t("managerRestore.disposed"));
    await expect(f.manager.restore(reference(), metadata)).rejects.toThrow(i18n.t("managerRestore.disposed"));
    expect(f.manager.listAgents()).toEqual([]);
    expectNoInvocation(f);
  });

  it("does not dispatch a backend after an onStart callback disposes the manager", async () => {
    const f = fixture();
    let disposing: Promise<void> | undefined;
    f.onStart.mockImplementationOnce(() => { disposing = f.manager.dispose(); });
    const id = f.manager.spawn(pi, ctx, "Explore", "never dispatch", { description: "never dispatch" });
    await disposing;
    expect(f.manager.getRecord(id)).toBeUndefined();
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(f.onComplete).not.toHaveBeenCalled();
  });

  it.each([false, true])("awaits and cleans in-flight worktree startup, including evicted records (evicted=%s)", async evicted => {
    const f = fixture();
    const copy = deferred<Awaited<ReturnType<typeof createWorktree>>>();
    const cleanup = deferred<{ hasChanges: boolean }>();
    const wt = { path: "/test-copy", workPath: "/test-copy", branch: "test", baseSha: "base" };
    vi.mocked(createWorktree).mockReturnValueOnce(copy.promise);
    vi.mocked(cleanupWorktree).mockReturnValueOnce(cleanup.promise);
    const id = f.manager.spawn(pi, ctx, "Explore", "worktree", { description: "worktree", isolation: "worktree" });
    const record = f.manager.getRecord(id)!;
    if (evicted) { f.manager.abort(id); f.manager.clearCompleted(); }
    const done = vi.fn();
    const disposing = f.manager.dispose().then(done);
    await flush();
    expect(done).not.toHaveBeenCalled();
    expect(record.abortController?.signal.aborted).toBe(true);
    copy.resolve(wt);
    await flush();
    expect(cleanupWorktree).toHaveBeenCalledWith(pi, ctx.cwd, wt, "worktree");
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    cleanup.resolve({ hasChanges: false });
    await disposing;
    expect(f.manager.listAgents()).toEqual([]);
    expectNoInvocation(f);
  });

  it("keeps dispatched queued foreground work owned when onSpawned throws", async () => {
    const f = fixture();
    f.manager.setMaxConcurrentForeground(1);
    const first = deferred<ExecutionRunResult>();
    f.backend.run.mockReturnValueOnce(first.promise);
    const blocking = f.manager.spawnAndWait(pi, ctx, "Explore", "first", { description: "first" });
    const onSpawned = vi.fn(() => { throw new Error("observer failed"); });
    const queued = f.manager.spawnAndWait(pi, ctx, "Explore", "second", { description: "second" }, onSpawned);
    expect(f.backend.run).toHaveBeenCalledOnce();
    first.resolve({ session: session(reference("first")), responseText: "first", aborted: false, steered: false });
    await blocking;
    const { record } = await queued;
    await f.manager.waitForAll();
    expect(onSpawned).toHaveBeenCalledOnce();
    expect(record.status).toBe("completed");
    expect(record.result).toBe("second");
    expect(f.manager.getRecord(record.id)).toBe(record);
    expect(f.onComplete).toHaveBeenCalledTimes(2);
    expect((await f.manager.spawnAndWait(pi, ctx, "Explore", "third", { description: "third" })).record.status).toBe("completed");
  });

  it.each([true, false])("shuts down a late fresh handle without attaching it or announcing completion (callback=%s)", async callback => {
    const f = fixture();
    const pending = deferred<ExecutionRunResult>();
    let options!: Parameters<AgentExecutionBackend["run"]>[3];
    f.backend.run.mockImplementationOnce((_ctx, _type, _prompt, args) => { options = args; return pending.promise; });
    const onSessionCreated = vi.fn();
    const id = f.manager.spawn(pi, ctx, "Explore", "preflight", { description: "preflight", onSessionCreated });
    const record = f.manager.getRecord(id)!;
    await f.manager.dispose();
    expect(options.signal?.aborted).toBe(true);
    const handle = session();
    if (callback) {
      options.onSessionCreated?.(handle);
      await flush();
    }
    pending.resolve({ session: handle, responseText: "late", aborted: true, steered: false });
    await record.promise;
    expect(f.backend.shutdown.mock.calls.filter(([target]) => target === handle)).toHaveLength(1);
    expect(record.session).toBeUndefined();
    expect(record.status).toBe("stopped");
    expect(f.manager.listAgents()).toEqual([]);
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(f.onComplete).not.toHaveBeenCalled();
  });

  it("does not reattach an already-closed handle after disposal inside onSessionCreated", async () => {
    const f = fixture();
    let disposing: Promise<void> | undefined;
    let record: ReturnType<AgentManager["getRecord"]>;
    let handle: ExecutionSession | undefined;
    f.manager.spawn(pi, ctx, "Explore", "dispose in callback", {
      description: "dispose in callback",
      onSessionCreated: target => {
        handle = target;
        record = f.manager.listAgents()[0];
        disposing = f.manager.dispose();
      },
    });
    await disposing;
    await record?.promise;
    expect(record?.session).toBeUndefined();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(handle);
    expect(f.onComplete).not.toHaveBeenCalled();
    expect(f.manager.listAgents()).toEqual([]);
  });
});

describe("idle restore UI observations", () => {
  it("shows waiting and historical conversation without running/success/error decoration or leaked child ownership", async () => {
    const f = fixture();
    const { record } = await f.manager.restore(reference(), metadata);
    await f.manager.restore(reference("nested"), { ...metadata, description: "hidden nested", parentAgentId: "parent" });
    await f.manager.restore(reference("workflow"), { ...metadata, description: "hidden workflow", workflowId: "workflow" });
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const tui = { terminal: { rows: 40, columns: 120 }, requestRender: vi.fn() };
    let factory: Parameters<FleetUICtx["setWidget"]>[1];
    const ui: FleetUICtx = {
      setWidget: (_key, content) => { factory = content; },
      onTerminalInput: () => () => {}, getEditorText: () => "", notify: vi.fn(), custom: vi.fn(),
    };
    const fleet = new FleetList(f.manager, new Map());
    const viewer = new ConversationViewer(tui as any, record.session!, record, undefined, theme, vi.fn(),
      undefined, undefined, undefined, false, () => "off");
    try {
      fleet.setUICtx(ui);
      fleet.update();
      const list = factory?.(tui, theme).render(120).join("\n");
      expect(list).toContain(metadata.description);
      expect(list).toContain(i18n.t("product.waitingLabel"));
      expect(list).not.toContain("hidden nested");
      expect(list).not.toContain("hidden workflow");
      const text = viewer.render(120).join("\n");
      expect(text).toContain("historical answer");
      expect(text).toContain(i18n.t("product.waitingLabel"));
      expect(text).toContain("faux/saved-model");
      expect(text).not.toContain("(running)");
      expect(text).not.toContain("✓");
      expect(text).not.toContain("✗");
      expect(text).not.toContain("x stop");
      // The activity widget presents retained ownership as waiting, not as a
      // completed invocation or an active SDK run.
      const widget = new AgentWidget(f.manager, new Map());
      let widgetFactory: any;
      const setWidget = vi.fn((_key: string, content: any) => { if (content) widgetFactory = content; });
      widget.setUICtx({ setWidget, setStatus: vi.fn() });
      widget.update();
      const widgetText = widgetFactory(tui, theme).render().join("\n");
      expect(widgetText).toContain(metadata.description);
      expect(widgetText).toContain(i18n.t("product.waitingLabel"));
      expect(widgetText).not.toContain("thinking…");
      widget.dispose();
    } finally {
      fleet.dispose();
      viewer.dispose();
    }
    expectNoInvocation(f);
  });
});
