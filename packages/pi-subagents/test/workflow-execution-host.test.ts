import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionBackend, ExecutionRestoreOptions } from "../src/backends/types.js";
import type { ExecutionSession } from "../src/backends/session.js";
import { i18n } from "../src/i18n.js";
import { setScopeModelsEnabled } from "../src/model-scope.js";
import {
  WORKFLOW_EXECUTION_CAPABILITIES, type ManagedWorkflowSessionContext, type WorkflowChildOptions,
  type WorkflowModelSelection, type WorkflowSessionContext,
} from "../src/workflow/execution-contract.js";
import { ExecutionSemaphore } from "../src/workflow/execution-semaphore.js";
import { ConsumerCancellation, deferred, executionFixture, flush, rawBranch } from "./helpers/workflow-execution.js";

const fixtures: ReturnType<typeof executionFixture>[] = [];
function fixture() {
  const f = executionFixture();
  fixtures.push(f);
  return f;
}
const diagnostic = (key: string) => i18n.t(`workflowExecution.${key}`);
const call = <T>(fn: () => T) => Promise.resolve().then(fn);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.close()));
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setScopeModelsEnabled(false);
});

describe("workflow execution identity and completion", () => {
  it("waits for the actual fresh run promise, not onSessionCreated or a normal assistant stop", async () => {
    const f = fixture();
    const host = f.host();
    const run = f.blockRun();
    const withSession = vi.fn(async (child: WorkflowSessionContext) => {
      expect(child.sessionManager.getBranch()).toEqual(rawBranch());
      return "callback result";
    });
    const operation = host.spawnChild({ prompt: "first turn", withSession });
    const { session, options } = await run.started;
    expect(session.getBranch!()).toEqual(rawBranch());
    expect(options).toMatchObject({ isolated: true, inheritContext: false, cwd: f.root });
    expect(options.agentId).not.toBe(session.reference.sessionId);
    await flush();
    expect(withSession).not.toHaveBeenCalled();
    expect(f.backend.shutdown).not.toHaveBeenCalled();
    run.finish();
    await expect(operation).resolves.toBe("callback result");
    expect(withSession).toHaveBeenCalledOnce();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(session);
    expect(f.observer.spawnChild).not.toHaveBeenCalled();
    expect(f.pi.exec).not.toHaveBeenCalled();
  });

  it.each(["fresh", "reattach", "fork"] as const)("preserves exact persistent identity and detached raw envelopes for %s", async mode => {
    const f = fixture();
    const source = f.seed({ id: "saved-exact-id", file: join(f.root, "previous", "unrelated-filename.jsonl") });
    const original = structuredClone(source.branch);
    const host = f.host();
    await host.spawnChild({ prompt: mode === "fresh" ? "first turn" : "/ignored-restoration-prompt",
      ...(mode === "fresh" ? {} : { [mode]: { sessionFile: source.reference.sessionFile } }),
      withSession: async child => {
        const managed = child as ManagedWorkflowSessionContext;
        const handle = f.handles.at(-1)!;
        expect(managed.reference).toEqual(handle.reference);
        expect(Object.isFrozen(managed.reference)).toBe(true);
        expect(child.sessionManager.getSessionId()).toBe(handle.reference.sessionId);
        expect(child.sessionManager.getSessionFile()).toBe(handle.reference.sessionFile);
        if (mode === "reattach") expect(managed.reference).toEqual(source.reference);
        else {
          expect(managed.reference.sessionId).not.toBe(source.reference.sessionId);
          expect(managed.reference.sessionFile).not.toBe(source.reference.sessionFile);
          expect(managed.reference.sessionFile.startsWith(f.sessionDir)).toBe(true);
        }
        const branch = child.sessionManager.getBranch() as ReturnType<typeof rawBranch>;
        expect(branch).toEqual(original);
        expect(branch).not.toBe(handle.getBranch!());
        expect(branch).not.toEqual(handle.messages);
        expect(branch.map(entry => entry.type)).toEqual(["message", "message", "message", "compaction", "context_edit", "custom"]);
        branch[2].message!.content = "consumer mutation";
        branch[5].data!.nested.push("consumer mutation");
        branch.splice(0, 1);
        expect(child.sessionManager.getBranch()).toEqual(original);
        expect(handle.getBranch!()).toEqual(original);
        expect(f.backend.resume).not.toHaveBeenCalled();
        expect(f.backend.run).toHaveBeenCalledTimes(mode === "fresh" ? 1 : 0);
        if (mode !== "fresh") {
          expect(f.backend[mode]).toHaveBeenCalledExactlyOnceWith(source.reference, expect.objectContaining({ ctx: expect.objectContaining({ cwd: f.root, modelRegistry: f.ctx.modelRegistry }), signal: expect.any(AbortSignal) }));
          await child.sendUserMessage("explicit next turn");
          expect(f.backend.resume).toHaveBeenCalledExactlyOnceWith(handle, "explicit next turn", expect.objectContaining({ signal: expect.any(AbortSignal) }));
        }
      },
    });
    expect(f.snapshots.get(source.reference.sessionFile)!.branch).toEqual(original);
    expect(f.backend.steer).not.toHaveBeenCalled();
  });

  it("advertises the narrow immutable contract and refuses nested child controls", async () => {
    const f = fixture();
    const host = f.host({ maxConcurrency: 1 });
    expect(host.capabilities).toBe(WORKFLOW_EXECUTION_CAPABILITIES);
    expect(Object.isFrozen(host.capabilities)).toBe(true);
    expect(host.capabilities).toMatchObject({ managedSessionsOnly: true, rawBranch: true, nestedChildren: false, toolTimeoutRecovery: false });
    await host.spawnChild({ prompt: "plain", withSession: async child => {
      expect(child.maxConcurrency).toBe(1);
      expect(child.toolTimeout).toBeUndefined();
      expect(child.resetToolTimeout).toBeUndefined();
      await expect(child.spawnChild({ prompt: "nested", withSession: async () => {} })).rejects.toThrow(diagnostic("nestedUnsupported"));
    } });
    expect(f.backend.run).toHaveBeenCalledOnce();
  });

  it.each(["missing", "projected-object"] as const)("fails closed for a %s raw branch port and releases the handle", async shape => {
    const f = fixture();
    const host = f.host();
    f.backend.run.mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      const session = f.fresh(options);
      if (shape === "missing") delete session.getBranch;
      else session.getBranch = () => ({ messages: [] }) as unknown as ReturnType<NonNullable<ExecutionSession["getBranch"]>>;
      options.onSessionCreated?.(session);
      return f.result(session);
    });
    const withSession = vi.fn();
    await expect(host.spawnChild({ prompt: "plain", withSession })).rejects.toThrow(diagnostic("invalidSession"));
    expect(withSession).not.toHaveBeenCalled();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(f.handles[0]);
  });

  it.each(["fresh", "resume"] as const)("does not infer %s success from an assistant stop when backend reports both abort and failure", async mode => {
    const f = fixture();
    const host = f.host();
    const callback = vi.fn();
    if (mode === "fresh") {
      f.backend.run.mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
        const session = f.fresh(options);
        options.onSessionCreated?.(session);
        return f.result(session, { aborted: true, failure: "retirement unconfirmed" });
      });
      await expect(host.spawnChild({ prompt: "plain", withSession: callback })).rejects.toThrow("retirement unconfirmed");
      expect(callback).not.toHaveBeenCalled();
    } else {
      f.backend.resume.mockResolvedValueOnce({ text: "apparently normal answer", aborted: true, failure: "retirement unconfirmed" });
      await expect(host.spawnChild({ prompt: "plain", withSession: async child => {
        expect(child.sessionManager.getBranch()).toEqual(rawBranch());
        await child.sendUserMessage("next");
        callback();
      } })).rejects.toThrow("retirement unconfirmed");
      expect(callback).not.toHaveBeenCalled();
    }
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
  });
});

describe("invocation capacity, not callback capacity", () => {
  it("bounds fresh calls and grants queued work while completed callbacks remain held", async () => {
    const f = fixture();
    const host = f.host({ maxConcurrency: 2 });
    const first = f.blockRun();
    const second = f.blockRun();
    const third = f.blockRun();
    const callbacks = vi.fn(async () => { await held.promise; });
    const held = f.gate();
    const operations = Promise.all(["one", "two", "three"].map(prompt => host.spawnChild({ prompt, withSession: callbacks })));
    void operations.catch(() => {});
    await Promise.all([first.started, second.started]);
    await flush();
    expect(f.backend.run).toHaveBeenCalledTimes(2);
    first.finish();
    await third.started;
    await flush();
    expect(callbacks).toHaveBeenCalledOnce();
    expect(f.backend.shutdown).not.toHaveBeenCalled();
    second.finish();
    third.finish();
    await host.waitForIdle();
    await flush();
    expect(callbacks).toHaveBeenCalledTimes(3);
    held.resolve();
    await operations;
    expect(f.backend.shutdown).toHaveBeenCalledTimes(3);
  });

  it("uses the same limit for fresh and resumed calls, including a queued send", async () => {
    const f = fixture();
    const host = f.host({ maxConcurrency: 1 });
    const ready = deferred<WorkflowSessionContext>();
    const held = f.gate();
    const adopted = host.spawnChild({ prompt: "ignored", reattach: { sessionFile: f.seed().reference.sessionFile },
      withSession: async child => { ready.resolve(child); await held.promise; } });
    const child = await ready.promise;
    const running = f.blockRun();
    const resume = f.blockResume();
    const next = f.blockRun();
    const fresh = host.spawnChild({ prompt: "fresh", withSession: async () => { await held.promise; } });
    await running.started;
    const sending = child.sendUserMessage("queued resume");
    const queued = host.spawnChild({ prompt: "next fresh", withSession: async () => {} });
    await flush();
    expect(f.backend.resume).not.toHaveBeenCalled();
    expect(f.backend.run).toHaveBeenCalledOnce();
    await expect(child.sendUserMessage("second queued send")).rejects.toThrow(diagnostic("busy"));
    running.finish();
    const resumed = await resume.started;
    expect(resumed.prompt).toBe("queued resume");
    expect(f.backend.run).toHaveBeenCalledOnce();
    resume.finish();
    await sending;
    await next.started;
    next.finish();
    await queued;
    held.resolve();
    await Promise.all([adopted, fresh]);
    expect(f.backend.steer).not.toHaveBeenCalled();
  });

  it("releases capacity before recursive root stage routing at maxConcurrency=1", async () => {
    const f = fixture();
    const host = f.host({ maxConcurrency: 1 });
    const visited: number[] = [];
    async function stage(index: number): Promise<number> {
      return host.spawnChild({ prompt: `stage ${index}`, withSession: async child => {
        visited.push(index);
        await child.sendUserMessage(`finish ${index}`);
        return index < 3 ? stage(index + 1) : index;
      } });
    }
    await expect(stage(0)).resolves.toBe(3);
    expect(visited).toEqual([0, 1, 2, 3]);
    expect(f.backend.run).toHaveBeenCalledTimes(4);
    expect(f.backend.resume).toHaveBeenCalledTimes(4);
    expect(f.backend.shutdown).toHaveBeenCalledTimes(4);
  });

  it.each(["fresh", "reattach"] as const)("pins callback-held %s records across GC and permits owned-source fork at capacity one", async mode => {
    vi.useFakeTimers();
    const f = fixture();
    const host = f.host({ maxConcurrency: 1 });
    await host.spawnChild({ prompt: "source", ...(mode === "reattach" ? { reattach: { sessionFile: f.seed().reference.sessionFile } } : {}),
      withSession: async source => {
        const reference = (source as ManagedWorkflowSessionContext).reference;
        const sourceHandle = f.handles.at(-1)!;
        await vi.advanceTimersByTimeAsync(12 * 60_000);
        expect(f.backend.shutdown).not.toHaveBeenCalled();
        await source.sendUserMessage("still retained");
        await host.spawnChild({ prompt: "ignored", fork: { sessionFile: reference.sessionFile }, withSession: async fork => {
          expect(f.backend.shutdown).not.toHaveBeenCalled();
          expect(fork.sessionManager.getSessionId()).not.toBe(reference.sessionId);
          expect(fork.sessionManager.getBranch()).toEqual(source.sessionManager.getBranch());
          await fork.sendUserMessage("fork next");
        } });
        expect(f.backend.fork).toHaveBeenCalledExactlyOnceWith(reference, expect.objectContaining({ ctx: expect.objectContaining({ cwd: f.root, modelRegistry: f.ctx.modelRegistry }) }));
        expect(f.backend.shutdown).not.toHaveBeenCalledWith(sourceHandle);
        await source.sendUserMessage("source still usable");
      },
    });
    expect(f.backend.shutdown).toHaveBeenCalledTimes(2);
  });

  it("child waitForIdle tracks only its own latest call, not a sibling or root observer", async () => {
    const f = fixture();
    const host = f.host({ maxConcurrency: 2 });
    const ready = deferred<WorkflowSessionContext>();
    const held = f.gate();
    const owned = host.spawnChild({ prompt: "first", withSession: async child => { ready.resolve(child); await held.promise; } });
    const child = await ready.promise;
    const siblingRun = f.blockRun();
    const sibling = host.spawnChild({ prompt: "sibling", withSession: async () => {} });
    await siblingRun.started;
    await child.waitForIdle();
    const resume = f.blockResume();
    const sent = child.sendUserMessage("second");
    await resume.started;
    const childDone = vi.fn();
    const rootDone = vi.fn();
    const idle = child.waitForIdle().then(childDone);
    const allIdle = host.waitForIdle().then(rootDone);
    await flush();
    expect(childDone).not.toHaveBeenCalled();
    resume.finish();
    await sent;
    await idle;
    expect(childDone).toHaveBeenCalledOnce();
    expect(rootDone).not.toHaveBeenCalled();
    expect(f.observer.waitForIdle).not.toHaveBeenCalled();
    siblingRun.finish();
    await sibling;
    await allIdle;
    held.resolve();
    await owned;
  });
});

describe("child scope ownership", () => {
  it("rejects concurrent sends explicitly without steering and closes escaped controls", async () => {
    const f = fixture();
    const host = f.host();
    let escaped!: WorkflowSessionContext;
    await host.spawnChild({ prompt: "first", withSession: async child => {
      escaped = child;
      const resume = f.blockResume();
      const sending = child.sendUserMessage("one");
      await resume.started;
      await expect(child.sendUserMessage("two")).rejects.toThrow(diagnostic("busy"));
      expect(() => child.sessionManager.getBranch()).toThrow(diagnostic("busy"));
      expect(f.backend.resume).toHaveBeenCalledOnce();
      expect(f.backend.steer).not.toHaveBeenCalled();
      resume.finish();
      await sending;
      await child.sendUserMessage("three");
    } });
    await expect(call(() => escaped.sendUserMessage("escaped"))).rejects.toThrow(diagnostic("closed"));
    await expect(escaped.waitForIdle()).rejects.toThrow(diagnostic("closed"));
    expect(() => escaped.sessionManager.getBranch()).toThrow(diagnostic("closed"));
    await expect(escaped.spawnChild({ prompt: "escaped", withSession: async () => {} })).rejects.toThrow();
    expect(f.backend.resume).toHaveBeenCalledTimes(2);
  });

  it("rejects callback success with an unawaited pending send and cancels only that child", async () => {
    const f = fixture();
    const host = f.host();
    const ready = deferred<WorkflowSessionContext>();
    const held = f.gate();
    const sibling = host.spawnChild({ prompt: "sibling", withSession: async child => { ready.resolve(child); await held.promise; } });
    const siblingChild = await ready.promise;
    const resume = f.blockResume();
    let pending!: Promise<void>;
    const operation = host.spawnChild({ prompt: "first", withSession: async child => {
      pending = child.sendUserMessage("unawaited");
      void pending.catch(() => {});
      await resume.started;
      return "not a valid success";
    } });
    const { options, session } = await resume.started;
    await expect(operation).rejects.toThrow(diagnostic("unfinishedInvocation"));
    expect(options?.signal?.aborted).toBe(true);
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(session);
    expect(siblingChild.signal?.aborted).toBe(false);
    resume.finish({ aborted: true });
    await expect(pending).rejects.toThrow();
    await siblingChild.sendUserMessage("sibling remains usable");
    held.resolve();
    await sibling;
  });

  it("preserves callback errors while awaiting cleanup, independently of another child", async () => {
    const f = fixture();
    const host = f.host();
    const closed = f.gate();
    const ready = deferred<WorkflowSessionContext>();
    const held = f.gate();
    const sibling = host.spawnChild({ prompt: "sibling", withSession: async child => { ready.resolve(child); await held.promise; } });
    const child = await ready.promise;
    const error = new Error("routing failed");
    f.backend.shutdown.mockReturnValueOnce(closed.promise);
    const failing = host.spawnChild({ prompt: "failing", withSession: async () => { throw error; } });
    const caught = vi.fn();
    const observed = failing.catch(caught);
    await flush();
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
    expect(caught).not.toHaveBeenCalled();
    await child.sendUserMessage("independent");
    closed.resolve();
    await observed;
    expect(caught).toHaveBeenCalledExactlyOnceWith(error);
    held.resolve();
    await sibling;
  });
});

describe("cancellation and late handles", () => {
  it("uses the consumer's nominal error for a pre-aborted child without launch", async () => {
    const f = fixture();
    const host = f.host();
    const controller = new AbortController();
    controller.abort("pre-cancelled");
    const withSession = vi.fn();
    await expect(host.spawnChild({ prompt: "first", signal: controller.signal, withSession })).rejects.toMatchObject({
      constructor: ConsumerCancellation, cause: "pre-cancelled",
    });
    expect(withSession).not.toHaveBeenCalled();
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(f.backend.reattach).not.toHaveBeenCalled();
  });

  it.each(["run", "observer"] as const)("rejects a pre-aborted %s before any child launch", async origin => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort("already cancelled");
    if (origin === "observer") f.observer.signal = controller.signal;
    const host = f.host(origin === "run" ? { signal: controller.signal } : {});
    await expect(call(() => host.spawnChild({ prompt: "plain", withSession: async () => {} })))
      .rejects.toMatchObject({ constructor: ConsumerCancellation, cause: "already cancelled" });
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(f.backend.inspect).not.toHaveBeenCalled();
    expect(f.find).not.toHaveBeenCalled();
  });

  it("propagates per-child cancellation to an active resume without aborting the root", async () => {
    const f = fixture();
    const host = f.host();
    const controller = new AbortController();
    const resume = f.blockResume();
    let sending!: Promise<void>;
    const operation = host.spawnChild({ prompt: "first", signal: controller.signal, withSession: async child => {
      sending = child.sendUserMessage("active resume");
      await sending;
    } });
    const rejected = expect(operation).rejects.toBeInstanceOf(ConsumerCancellation);
    const { session, options } = await resume.started;
    controller.abort("cancel this child only");
    await rejected;
    expect(options?.signal?.aborted).toBe(true);
    expect(host.signal.aborted).toBe(false);
    resume.finish({ aborted: true });
    await expect(sending).rejects.toMatchObject({ constructor: ConsumerCancellation, cause: "cancel this child only" });
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(session);
    await host.spawnChild({ prompt: "independent child", withSession: async child => { await child.sendUserMessage("still works"); } });
  });

  it("removes a cancelled queued child without consuming the next FIFO slot", async () => {
    const f = fixture();
    const host = f.host({ maxConcurrency: 1 });
    const first = f.blockRun();
    const running = host.spawnChild({ prompt: "running", withSession: async () => "one" });
    const started = await first.started;
    const controller = new AbortController();
    const callback = vi.fn();
    const queued = host.spawnChild({ prompt: "cancelled queue", signal: controller.signal, withSession: callback });
    const rejection = expect(queued).rejects.toBeInstanceOf(ConsumerCancellation);
    const next = host.spawnChild({ prompt: "next", withSession: async () => "two" });
    controller.abort("queued");
    await rejection;
    expect(started.options.signal?.aborted).toBe(false);
    expect(f.backend.run).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
    first.finish();
    await expect(running).resolves.toBe("one");
    await expect(next).resolves.toBe("two");
    expect(f.backend.run.mock.calls.map(args => args[2])).toEqual(["running", "next"]);
  });

  it("retains invocation capacity after cancellation until the actual run settles", async () => {
    const f = fixture();
    const host = f.host({ maxConcurrency: 1 });
    const run = f.blockRun();
    const controller = new AbortController();
    const cancelled = host.spawnChild({ prompt: "running", signal: controller.signal, withSession: async () => {} });
    const rejection = expect(cancelled).rejects.toBeInstanceOf(ConsumerCancellation);
    const { session, options } = await run.started;
    const next = host.spawnChild({ prompt: "next", withSession: async () => "next" });
    controller.abort();
    await rejection;
    await flush();
    expect(options.signal?.aborted).toBe(true);
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(session);
    expect(f.backend.run).toHaveBeenCalledOnce();
    run.finish({ aborted: true });
    await expect(next).resolves.toBe("next");
  });

  it.each([false, true])("retires an unpublished late fresh handle after cancellation/disposal (callback=%s)", async callback => {
    const f = fixture();
    const host = f.host();
    const run = f.blockRun(false);
    const controller = new AbortController();
    const withSession = vi.fn();
    const operation = host.spawnChild({ prompt: "startup", signal: controller.signal, withSession });
    const rejection = expect(operation).rejects.toBeInstanceOf(ConsumerCancellation);
    const { session, options } = await run.started;
    controller.abort("startup cancelled");
    await rejection;
    await host.dispose(); // Opaque backend preflight must not hold disposal forever.
    expect(options.signal?.aborted).toBe(true);
    expect(f.backend.shutdown.mock.calls.filter(([handle]) => handle === session)).toHaveLength(0);
    if (callback) run.publish();
    run.finish({ aborted: true });
    await flush();
    expect(f.backend.shutdown.mock.calls.filter(([handle]) => handle === session)).toHaveLength(1);
    expect(withSession).not.toHaveBeenCalled();
  });

  it.each(["reattach", "fork"] as const)("cancels %s startup promptly but disposal awaits late acquisition and retirement", async mode => {
    const f = fixture();
    const host = f.host();
    const source = f.seed();
    const acquiring = deferred<ExecutionSession>();
    const entered = deferred<ExecutionRestoreOptions | undefined>();
    const closed = f.gate();
    const controller = new AbortController();
    f.backend[mode].mockImplementationOnce((_ref, options) => { entered.resolve(options); return acquiring.promise; });
    const callback = vi.fn();
    const operation = host.spawnChild({ prompt: "ignored", [mode]: { sessionFile: source.reference.sessionFile }, signal: controller.signal, withSession: callback });
    const rejection = expect(operation).rejects.toBeInstanceOf(ConsumerCancellation);
    const options = await entered.promise;
    controller.abort();
    await rejection;
    expect(options?.signal?.aborted).toBe(true);
    const disposed = vi.fn();
    const disposal = host.dispose().then(disposed);
    await flush();
    expect(disposed).not.toHaveBeenCalled();
    const late = f.handle(mode === "reattach" ? source : f.seed());
    f.backend.shutdown.mockReturnValueOnce(closed.promise);
    acquiring.resolve(late);
    await flush();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(late);
    expect(disposed).not.toHaveBeenCalled();
    closed.resolve();
    await disposal;
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["run", "observer"] as const)("bridges %s cancellation to active, idle-callback and queued children", async origin => {
    const f = fixture();
    const controller = new AbortController();
    if (origin === "observer") f.observer.signal = controller.signal;
    const host = f.host({ maxConcurrency: 1, ...(origin === "run" ? { signal: controller.signal } : {}) });
    const ready = deferred<WorkflowSessionContext>();
    const held = f.gate();
    const idle = host.spawnChild({ prompt: "idle", withSession: async child => { ready.resolve(child); await held.promise; } });
    const idleChild = await ready.promise;
    const run = f.blockRun();
    const active = host.spawnChild({ prompt: "active", withSession: async () => {} });
    const { options } = await run.started;
    const queuedCallback = vi.fn();
    const queued = host.spawnChild({ prompt: "queued", withSession: queuedCallback });
    const rejected = [idle, active, queued].map(task => expect(task).rejects.toBeInstanceOf(ConsumerCancellation));
    controller.abort("whole workflow");
    await Promise.all(rejected);
    expect(host.signal.aborted).toBe(true);
    expect(idleChild.signal?.aborted).toBe(true);
    expect(options.signal?.aborted).toBe(true);
    expect(queuedCallback).not.toHaveBeenCalled();
    expect(f.backend.run).toHaveBeenCalledTimes(2);
    run.finish({ aborted: true });
    held.resolve();
    await expect(call(() => host.spawnChild({ prompt: "too late", withSession: async () => {} }))).rejects.toBeInstanceOf(ConsumerCancellation);
  });
});

describe("model and request preflight", () => {
  it("resolves an exact full provider/model key, preserves thinking off, and never mutates global selection", async () => {
    const f = fixture();
    const host = f.host();
    const inherited = f.ctx.model;
    await host.spawnChild({ prompt: "plain", model: { model: "other/family/model", thinking: "off" }, withSession: async () => {} });
    expect(f.find).toHaveBeenCalledExactlyOnceWith("other", "family/model");
    expect(f.backend.run.mock.calls[0][3].model).toBe(f.otherModel);
    expect(f.backend.run.mock.calls[0][3].thinkingLevel).toBe("off");
    expect(f.ctx.model).toBe(inherited);
    expect(f.pi.setModel).not.toHaveBeenCalled();
    expect(f.pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  it.each(["family/model", "fixture/missing", "model", "", "/model"])("rejects unresolved or non-exact model %j before launch", async model => {
    const f = fixture();
    const host = f.host();
    await expect(host.spawnChild({ prompt: "plain", model: { model }, withSession: async () => {} })).rejects.toThrow(i18n.t("workflowExecution.unknownModel", { model }));
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(f.backend.reattach).not.toHaveBeenCalled();
  });

  it("applies the enabled-model scope before dispatch without changing the parent model", async () => {
    const f = fixture();
    mkdirSync(join(f.root, ".pi"));
    writeFileSync(join(f.root, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["fixture/family/model"] }));
    setScopeModelsEnabled(true);
    const host = f.host();
    await expect(host.spawnChild({ prompt: "plain", model: { model: "other/family/model" }, withSession: async () => {} }))
      .rejects.toThrow(i18n.t("workflowExecution.modelOutOfScope", { model: "other/family/model" }));
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(f.ctx.model).toBe(f.model);
    await host.spawnChild({ prompt: "allowed", model: { model: "fixture/family/model" }, withSession: async () => {} });
    expect(f.backend.run).toHaveBeenCalledOnce();
  });

  it.each(["model", "thinking", "cwd"] as const)("rejects a restored %s mismatch before writer acquisition", async mismatch => {
    const f = fixture();
    const otherCwd = join(f.root, "other-cwd");
    mkdirSync(otherCwd);
    const source = f.seed({ policy: mismatch === "cwd" ? { cwd: otherCwd } : {} });
    const host = f.host();
    const model: WorkflowModelSelection | undefined = mismatch === "model" ? { model: "other/family/model" }
      : mismatch === "thinking" ? { thinking: "high" } : undefined;
    await expect(host.spawnChild({ prompt: "ignored", model, reattach: { sessionFile: source.reference.sessionFile }, withSession: async () => {} }))
      .rejects.toThrow(diagnostic(mismatch === "cwd" ? "cwdMismatch" : "policyOverride"));
    expect(f.backend.reattach).not.toHaveBeenCalled();
    expect(f.backend.fork).not.toHaveBeenCalled();
    expect(f.backend.run).not.toHaveBeenCalled();
  });

  it.each([false, true])("compares requested thinking after clamping to saved effective policy (explicit model=%s)", async explicit => {
    const f = fixture();
    const source = f.seed({ policy: { thinkingLevel: "high" } });
    const host = f.host();
    await host.spawnChild({ prompt: "ignored", reattach: { sessionFile: source.reference.sessionFile },
      model: { thinking: "xhigh", ...(explicit ? { model: "fixture/family/model" } : {}) }, withSession: async () => {} });
    expect(f.backend.reattach).toHaveBeenCalledOnce();
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(f.backend.resume).not.toHaveBeenCalled();
  });

  it("checks the acquired destination policy again and closes a changed restore", async () => {
    const f = fixture();
    const source = f.seed();
    const host = f.host();
    f.backend.fork.mockImplementationOnce(async () => f.handle(f.seed({ policy: { model: { provider: "other", id: "family/model" } } })));
    const callback = vi.fn();
    await expect(host.spawnChild({ prompt: "ignored", fork: { sessionFile: source.reference.sessionFile },
      model: { model: "fixture/family/model" }, withSession: callback })).rejects.toThrow(diagnostic("policyOverride"));
    expect(callback).not.toHaveBeenCalled();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(f.handles[0]);
  });

  it.each(["fresh", "fork"] as const)("rejects %s destinations outside the assigned managed directory", async mode => {
    const f = fixture();
    const host = f.host();
    const source = f.seed();
    const outside = f.seed({ file: join(f.root, "children", "outside-sweep.jsonl") });
    if (mode === "fresh") f.backend.run.mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      const handle = f.handle(outside);
      options.onSessionCreated?.(handle);
      return f.result(handle);
    });
    else f.backend.fork.mockImplementationOnce(async () => f.handle(outside));
    const callback = vi.fn();
    await expect(host.spawnChild({ prompt: "plain", ...(mode === "fork" ? { fork: { sessionFile: source.reference.sessionFile } } : {}),
      withSession: callback })).rejects.toThrow(diagnostic("storageMismatch"));
    expect(callback).not.toHaveBeenCalled();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(f.handles[0]);
  });

  it("rejects a cross-backend snapshot before restoration", async () => {
    const f = fixture();
    const source = f.seed();
    f.snapshots.set(source.reference.sessionFile, { ...source, reference: { ...source.reference, backend: "terminal" } });
    await expect(f.host().spawnChild({ prompt: "ignored", reattach: { sessionFile: source.reference.sessionFile }, withSession: async () => {} }))
      .rejects.toThrow(diagnostic("invalidSession"));
    expect(f.backend.reattach).not.toHaveBeenCalled();
  });

  it("snapshots queued selection and source fields before caller mutation", async () => {
    const f = fixture();
    const host = f.host({ maxConcurrency: 1 });
    const first = f.blockRun();
    const blocker = host.spawnChild({ prompt: "blocker", withSession: async () => {} });
    await first.started;
    const source = f.seed();
    const model: WorkflowModelSelection = { model: "fixture/family/model", thinking: "off" };
    const reattach = { sessionFile: source.reference.sessionFile };
    const queued = host.spawnChild({ prompt: "ignored", model, reattach, withSession: async () => {} });
    model.model = "other/family/model";
    model.thinking = "high";
    reattach.sessionFile = join(f.root, "nonexistent.jsonl");
    first.finish();
    await blocker;
    await queued;
    expect(f.find).toHaveBeenCalledExactlyOnceWith("fixture", "family/model");
    expect(f.backend.reattach.mock.calls[0][0]).toEqual(source.reference);
  });

  it("rejects a legacy backend before looking up models or creating a manager timer", () => {
    vi.useFakeTimers();
    const f = fixture();
    const count = vi.getTimerCount();
    const backend: AgentExecutionBackend = { ...f.backend, inspect: undefined, reattach: undefined, fork: undefined };
    expect(() => f.host({ backend })).toThrow(diagnostic("managedRequired"));
    expect(f.find).not.toHaveBeenCalled();
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(count);
  });

  it.each(["/unknown-command", "  /skill:missing", "/template"])("refuses command %j before fresh launch and before resume", async prompt => {
    const f = fixture();
    const host = f.host();
    await expect(call(() => host.spawnChild({ prompt, withSession: async () => {} }))).rejects.toThrow(diagnostic("commandUnsupported"));
    expect(f.backend.run).not.toHaveBeenCalled();
    await host.spawnChild({ prompt: "ordinary text mentioning /literal", withSession: async child => {
      await expect(call(() => child.sendUserMessage(prompt))).rejects.toThrow(diagnostic("commandUnsupported"));
    } });
    expect(f.backend.resume).not.toHaveBeenCalled();
  });

  it.each([
    { prompt: "" }, { prompt: "  " }, { prompt: 42 }, { withSession: null },
    { reattach: { sessionFile: "relative.jsonl" } },
    { reattach: { sessionFile: "/one" }, fork: { sessionFile: "/two" } },
    { model: { thinking: "unsupported" } }, { model: null }, { model: [] }, { signal: {} },
    { reattach: {} }, { fork: null },
  ])("rejects invalid child request %j before backend activity", async extra => {
    const f = fixture();
    const host = f.host();
    const request = { prompt: "plain", withSession: async () => {}, ...extra } as unknown as WorkflowChildOptions<void>;
    await expect(call(() => host.spawnChild(request))).rejects.toThrow();
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(f.backend.inspect).not.toHaveBeenCalled();
    expect(f.backend.reattach).not.toHaveBeenCalled();
    expect(f.backend.fork).not.toHaveBeenCalled();
  });
});

describe("invocation semaphore", () => {
  it("is FIFO, removes aborted waiters, and makes each release idempotent", async () => {
    const semaphore = new ExecutionSemaphore(1, signal => new ConsumerCancellation(signal));
    const release = await semaphore.acquire(new AbortController().signal);
    const cancelled = new AbortController();
    const queue = semaphore.acquire(cancelled.signal);
    const rejected = expect(queue).rejects.toBeInstanceOf(ConsumerCancellation);
    const order: number[] = [];
    const second = semaphore.acquire(new AbortController().signal).then(done => { order.push(2); return done; });
    const third = semaphore.acquire(new AbortController().signal).then(done => { order.push(3); return done; });
    cancelled.abort();
    await rejected;
    release();
    release();
    const releaseSecond = await second;
    await flush();
    expect(order).toEqual([2]);
    releaseSecond();
    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual([2, 3]);
    releaseThird();
  });

  it("rejects pre-aborted admission without consuming capacity", async () => {
    const semaphore = new ExecutionSemaphore(1, signal => new ConsumerCancellation(signal));
    const controller = new AbortController();
    controller.abort("before acquisition");
    await expect(semaphore.acquire(controller.signal)).rejects.toMatchObject({ constructor: ConsumerCancellation, cause: "before acquisition" });
    const release = await semaphore.acquire(new AbortController().signal);
    release();
  });
});
