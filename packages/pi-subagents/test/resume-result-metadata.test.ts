import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { ExecutionSession } from "../src/backends/session.js";
import type {
  AgentExecutionBackend,
  ExecutionResumeResult,
  ExecutionRunResult,
} from "../src/backends/types.js";
import type { AgentRecord } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const pi = {} as ExtensionAPI;
const ctx = { cwd: process.cwd() } as ExtensionContext;
const previousMetadata = { structuredJson: '{"turn":"previous"}', structuredRetried: true };
const managers: AgentManager[] = [];

async function fixture() {
  // No SDK session or control methods: the result contract must work for any backend.
  const session: ExecutionSession = {
    reference: { backend: "terminal", sessionId: "result-metadata" },
    messages: [],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
    subscribe: () => () => {},
  };
  const firstResult: ExecutionRunResult = {
    session, responseText: "previous prose", aborted: false, steered: false, ...previousMetadata,
  };
  const resumed = deferred<ExecutionResumeResult>();
  const run = vi.fn<AgentExecutionBackend["run"]>(async (_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(session);
    return firstResult;
  });
  const resume = vi.fn<AgentExecutionBackend["resume"]>(() => resumed.promise);
  const backend: AgentExecutionBackend = {
    kind: "terminal",
    run,
    resume,
    steer: async () => {},
    shutdown: async () => {},
  };
  const onComplete = vi.fn();
  const manager = new AgentManager(onComplete, 1, undefined, undefined, undefined, backend);
  managers.push(manager);
  const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", "first", {
    description: "resume metadata",
  });
  expect(record).toMatchObject(previousMetadata);
  onComplete.mockClear();
  return { manager, record, session, run, resume, resumed, firstResult, onComplete };
}

function beginResume(manager: AgentManager, record: AgentRecord, isBackground: boolean) {
  const pending = manager.resume(record.id, "next", undefined, { isBackground });
  return pending.then(async (returned) => {
    expect(returned).toBe(record);
    if (isBackground) await record.promise;
    return returned;
  });
}

function expectNoMetadata(record: AgentRecord) {
  expect(record.structuredJson).toBeUndefined();
  expect(record.structuredRetried).toBeUndefined();
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

it("does not let an older foreground parent listener cancel the next invocation", async () => {
  const { manager, record, resume, resumed } = await fixture();
  const parent = new AbortController();
  const first = manager.resume(record.id, "A", parent.signal);
  manager.abort(record.id);
  const previousController = record.abortController;
  await expect(manager.resume(record.id, "too early")).resolves.toBeUndefined();
  expect(record.abortController).toBe(previousController);
  resumed.resolve({ text: "old partial", aborted: true });
  await first;
  const nextResult = deferred<ExecutionResumeResult>();
  resume.mockImplementationOnce(() => nextResult.promise);
  const second = manager.resume(record.id, "B");
  const nextController = record.abortController!;
  expect(record.status).toBe("running");
  parent.abort();
  expect(nextController.signal.aborted).toBe(false);
  expect(record.status).toBe("running");
  nextResult.resolve({ text: "new result" });
  await second;
  expect(record.result).toBe("new result");
});

describe.each([
  { mode: "foreground", isBackground: false },
  { mode: "background", isBackground: true },
])("$mode resume result metadata", ({ isBackground }) => {
  it("targets the current invocation's abort controller rather than the completed one", async () => {
    const { manager, record, resume, resumed } = await fixture();
    const previous = record.abortController;
    const pending = beginResume(manager, record, isBackground);
    const current = resume.mock.calls[0][2]?.signal;
    expect(current).toBe(record.abortController!.signal);
    expect(current).not.toBe(previous?.signal);
    manager.abort(record.id);
    expect(current?.aborted).toBe(true);
    expect(previous?.signal.aborted).toBe(false);
    resumed.resolve({ text: "partial", aborted: true });
    await pending;
    expect(record.status).toBe("stopped");
  });

  it("forwards live parent cancellation and detaches its listener at settlement", async () => {
    const { manager, record, resume, resumed } = await fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = manager.resume(record.id, "cancel later", controller.signal, { isBackground });
    const current = resume.mock.calls[0][2]?.signal;
    controller.abort();
    expect(current?.aborted).toBe(true);
    resumed.resolve({ text: "stopped" });
    await pending;
    if (isBackground) await record.promise;
    expect(record.status).toBe("stopped");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("forwards an already-aborted parent signal without accepting a successful status", async () => {
    const { manager, record, resume, resumed } = await fixture();
    const controller = new AbortController();
    controller.abort();
    const pending = manager.resume(record.id, "cancelled", controller.signal, { isBackground });
    expect(resume.mock.calls[0][2]?.signal?.aborted).toBe(true);
    resumed.resolve({ text: "must stay stopped" });
    await pending;
    if (isBackground) await record.promise;
    expect(record.status).toBe("stopped");
  });

  it.each([true, false, undefined])("propagates current structured output and structuredRetried=%s", async (structuredRetried) => {
    const { manager, record, session, resume, resumed, onComplete } = await fixture();
    const pending = beginResume(manager, record, isBackground);
    expect(record.status).toBe("running");
    expect(record.result).toBeUndefined();
    expectNoMetadata(record);
    expect(resume.mock.calls[0][0]).toBe(session);

    resumed.resolve({ text: "current prose", structuredJson: '{"turn":"current"}', structuredRetried });
    await pending;
    expect(record).toMatchObject({
      status: "completed",
      result: "current prose",
      structuredJson: '{"turn":"current"}',
      structuredRetried,
    });
    expect(onComplete).toHaveBeenCalledTimes(isBackground ? 1 : 0);
    if (isBackground) expect(onComplete).toHaveBeenCalledWith(record);
  });

  it.each([
    { label: "plain text", result: { text: "normal response" } },
    { label: "empty result", result: { text: "" } },
    { label: "missing structured output", result: { text: "", failure: "No structured result" } },
    { label: "provider failure", result: { text: "partial response", failure: "Provider failed" } },
  ])("clears prior structured metadata for $label", async ({ result }) => {
    const { manager, record, resumed } = await fixture();
    const pending = beginResume(manager, record, isBackground);
    expectNoMetadata(record);
    resumed.resolve(result);
    await pending;
    expectNoMetadata(record);
    expect(record.result).toBe(result.text);
    expect(record.status).toBe(result.failure ? "error" : "completed");
    expect(record.error).toBe(result.failure);
  });

  it("keeps this invocation's retry flag even when its structured result is missing", async () => {
    const { manager, record, resumed } = await fixture();
    const pending = beginResume(manager, record, isBackground);
    resumed.resolve({ text: "partial", failure: "No structured result", structuredRetried: true });
    await pending;
    expect(record).toMatchObject({
      status: "error", result: "partial", error: "No structured result", structuredRetried: true,
    });
    expect(record.structuredJson).toBeUndefined();
  });

  it.each([new Error("Resume rejected"), "Resume rejected"])("clears prior metadata after rejection %s", async (error) => {
    const { manager, record, resumed, onComplete } = await fixture();
    const pending = beginResume(manager, record, isBackground);
    expectNoMetadata(record);
    resumed.reject(error);
    await pending;
    expect(record.status).toBe("error");
    expect(record.error).toBe("Resume rejected");
    expect(record.result).toBeUndefined();
    expectNoMetadata(record);
    expect(onComplete).toHaveBeenCalledTimes(isBackground ? 1 : 0);
  });

  it.each([
    { aborted: false, failure: undefined, steered: false, expected: "completed" },
    { aborted: false, failure: undefined, steered: true, expected: "steered" },
    { aborted: false, failure: "Failed", steered: false, expected: "error" },
    { aborted: false, failure: "Failed", steered: true, expected: "error" },
    { aborted: true, failure: undefined, steered: false, expected: "aborted" },
    { aborted: true, failure: undefined, steered: true, expected: "aborted" },
    { aborted: true, failure: "Failed", steered: false, expected: "aborted" },
    { aborted: true, failure: "Failed", steered: true, expected: "aborted" },
  ])("uses $expected for aborted=$aborted failure=$failure steered=$steered", async ({ expected, ...flags }) => {
    const { manager, record, resumed } = await fixture();
    const pending = beginResume(manager, record, isBackground);
    resumed.resolve({ text: "partial", ...flags, structuredJson: '{"partial":true}', structuredRetried: true });
    await pending;
    expect(record).toMatchObject({
      status: expected,
      result: "partial",
      structuredJson: '{"partial":true}',
      structuredRetried: true,
    });
    expect(record.error).toBe(flags.failure);
  });

  it.each([
    { text: "finished despite stop" },
    { text: "partial", aborted: true, failure: "Failed", steered: true },
  ])("preserves external stopped status when a result settles: %j", async (result) => {
    const { manager, record, resumed } = await fixture();
    const pending = beginResume(manager, record, isBackground);
    expect(manager.abort(record.id)).toBe(true);
    // Distinct timestamp pins preservation without timers or clock races.
    record.completedAt = 123;
    resumed.resolve({ ...result, structuredJson: '{"current":true}', structuredRetried: false });
    await pending;
    expect(record).toMatchObject({
      status: "stopped",
      completedAt: 123,
      result: result.text,
      structuredJson: '{"current":true}',
      structuredRetried: false,
    });
    expect(record.error).toBe("failure" in result ? result.failure : undefined);
  });

  it("preserves external stopped status after a rejection without reviving old metadata", async () => {
    const { manager, record, resumed } = await fixture();
    const pending = beginResume(manager, record, isBackground);
    expect(manager.abort(record.id)).toBe(true);
    record.completedAt = 123;
    resumed.reject(new Error("Canceled run rejected"));
    await pending;
    expect(record).toMatchObject({ status: "stopped", completedAt: 123 });
    expectNoMetadata(record);
  });
});

describe("queued resume result metadata", () => {
  it.each([false, true])("clears metadata on acceptance before starting (stopped while queued: %s)", async (stopQueued) => {
    const { manager, record, run, resume, resumed, firstResult } = await fixture();
    const blocker = deferred<ExecutionRunResult>();
    run.mockImplementationOnce(() => blocker.promise);
    const blockerId = manager.spawn(pi, ctx, "general-purpose", "block", {
      description: "occupy background slot", isBackground: true,
    });
    const onStarted = vi.fn(() => { expectNoMetadata(record); });
    const returned = await manager.resume(record.id, "queued follow-up", undefined, { isBackground: true, onStarted });
    expect(returned).toBe(record);
    expect(record.status).toBe("queued");
    expectNoMetadata(record);
    expect(resume).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();

    if (stopQueued) expect(manager.abort(record.id)).toBe(true);
    blocker.resolve(firstResult);
    await manager.getRecord(blockerId)!.promise;
    if (stopQueued) {
      expect(record.status).toBe("stopped");
      expect(resume).not.toHaveBeenCalled();
      expect(onStarted).not.toHaveBeenCalled();
      expectNoMetadata(record);
    } else {
      expect(record.status).toBe("running");
      expect(onStarted).toHaveBeenCalledOnce();
      resumed.resolve({ text: "queued result", structuredJson: '{"queued":true}', structuredRetried: true });
      await record.promise;
      expect(record).toMatchObject({
        status: "completed", result: "queued result", structuredJson: '{"queued":true}', structuredRetried: true,
      });
    }
  });

  it.each([
    { currentStatus: "running" as const, isBackground: true }, { currentStatus: "queued" as const, isBackground: true },
    { currentStatus: "running" as const, isBackground: false }, { currentStatus: "queued" as const, isBackground: false },
  ])("does not clear metadata for a refused $currentStatus resume (background=$isBackground)", async ({ currentStatus, isBackground }) => {
    const { manager, record, resume } = await fixture();
    record.status = currentStatus;
    const before = { ...record };
    expect(await manager.resume(record.id, "refused", undefined, { isBackground })).toBeUndefined();
    expect(record).toEqual(before);
    expect(resume).not.toHaveBeenCalled();
  });
});
