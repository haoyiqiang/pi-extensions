import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { RunOptions, RunResult } from "../src/backends/embedded.js";
import type { AgentExecutionBackend } from "../src/backends/types.js";
import type { SubagentType } from "../src/types.js";

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

function session(label: string): AgentSession {
  return {
    label,
    dispose: vi.fn(),
    sessionManager: { getSessionFile: vi.fn(() => `/sessions/${label}.jsonl`) },
  } as unknown as AgentSession;
}

interface RunCall {
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: RunOptions;
  result: Deferred<RunResult>;
  session?: AgentSession;
}

interface ResumeCall {
  session: AgentSession;
  prompt: string;
  options: Parameters<AgentExecutionBackend["resume"]>[2];
  result: Deferred<{ text: string; failure?: string }>;
}

class FakeExecutionBackend implements AgentExecutionBackend {
  readonly kind = "embedded" as const;
  readonly runCalls: RunCall[] = [];
  readonly resumeCalls: ResumeCall[] = [];
  readonly steerCalls: { session: AgentSession; message: string }[] = [];
  readonly shutdownCalls: (AgentSession | undefined)[] = [];
  steerImplementation: (target: AgentSession, message: string) => Promise<void> = async () => {};
  shutdownImplementation: (target: AgentSession | undefined) => Promise<void> = async () => {};

  run(ctx: ExtensionContext, type: SubagentType, prompt: string, options: RunOptions): Promise<RunResult> {
    const result = deferred<RunResult>();
    this.runCalls.push({ ctx, type, prompt, options, result });
    return result.promise;
  }

  resume(
    target: AgentSession,
    prompt: string,
    options?: Parameters<AgentExecutionBackend["resume"]>[2],
  ): Promise<{ text: string; failure?: string }> {
    const result = deferred<{ text: string; failure?: string }>();
    this.resumeCalls.push({ session: target, prompt, options, result });
    return result.promise;
  }

  steer(target: AgentSession, message: string): Promise<void> {
    this.steerCalls.push({ session: target, message });
    return this.steerImplementation(target, message);
  }

  shutdown(target: AgentSession | undefined): Promise<void> {
    this.shutdownCalls.push(target);
    return this.shutdownImplementation(target);
  }

  openSession(index: number, target: AgentSession = session(`run-${index}`)): AgentSession {
    const call = this.runCalls[index];
    if (!call) throw new Error(`Missing run call ${index}`);
    if (!call.session) {
      call.session = target;
      call.options.onSessionCreated?.(target);
    }
    return call.session;
  }

  finishRun(index: number, overrides: Partial<RunResult> = {}): AgentSession {
    const call = this.runCalls[index];
    if (!call) throw new Error(`Missing run call ${index}`);
    const target = this.openSession(index, overrides.session);
    call.result.resolve({
      responseText: `result:${call.prompt}`,
      aborted: false,
      steered: false,
      ...overrides,
      session: target,
    });
    return target;
  }

  finishResume(index: number, result: { text: string; failure?: string }): void {
    const call = this.resumeCalls[index];
    if (!call) throw new Error(`Missing resume call ${index}`);
    call.result.resolve(result);
  }
}

const mockPi = {} as any;
const mockCtx = { cwd: process.cwd() } as ExtensionContext;
const managers: AgentManager[] = [];

function managerWith(
  backend: FakeExecutionBackend,
  options: { maxConcurrent?: number; onComplete?: (record: any) => void } = {},
): AgentManager {
  const manager = new AgentManager(
    options.onComplete,
    options.maxConcurrent,
    undefined,
    undefined,
    undefined,
    backend,
  );
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

describe("AgentManager execution backend seam", () => {
  it("routes fresh and queued spawns through the injected backend and preserves structured results", async () => {
    const backend = new FakeExecutionBackend();
    const manager = managerWith(backend, { maxConcurrent: 1 });
    const structuredOutput = { schema: { type: "object" } } as any;

    const firstId = manager.spawn(mockPi, mockCtx, "general-purpose", "first", {
      description: "first",
      isBackground: true,
    });
    const secondId = manager.spawn(mockPi, mockCtx, "general-purpose", "second", {
      description: "second",
      isBackground: true,
      structuredOutput,
    });

    expect(backend.runCalls.map((call) => call.prompt)).toEqual(["first"]);
    expect(manager.getRecord(secondId)?.status).toBe("queued");

    backend.finishRun(0);
    await manager.getRecord(firstId)?.promise;

    expect(backend.runCalls.map((call) => call.prompt)).toEqual(["first", "second"]);
    expect(backend.runCalls[1].options.structuredOutput).toBe(structuredOutput);

    backend.finishRun(1, {
      responseText: "structured prose",
      structuredJson: '{"answer":42}',
      structuredRetried: true,
    });
    await manager.getRecord(secondId)?.promise;

    expect(manager.getRecord(secondId)).toMatchObject({
      status: "completed",
      result: "structured prose",
      structuredJson: '{"answer":42}',
      structuredRetried: true,
    });
  });

  it("routes foreground and background resumes through the backend with their cancellation signals", async () => {
    const backend = new FakeExecutionBackend();
    const manager = managerWith(backend);
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "seed", {
      description: "seed",
      isBackground: true,
    });
    const target = backend.finishRun(0);
    await manager.getRecord(id)?.promise;

    const foregroundAbort = new AbortController();
    const foreground = manager.resume(id, "foreground", foregroundAbort.signal);
    expect(backend.resumeCalls).toHaveLength(1);
    expect(backend.resumeCalls[0]).toMatchObject({ session: target, prompt: "foreground" });
    expect(backend.resumeCalls[0].options?.signal).toBe(foregroundAbort.signal);

    backend.finishResume(0, { text: "foreground result" });
    await expect(foreground).resolves.toMatchObject({
      status: "completed",
      result: "foreground result",
    });

    const backgroundAbort = new AbortController();
    const background = await manager.resume(id, "background", backgroundAbort.signal, {
      isBackground: true,
    });
    expect(background?.status).toBe("running");
    expect(backend.resumeCalls).toHaveLength(2);
    expect(backend.resumeCalls[1]).toMatchObject({ session: target, prompt: "background" });
    expect(backend.resumeCalls[1].options?.signal).not.toBe(backgroundAbort.signal);
    expect(backend.resumeCalls[1].options?.signal?.aborted).toBe(false);

    backgroundAbort.abort();
    expect(backend.resumeCalls[1].options?.signal?.aborted).toBe(true);
    expect(manager.getRecord(id)?.status).toBe("stopped");

    backend.finishResume(1, { text: "background result" });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)).toMatchObject({
      status: "stopped",
      result: "background result",
    });
  });

  it("flushes pending steering through the backend and exposes actual delivery failures to tool callers", async () => {
    const backend = new FakeExecutionBackend();
    const manager = managerWith(backend);
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "steer me", {
      description: "steer me",
      isBackground: true,
    });

    await expect(manager.steerAndWait(id, "queued correction")).resolves.toBe(true);
    expect(backend.steerCalls).toEqual([]);
    expect(manager.getRecord(id)?.pendingSteers).toEqual(["queued correction"]);

    const target = backend.openSession(0, session("steer-target"));
    expect(backend.steerCalls).toEqual([{ session: target, message: "queued correction" }]);
    expect(manager.getRecord(id)?.pendingSteers).toBeUndefined();

    const deliveryError = new Error("delivery failed");
    backend.steerImplementation = async () => { throw deliveryError; };
    await expect(manager.steerAndWait(id, "tool correction")).rejects.toBe(deliveryError);

    // The interactive UI path remains optimistic and deliberately swallows delivery errors.
    expect(manager.steer(id, "ui correction")).toBe(true);
    await Promise.resolve();
    expect(backend.steerCalls.map((call) => call.message)).toEqual([
      "queued correction",
      "tool correction",
      "ui correction",
    ]);

    backend.finishRun(0);
    await manager.getRecord(id)?.promise;
  });

  it("forwards parent cancellation to a running backend call and aborts queued work before delivery", async () => {
    const backend = new FakeExecutionBackend();
    const manager = managerWith(backend, { maxConcurrent: 1 });
    const runningAbort = new AbortController();
    const queuedAbort = new AbortController();

    const runningId = manager.spawn(mockPi, mockCtx, "general-purpose", "running", {
      description: "running",
      isBackground: true,
      signal: runningAbort.signal,
    });
    const queuedId = manager.spawn(mockPi, mockCtx, "general-purpose", "queued", {
      description: "queued",
      isBackground: true,
      signal: queuedAbort.signal,
    });

    expect(backend.runCalls).toHaveLength(1);
    expect(backend.runCalls[0].options.signal).not.toBe(runningAbort.signal);
    expect(backend.runCalls[0].options.signal?.aborted).toBe(false);
    expect(manager.getRecord(queuedId)?.status).toBe("queued");

    queuedAbort.abort();
    expect(manager.getRecord(queuedId)).toMatchObject({ status: "stopped" });
    expect(backend.runCalls).toHaveLength(1);

    runningAbort.abort();
    expect(backend.runCalls[0].options.signal?.aborted).toBe(true);
    expect(manager.getRecord(runningId)?.status).toBe("stopped");

    backend.finishRun(0);
    await manager.getRecord(runningId)?.promise;
    expect(backend.runCalls).toHaveLength(1);
  });

  it("keeps backend ownership isolated between manager instances, including steer and shutdown", async () => {
    const backendA = new FakeExecutionBackend();
    const backendB = new FakeExecutionBackend();
    const managerA = managerWith(backendA);
    const managerB = managerWith(backendB);

    const idA = managerA.spawn(mockPi, mockCtx, "general-purpose", "from A", {
      description: "from A",
      isBackground: true,
    });
    const idB = managerB.spawn(mockPi, mockCtx, "general-purpose", "from B", {
      description: "from B",
      isBackground: true,
    });
    const sessionA = backendA.openSession(0, session("A"));
    const sessionB = backendB.openSession(0, session("B"));

    await expect(managerA.steerAndWait(idA, "message A")).resolves.toBe(true);
    await expect(managerB.steerAndWait(idB, "message B")).resolves.toBe(true);
    expect(backendA.runCalls.map((call) => call.prompt)).toEqual(["from A"]);
    expect(backendB.runCalls.map((call) => call.prompt)).toEqual(["from B"]);
    expect(backendA.steerCalls).toEqual([{ session: sessionA, message: "message A" }]);
    expect(backendB.steerCalls).toEqual([{ session: sessionB, message: "message B" }]);

    backendA.finishRun(0);
    backendB.finishRun(0);
    await Promise.all([managerA.getRecord(idA)?.promise, managerB.getRecord(idB)?.promise]);
    await Promise.all([managerA.dispose(), managerB.dispose()]);

    expect(backendA.shutdownCalls).toEqual([sessionA]);
    expect(backendB.shutdownCalls).toEqual([sessionB]);
    expect(backendA.shutdownCalls).not.toContain(sessionB);
    expect(backendB.shutdownCalls).not.toContain(sessionA);
  });
});
