import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { ManagedWorkflowExecution } from "../src/workflow/execution-contract.js";
import { createWorkflowExecutionProvider } from "../src/workflow/execution-provider.js";
import { i18n } from "../src/i18n.js";
import { ConsumerCancellation, deferred, executionFixture, flush } from "./helpers/workflow-execution.js";

const fixtures: ReturnType<typeof executionFixture>[] = [];
const executions: ManagedWorkflowExecution[] = [];
const managers: AgentManager[] = [];

function fixture() {
  const f = executionFixture();
  fixtures.push(f);
  const provider = createWorkflowExecutionProvider({
    pi: f.pi,
    getContext: () => f.ctx,
    createBackend: () => f.backend,
    inspectSession: file => f.backend.inspect(file),
    cancellationError: signal => new ConsumerCancellation(signal),
  });
  const execution = provider.createHost(f.observer, {
    runId: `retirement-${executions.length + 1}`,
    childSessionsDir: dirname(f.sessionDir),
  });
  executions.push(execution);
  return { ...f, execution };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => { throw new Error("expected rejection"); },
    error => error,
  );
}

afterEach(async () => {
  for (const execution of executions) execution.dispose();
  await Promise.allSettled(executions.splice(0).map(execution => execution.close()));
  await Promise.allSettled(managers.splice(0).map(manager => manager.dispose()));
  await Promise.all(fixtures.splice(0).map(f => f.close()));
  vi.restoreAllMocks();
});

describe("strict workflow retirement failures", () => {
  it.each(["throw", "reject"] as const)("rejects a successful callback when backend shutdown %ss", async mode => {
    const f = fixture();
    const error = new Error(`${mode} retirement`);
    f.backend.shutdown.mockImplementationOnce(() => {
      if (mode === "throw") throw error;
      return Promise.reject(error);
    });
    const callback = vi.fn(async () => "callback result");

    await expect(f.execution.host.spawnChild({ prompt: "plain", withSession: callback })).rejects.toBe(error);
    expect(callback).toHaveBeenCalledOnce();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(f.handles[0]);
    await expect(f.execution.close()).rejects.toBe(error);
  });

  it("preserves both callback and cleanup failures and always unpins the scope", async () => {
    const f = fixture();
    const callbackError = new Error("callback failed");
    const cleanupError = new Error("cleanup failed");
    const unpin = vi.fn();
    vi.spyOn(AgentManager.prototype, "retain").mockReturnValueOnce(unpin);
    f.backend.shutdown.mockRejectedValueOnce(cleanupError);

    const failure = await rejectionOf(f.execution.host.spawnChild({
      prompt: "plain",
      withSession: async () => { throw callbackError; },
    }));

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(i18n.t("workflowExecution.cleanupFailed"));
    expect((failure as AggregateError).errors).toEqual([callbackError, cleanupError]);
    expect(unpin).toHaveBeenCalledOnce();
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
    await expect(f.execution.close()).rejects.toBe(cleanupError);
  });

  it("cancels promptly while an idempotent reentrant close awaits and reports delayed failed retirement", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const held = deferred<void>();
    const retirement = deferred<void>();
    const cleanupError = new Error("delayed retirement failed");
    const operation = f.execution.host.spawnChild({
      prompt: "plain",
      withSession: async () => { entered.resolve(); await held.promise; },
    });
    await entered.promise;

    let reentered: Promise<void> | undefined;
    f.backend.shutdown.mockImplementationOnce(() => {
      reentered = f.execution.close();
      return retirement.promise;
    });
    const closing = f.execution.close();
    expect(reentered).toBe(closing);
    expect(f.execution.close()).toBe(closing);
    await expect(operation).rejects.toBeInstanceOf(ConsumerCancellation);
    let settled = false;
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(f.handles[0]);

    retirement.reject(cleanupError);
    await expect(closing).rejects.toBe(cleanupError);
    held.resolve();
    await flush();
  });

  it("aggregates an earlier released failure with a later active retirement failure", async () => {
    const f = fixture();
    const firstError = new Error("first retirement failed");
    const secondError = new Error("second retirement failed");
    f.backend.shutdown.mockRejectedValueOnce(firstError);
    await expect(f.execution.host.spawnChild({ prompt: "first", withSession: async () => "first" })).rejects.toBe(firstError);

    const entered = deferred<void>();
    const held = deferred<void>();
    const active = f.execution.host.spawnChild({
      prompt: "second",
      withSession: async () => { entered.resolve(); await held.promise; },
    });
    await entered.promise;
    f.backend.shutdown.mockRejectedValueOnce(secondError);
    const closing = f.execution.close();
    await expect(active).rejects.toBeInstanceOf(ConsumerCancellation);
    const failure = await rejectionOf(closing);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(i18n.t("manager.retirementFailed"));
    expect((failure as AggregateError).errors).toEqual([firstError, secondError]);
    expect(f.backend.shutdown).toHaveBeenCalledTimes(2);
    held.resolve();
    await flush();
  });

  it("keeps an unrelated sibling release successful after another child fails retirement", async () => {
    const f = fixture();
    const error = new Error("one child failed retirement");
    f.backend.shutdown.mockRejectedValueOnce(error);

    await expect(f.execution.host.spawnChild({ prompt: "first", withSession: async () => "first" })).rejects.toBe(error);
    await expect(f.execution.host.spawnChild({ prompt: "sibling", withSession: async () => "sibling" })).resolves.toBe("sibling");
    expect(f.backend.shutdown).toHaveBeenCalledTimes(2);
    expect(f.backend.shutdown.mock.calls[0][0]).not.toBe(f.backend.shutdown.mock.calls[1][0]);
    await expect(f.execution.close()).rejects.toBe(error);
  });

  it("keeps the default AgentManager retirement contract best-effort", async () => {
    const f = executionFixture();
    fixtures.push(f);
    const manager = new AgentManager(undefined, 4, undefined, undefined, undefined, f.backend);
    managers.push(manager);
    const id = manager.spawn(f.pi, f.ctx, "general-purpose", "plain", {
      description: "legacy best effort",
      workflowId: "legacy",
      isolated: true,
      inheritContext: false,
      isolation: "off",
      isBackground: false,
      cwd: f.root,
    });
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    if (record.promise) await record.promise;
    const error = new Error("legacy retirement failure");
    f.backend.shutdown.mockRejectedValueOnce(error);

    await expect(manager.release(id)).resolves.toBeUndefined();
    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(f.handles[0]);
  });
});
