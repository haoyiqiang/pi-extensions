import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.js";
import type { ManagedWorkflowSessionContext } from "../src/workflow/execution-contract.js";
import { ConsumerCancellation, deferred, executionFixture, flush, rawBranch } from "./helpers/workflow-execution.js";

const fixtures: ReturnType<typeof executionFixture>[] = [];
function fixture() {
  const f = executionFixture();
  fixtures.push(f);
  return f;
}
const diagnostic = (key: string) => i18n.t(`workflowExecution.${key}`);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.close()));
});

describe("workflow callback settlement regressions", () => {
  it.each(["failure", "aborted failure", "rejection"] as const)("rejects an already-settled forgotten send (%s), not the callback's successful value", async outcome => {
    const f = fixture();
    const host = f.host();
    const reason = "policy or retirement failed despite a normal assistant stop";
    if (outcome === "rejection") f.backend.resume.mockRejectedValueOnce(new Error(reason));
    else f.backend.resume.mockResolvedValueOnce({ text: "apparently successful answer", failure: reason, aborted: outcome === "aborted failure" });
    let escaped!: ManagedWorkflowSessionContext;
    const operation = host.spawnChild({ prompt: "initial", withSession: async child => {
      escaped = child;
      void child.sendUserMessage("forgotten continuation");
      await flush(); // Other callback work lets the rejection clear scope.pending first.
      expect(f.backend.resume).toHaveBeenCalledOnce();
      expect(child.sessionManager.getBranch()).toEqual(rawBranch());
      return "must not be promoted to success";
    } });
    const error = await operation.catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConsumerCancellation);
    expect(error.message).toContain(reason);
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(f.handles[0]);
    expect(escaped.signal?.aborted).toBe(false); // A settled failure is not user cancellation.
    await expect(escaped.sendUserMessage("too late")).rejects.toThrow(diagnostic("closed"));
    expect(() => escaped.sessionManager.getBranch()).toThrow(diagnostic("closed"));
    expect(f.backend.resume).toHaveBeenCalledOnce();
  });

  it.each(["return", "throw"] as const)("cancels a forgotten queued send on callback %s, even while sibling preflight never settles", async exit => {
    const f = fixture();
    const host = f.host({ maxConcurrency: 1 });
    const ready = deferred<ManagedWorkflowSessionContext>();
    const leave = f.gate();
    const routingError = new Error("routing callback failed");
    const sendRejected = vi.fn();
    let forgotten!: Promise<void>;
    const operation = host.spawnChild({ prompt: "owner", withSession: async child => {
      ready.resolve(child);
      await leave.promise;
      forgotten = child.sendUserMessage("queued forgotten send");
      void forgotten.catch(sendRejected);
      if (exit === "throw") throw routingError;
      return "must reject unfinished invocation";
    } });
    const observed = operation.catch(error => error);
    const child = await ready.promise;
    // This run ignores cancellation and never publishes its handle. Only afterEach
    // settles it, so scoped release/disposal must not rely on its eventual completion.
    const opaque = f.blockRun(false);
    const siblingCallback = vi.fn();
    const sibling = host.spawnChild({ prompt: "opaque sibling", withSession: siblingCallback });
    const siblingObserved = sibling.catch(error => error);
    const { options: siblingOptions, session: siblingHandle } = await opaque.started;
    leave.resolve();
    await flush();
    const error = await observed;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConsumerCancellation);
    if (exit === "throw") expect(error).toBe(routingError);
    else expect(error.message).toBe(diagnostic("unfinishedInvocation"));
    expect(sendRejected).toHaveBeenCalledOnce(); // Assert settlement before awaiting: a leak fails rather than hanging.
    expect(sendRejected.mock.calls[0][0]).toBeInstanceOf(ConsumerCancellation);
    await expect(forgotten).rejects.toBeInstanceOf(ConsumerCancellation);
    expect(child.signal?.aborted).toBe(false); // Internal admission cancellation is not user cancellation.
    expect(siblingOptions.signal?.aborted).toBe(false);
    expect(host.signal.aborted).toBe(false);
    expect(f.backend.resume).not.toHaveBeenCalled();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(f.handles[0]);
    expect(f.backend.shutdown).not.toHaveBeenCalledWith(siblingHandle);
    await expect(child.sendUserMessage("escaped send")).rejects.toThrow(diagnostic("closed"));
    await expect(child.waitForIdle()).rejects.toThrow();
    expect(() => child.sessionManager.getBranch()).toThrow(diagnostic("closed"));

    const queuedCallback = vi.fn();
    const queued = host.spawnChild({ prompt: "still bounded", withSession: queuedCallback });
    const queuedObserved = queued.catch(error => error);
    await flush();
    expect(f.backend.run.mock.calls.map(call => call[2])).toEqual(["owner", "opaque sibling"]);
    expect(queuedCallback).not.toHaveBeenCalled();
    await host.dispose();
    expect(await siblingObserved).toBeInstanceOf(ConsumerCancellation);
    expect(await queuedObserved).toBeInstanceOf(ConsumerCancellation);
    expect(sendRejected).toHaveBeenCalledOnce();
    expect(f.backend.resume).not.toHaveBeenCalled();
    expect(siblingCallback).not.toHaveBeenCalled();
    expect(queuedCallback).not.toHaveBeenCalled();
  });

  it.each(["return", "throw"] as const)("preserves callback %s failure and holds a running forgotten send's capacity until real settlement", async exit => {
    const f = fixture();
    const host = f.host({ maxConcurrency: 1 });
    const running = f.blockResume();
    const routingError = new Error("routing failed after starting continuation");
    const sendRejected = vi.fn();
    let forgotten!: Promise<void>;
    let escaped!: ManagedWorkflowSessionContext;
    const operation = host.spawnChild({ prompt: "owner", withSession: async child => {
      escaped = child;
      forgotten = child.sendUserMessage("running forgotten send");
      void forgotten.catch(sendRejected);
      await running.started;
      if (exit === "throw") throw routingError;
      return "must reject unfinished invocation";
    } });
    const observed = operation.catch(error => error);
    const { session, options } = await running.started;
    const error = await observed;
    expect(error).not.toBeInstanceOf(ConsumerCancellation);
    if (exit === "throw") expect(error).toBe(routingError);
    else expect(error.message).toBe(diagnostic("unfinishedInvocation"));
    expect(options.signal?.aborted).toBe(true);
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(session);
    expect(sendRejected).not.toHaveBeenCalled();
    expect(host.signal.aborted).toBe(false);
    await expect(escaped.sendUserMessage("escaped")).rejects.toThrow(diagnostic("closed"));

    const successorCallback = vi.fn(async () => "successor result");
    const successor = host.spawnChild({ prompt: "successor", withSession: successorCallback });
    void successor.catch(() => {});
    await flush();
    expect(f.backend.run).toHaveBeenCalledOnce();
    expect(successorCallback).not.toHaveBeenCalled();
    running.finish({ aborted: true });
    await expect(forgotten).rejects.toThrow(diagnostic("closed"));
    await expect(successor).resolves.toBe("successor result");
    expect(sendRejected).toHaveBeenCalledOnce();
    expect(f.backend.run.mock.calls.map(call => call[2])).toEqual(["owner", "successor"]);
    expect(f.backend.resume).toHaveBeenCalledOnce();
    expect(successorCallback).toHaveBeenCalledOnce();
  });

  it("does not report callback success if external cancellation arrives during scoped cleanup", async () => {
    const f = fixture();
    const host = f.host();
    const controller = new AbortController();
    const cleanup = f.gate();
    let escaped!: ManagedWorkflowSessionContext;
    f.backend.shutdown.mockReturnValueOnce(cleanup.promise);
    const operation = host.spawnChild({ prompt: "initial", signal: controller.signal, withSession: async child => {
      escaped = child;
      return "must not survive external cancellation";
    } });
    const observed = operation.catch(error => error);
    await flush();
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
    await expect(escaped.sendUserMessage("during cleanup")).rejects.toThrow(diagnostic("closed"));
    controller.abort("external cancellation during cleanup");
    cleanup.resolve();
    const error = await observed;
    expect(error).toBeInstanceOf(ConsumerCancellation);
    expect(error.cause).toBe("external cancellation during cleanup");
    expect(f.backend.resume).not.toHaveBeenCalled();
  });

  it("rejects controls from a detached callback that finishes after external cancellation", async () => {
    const f = fixture();
    const host = f.host();
    const controller = new AbortController();
    const ready = deferred<ManagedWorkflowSessionContext>();
    const continueCallback = f.gate();
    const callbackDone = deferred<void>();
    const operation = host.spawnChild({ prompt: "initial", signal: controller.signal, withSession: async child => {
      ready.resolve(child);
      await continueCallback.promise; // Intentionally ignores cancellation until the owner is gone.
      try {
        await expect(child.sendUserMessage("detached send")).rejects.toBeInstanceOf(ConsumerCancellation);
        await expect(child.waitForIdle()).rejects.toBeInstanceOf(ConsumerCancellation);
        expect(() => child.sessionManager.getBranch()).toThrow(ConsumerCancellation);
        callbackDone.resolve();
      } catch (error) { callbackDone.reject(error); }
    } });
    const observed = operation.catch(error => error);
    await ready.promise;
    controller.abort("owner cancelled");
    expect(await observed).toBeInstanceOf(ConsumerCancellation);
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
    continueCallback.resolve();
    await callbackDone.promise;
    expect(f.backend.resume).not.toHaveBeenCalled();
    expect(f.backend.run).toHaveBeenCalledOnce();
  });

  it("rejects external cancellation promptly while separately awaiting known shutdown", async () => {
    const f = fixture();
    const host = f.host();
    const controller = new AbortController();
    const running = f.blockRun();
    const cleanup = f.gate();
    f.backend.shutdown.mockReturnValueOnce(cleanup.promise);
    const callback = vi.fn();
    const cancelled = host.spawnChild({ prompt: "active", signal: controller.signal, withSession: callback });
    const rejected = vi.fn();
    const observed = cancelled.catch(error => { rejected(error); return error; });
    await running.started;
    controller.abort("stop waiting now");
    await flush();
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected.mock.calls[0][0]).toBeInstanceOf(ConsumerCancellation);
    const closed = vi.fn();
    const closing = host.dispose().then(closed);
    await flush();
    expect(closed).not.toHaveBeenCalled();
    cleanup.resolve();
    await closing;
    expect(await observed).toBeInstanceOf(ConsumerCancellation);
    expect(callback).not.toHaveBeenCalled();
  });
});
