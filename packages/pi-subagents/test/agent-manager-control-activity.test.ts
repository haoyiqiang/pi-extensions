import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { ExecutionSession } from "../src/backends/session.js";
import type { AgentExecutionBackend, ExecutionResumeResult, ExecutionRunOptions, ExecutionRunResult } from "../src/backends/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface Job {
  session: ExecutionSession;
  options: ExecutionRunOptions;
  started: ReturnType<typeof deferred<void>>;
  result: ReturnType<typeof deferred<ExecutionRunResult>>;
}

function createHarness() {
  const jobs = new Map<string, Job>();
  const bySession = new Map<ExecutionSession, Job>();
  const retirement = new Map<ExecutionSession, ReturnType<typeof deferred<void>>>();

  const backend: AgentExecutionBackend = {
    kind: "terminal",
    run: vi.fn(async (_ctx, _type, _prompt, options) => {
      const session: ExecutionSession = {
        reference: {
          backend: "terminal",
          sessionId: options.agentId!,
          sessionFile: join(tmpdir(), "manager-activity", `${options.agentId}.jsonl`),
        },
        messages: [],
        getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
        subscribe: () => () => {},
      };
      const job: Job = { session, options, started: deferred<void>(), result: deferred<ExecutionRunResult>() };
      jobs.set(options.agentId!, job);
      bySession.set(session, job);
      options.onSessionCreated?.(session);
      await options.acquireExecution?.(options.signal!);
      job.started.resolve();
      const onAbort = () => job.result.resolve({
        session,
        responseText: "cancelled",
        aborted: true,
        steered: false,
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      try { return await job.result.promise; }
      finally { options.signal?.removeEventListener("abort", onAbort); }
    }),
    resume: vi.fn(async (session, prompt, options) => {
      await options?.acquireExecution?.(options.signal!);
      const result: ExecutionResumeResult = { text: `resumed:${prompt}` };
      options?.onExecutionIdle?.(result);
      return result;
    }),
    steer: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    shutdown: vi.fn(async session => {
      if (!session) return;
      const gate = retirement.get(session);
      if (gate) await gate.promise;
      const job = bySession.get(session);
      job?.result.resolve({ session, responseText: job.options.signal?.aborted ? "cancelled" : "closed", aborted: !!job.options.signal?.aborted, steered: false });
    }),
  };

  return {
    backend,
    job(id: string) {
      const job = jobs.get(id);
      if (!job) throw new Error(`missing job ${id}`);
      return job;
    },
    delayRetirement(session: ExecutionSession) {
      const gate = deferred<void>();
      retirement.set(session, gate);
      return gate;
    },
    finishAll() {
      for (const gate of retirement.values()) gate.resolve();
      for (const job of jobs.values()) {
        job.result.resolve({ session: job.session, responseText: "finished", aborted: true, steered: false });
      }
    },
  };
}

const pi = {} as ExtensionAPI;
const ctx = { cwd: process.cwd() } as ExtensionContext;
const cleanup: { manager: AgentManager; finish: () => void }[] = [];

function fixture(maxConcurrent = 1) {
  const harness = createHarness();
  const manager = new AgentManager(undefined, maxConcurrent, undefined, undefined, undefined, harness.backend);
  cleanup.push({ manager, finish: harness.finishAll });
  return { manager, ...harness };
}

afterEach(async () => {
  const items = cleanup.splice(0);
  for (const item of items) item.finish();
  await Promise.all(items.map(item => item.manager.dispose()));
});

describe("AgentManager execution activity", () => {
  it("charges the first SDK acquire once, releases on idle, and aborts a queued reacquire without leaking the pool", async () => {
    const { manager, job } = fixture(1);
    const first = manager.spawn(pi, ctx, "Explore", "first", { description: "first", isBackground: true });
    await job(first).started.promise;

    const sibling = manager.spawn(pi, ctx, "Explore", "sibling", { description: "sibling", isBackground: true });
    expect(manager.getRecord(sibling)).toMatchObject({ status: "queued", activity: "queued" });

    job(first).options.onExecutionIdle?.({ text: "first round" });
    await job(sibling).started.promise;
    expect(manager.getRecord(first)).toMatchObject({ status: "running", activity: "idle", result: "first round" });
    expect(manager.getRecord(sibling)).toMatchObject({ status: "running", activity: "active" });

    const request = new AbortController();
    const reacquire = job(first).options.acquireExecution!(request.signal);
    await flush();
    expect(manager.getRecord(first)?.activity).toBe("queued");
    request.abort("round cancelled while queued");
    await expect(reacquire).rejects.toMatchObject({ name: "AbortError" });
    expect(manager.getRecord(first)?.activity).toBe("idle");

    job(sibling).options.onExecutionIdle?.({ text: "sibling idle" });
    await Promise.all([manager.close(first), manager.close(sibling)]);
  });

  it("resumes a live idle persistent session without replacing its job cleanup barrier", async () => {
    const { manager, backend, job, delayRetirement } = fixture(1);
    const id = manager.spawn(pi, ctx, "Explore", "open", { description: "open", isBackground: true });
    await job(id).started.promise;
    const record = manager.getRecord(id)!;
    const originalJob = record.promise;
    job(id).options.onExecutionIdle?.({ text: "initial" });

    await expect(manager.resume(id, "next round")).resolves.toBe(record);
    expect(backend.resume).toHaveBeenCalledExactlyOnceWith(
      record.session,
      "next round",
      expect.objectContaining({ acquireExecution: expect.any(Function), onExecutionIdle: expect.any(Function) }),
    );
    expect(record.promise).toBe(originalJob);
    expect(record).toMatchObject({ status: "running", activity: "idle", result: "resumed:next round" });

    const gate = delayRetirement(record.session!);
    const firstClose = manager.close(id);
    const secondClose = manager.close(id);
    expect(secondClose).toBe(firstClose);
    await flush();
    expect(manager.getRecord(id)).toBe(record);
    gate.resolve();
    await expect(firstClose).resolves.toBe(true);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("interrupts only an active SDK round", async () => {
    const { manager, backend, job } = fixture(1);
    const id = manager.spawn(pi, ctx, "Explore", "active", { description: "active", isBackground: true });
    await job(id).started.promise;
    await expect(manager.control(id, { action: "interrupt" })).resolves.toBe(true);
    expect(backend.interrupt).toHaveBeenCalledExactlyOnceWith(manager.getRecord(id)?.session);

    job(id).options.onExecutionIdle?.({ text: "waiting" });
    await expect(manager.interrupt(id)).resolves.toBe(false);
    expect(backend.interrupt).toHaveBeenCalledOnce();
    await manager.close(id);
  });

  it("keeps a failed close record owned, quarantined, and diagnosable", async () => {
    const { manager, backend, job } = fixture(1);
    const id = manager.spawn(pi, ctx, "Explore", "uncertain", { description: "uncertain", isBackground: true });
    await job(id).started.promise;
    const record = manager.getRecord(id)!;
    const failure = new Error("retirement unconfirmed");
    vi.mocked(backend.shutdown).mockRejectedValueOnce(failure);

    await expect(manager.close(id)).rejects.toBe(failure);
    expect(manager.getRecord(id)).toBe(record);
    expect(record).toMatchObject({ status: "error", error: "retirement unconfirmed" });
    await expect(manager.resume(id, "must stay quarantined")).resolves.toBeUndefined();
  });

  it("cancels an owned tree through the job barrier, retains handles, and resumes the same id", async () => {
    const { manager, backend, job } = fixture(2);
    const parent = manager.spawn(pi, ctx, "Explore", "parent", { description: "parent", isBackground: true });
    await job(parent).started.promise;
    const child = manager.spawn(pi, ctx, "Explore", "child", {
      description: "child",
      isBackground: true,
      parentAgentId: parent,
      depth: 2,
    });
    await job(child).started.promise;
    const parentRecord = manager.getRecord(parent)!;
    const childRecord = manager.getRecord(child)!;
    const parentSession = parentRecord.session;
    const childSession = childRecord.session;

    const cancelled = manager.control(parent, { action: "cancel" });
    await flush();
    expect(parentRecord.status).toBe("stopped");
    expect(childRecord.status).toBe("stopped");
    expect(manager.getRecord(parent)).toBe(parentRecord);
    expect(manager.getRecord(child)).toBe(childRecord);

    await expect(cancelled).resolves.toBe(true);
    expect(backend.shutdown).not.toHaveBeenCalled();
    expect(parentRecord.session).toBe(parentSession);
    expect(childRecord.session).toBe(childSession);

    await expect(manager.resume(parent, "continue after cancel")).resolves.toBe(parentRecord);
    expect(backend.resume).toHaveBeenCalledWith(parentSession, "continue after cancel", expect.any(Object));
    expect(parentRecord).toMatchObject({ status: "completed", result: "resumed:continue after cancel" });
    await expect(manager.cancel(parent)).resolves.toBe(false);
    await expect(manager.close(parent)).resolves.toBe(true);
    expect(manager.getRecord(parent)).toBeUndefined();
    expect(manager.getRecord(child)).toBeUndefined();
  });

  it("ignores an idle callback from an execution state superseded by resume", async () => {
    const { manager, job } = fixture(1);
    const id = manager.spawn(pi, ctx, "Explore", "old", { description: "old", isBackground: true });
    await job(id).started.promise;
    const staleIdle = job(id).options.onExecutionIdle!;
    job(id).result.resolve({ session: job(id).session, responseText: "old result", aborted: false, steered: false });
    await manager.getRecord(id)!.promise;

    const record = await manager.resume(id, "new result");
    expect(record).toMatchObject({ status: "completed", activity: "idle", result: "resumed:new result" });
    staleIdle({ text: "stale result" });
    expect(record).toMatchObject({ status: "completed", activity: "idle", result: "resumed:new result" });
    await manager.close(id);
  });

  it("forwards the invocation runtime policy to execution.run", async () => {
    const { manager, job } = fixture(1);
    const runtimePolicy = {
      configCwd: ctx.cwd,
      projectTrusted: false,
      settings: {},
      defaultMaxTurns: 0,
      graceTurns: 5,
      rememberAgents: true,
      outputTranscript: true,
      scopeModels: false,
      worktreeIsolation: false,
      maxSubagentDepth: 2,
    } as const;
    const id = manager.spawn(pi, ctx, "Explore", "policy", {
      description: "policy",
      isBackground: true,
      runtimePolicy,
    });
    await job(id).started.promise;
    expect(job(id).options.runtimePolicy).toBe(runtimePolicy);
    await manager.close(id);
  });
});
