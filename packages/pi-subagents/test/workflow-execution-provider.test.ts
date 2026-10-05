import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedWorkflowExecution, WorkflowModelSelection, WorkflowRunOptions } from "../src/workflow/execution-contract.js";
import { createWorkflowExecutionProvider, type WorkflowExecutionProviderOptions } from "../src/workflow/execution-provider.js";
import { ConsumerCancellation, deferred, executionFixture, flush, rawBranch } from "./helpers/workflow-execution.js";

const fixtures: ReturnType<typeof executionFixture>[] = [];
const executions: ManagedWorkflowExecution[] = [];
function fixture(extra: Partial<WorkflowExecutionProviderOptions> = {}) {
  const f = executionFixture();
  fixtures.push(f);
  const getContext = vi.fn<WorkflowExecutionProviderOptions["getContext"]>(() => f.ctx);
  const createBackend = vi.fn<WorkflowExecutionProviderOptions["createBackend"]>(() => f.backend);
  const inspectSession = vi.fn<WorkflowExecutionProviderOptions["inspectSession"]>(file => f.backend.inspect(file));
  const provider = createWorkflowExecutionProvider({ pi: f.pi, getContext, createBackend, inspectSession,
    cancellationError: signal => new ConsumerCancellation(signal), ...extra });
  const run: WorkflowRunOptions = { runId: "workflow-1", childSessionsDir: dirname(f.sessionDir), workflow: "pipeline", input: "input" };
  function create(input = run) {
    const execution = provider.createHost(f.observer, input);
    executions.push(execution);
    return execution;
  }
  return { ...f, getContext, createBackend, inspectSession, provider, run, create };
}

afterEach(async () => {
  for (const execution of executions) execution.dispose();
  await Promise.all(fixtures.splice(0).map(f => f.close()));
  await Promise.all(executions.splice(0).map(execution => execution.close()));
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("read-only workflow provider observation", () => {
  it("returns the complete raw branch without opening a host, projecting messages, or sharing mutable data", () => {
    const f = fixture();
    const source = f.seed();
    const before = structuredClone(source);
    const branch = f.provider.readSessionBranch!(source.reference.sessionFile) as unknown as ReturnType<typeof rawBranch>;
    expect(branch).toEqual(before.branch);
    expect(branch).not.toBe(source.branch);
    expect(branch.map(entry => entry.type)).toEqual(["message", "message", "message", "compaction", "context_edit", "custom"]);
    expect(branch[1].message?.content).toBe("original user");
    expect(branch[2]).toMatchObject({ opaqueEnvelope: { keep: true }, message: { providerMetadata: { trace: "saved" }, content: [
      { type: "text", text: "answer" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "example.txt", extra: { keep: [1, 2] } } },
    ] } });
    branch[5].data!.nested.push("consumer mutation");
    branch[2].message!.content = "consumer replacement";
    branch.splice(0, 2);
    expect(f.provider.readSessionBranch!(source.reference.sessionFile)).toEqual(before.branch);
    expect(source).toEqual(before);
    expect(f.getContext).not.toHaveBeenCalled();
    expect(f.createBackend).not.toHaveBeenCalled();
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(f.backend.reattach).not.toHaveBeenCalled();
    expect(f.backend.fork).not.toHaveBeenCalled();
  });

  it("fails soft on inspection and clone errors without changing the saved source", () => {
    const f = fixture();
    expect(f.provider.readSessionBranch!(join(f.root, "missing.jsonl"))).toBeUndefined();
    f.inspectSession.mockImplementationOnce(() => { throw new Error("quarantined or malformed source"); });
    expect(f.provider.readSessionBranch!(join(f.root, "quarantined.jsonl"))).toBeUndefined();
    const source = f.seed();
    f.inspectSession.mockReturnValueOnce({ ...source, branch: [{ type: "custom", nonCloneable: () => {} }] as unknown as typeof source.branch });
    expect(f.provider.readSessionBranch!(source.reference.sessionFile)).toBeUndefined();
    expect(f.provider.readSessionBranch!(source.reference.sessionFile)).toEqual(rawBranch());
    expect(f.createBackend).not.toHaveBeenCalled();
  });

  it("snapshots root observer identity and branch before its guarded context changes", async () => {
    const f = fixture();
    const execution = f.create();
    const before = structuredClone(f.rootBranch);
    const stale = () => { throw new Error("obsolete context getter"); };
    f.observer.sessionManager.getSessionId = stale;
    f.observer.sessionManager.getSessionFile = stale;
    f.observer.sessionManager.getBranch = stale;
    f.rootBranch[5].data!.nested.push("observer mutation");
    const registry = f.ctx.modelRegistry;
    for (const key of ["cwd", "model", "modelRegistry"] as const) Object.defineProperty(f.ctx, key, { get: stale });
    f.ctx.getSystemPrompt = stale;
    expect(execution.host.sessionManager.getSessionId()).toBe("observer-id");
    expect(execution.host.sessionManager.getSessionFile()).toBe(join(f.root, "observer.jsonl"));
    const branch = execution.host.sessionManager.getBranch() as ReturnType<typeof rawBranch>;
    expect(branch).toEqual(before);
    branch[5].data!.nested.push("consumer mutation");
    expect(execution.host.sessionManager.getBranch()).toEqual(before);
    expect(execution.host.cwd).toBe(f.root);
    expect(execution.host.hasUI).toBe(false);
    await execution.host.waitForIdle();
    expect(f.observer.waitForIdle).not.toHaveBeenCalled();
    await execution.host.spawnChild({ prompt: "use captured context", withSession: async () => {} });
    const capturedContext = f.backend.run.mock.calls[0][0];
    expect(capturedContext.cwd).toBe(f.root);
    expect(capturedContext.model).toBe(f.model);
    expect(capturedContext.modelRegistry).toBe(registry);
    expect(capturedContext.getSystemPrompt()).toBe("parent system");
  });

  it("forwards only an optional model resolver and leaves global model selection untouched", () => {
    const resolver = vi.fn((): WorkflowModelSelection => ({ model: "fixture/family/model", thinking: "off" }));
    const f = fixture({ resolveModel: resolver });
    const id = { workflow: "pipeline", stage: "review", skill: "check" };
    expect(f.provider.resolveModel!(id)).toEqual({ model: "fixture/family/model", thinking: "off" });
    expect(resolver).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.createBackend).not.toHaveBeenCalled();
    expect(f.pi.setModel).not.toHaveBeenCalled();
    expect(f.pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(fixture().provider.resolveModel).toBeUndefined();
  });
});

describe("provider lifetime and managed storage", () => {
  it("resolves current context per host and puts exact persistent files beneath a nested managed directory", async () => {
    const f = fixture();
    const run = { ...f.run, runId: "../../not-a-path" };
    const execution = f.create(run);
    const captured = f.createBackend.mock.calls[0][0];
    expect(captured.sessionDir).toBe(join(run.childSessionsDir, "managed"));
    expect(captured.run).toEqual(run);
    expect(captured.run).not.toBe(run);
    expect(Object.isFrozen(captured.run)).toBe(true);
    expect(f.getContext).toHaveBeenCalledExactlyOnceWith(f.observer, captured.run);
    run.childSessionsDir = join(f.root, "retargeted");
    run.runId = "mutated";
    expect(captured.sessionDir).toBe(f.sessionDir);
    expect(captured.run.runId).toBe("../../not-a-path");
    await execution.host.spawnChild({ prompt: "first", withSession: async child => {
      expect(dirname(child.sessionManager.getSessionFile()!)).toBe(f.sessionDir);
      expect(child.sessionManager.getSessionFile()).toBe(f.handles[0].reference.sessionFile);
      expect(child.sessionManager.getSessionId()).toBe(f.handles[0].reference.sessionId);
    } });
    const nextContext = { ...f.ctx } as ExtensionContext;
    f.getContext.mockReturnValueOnce(nextContext);
    f.createBackend.mockReturnValueOnce({ ...f.backend });
    f.create();
    expect(f.getContext).toHaveBeenCalledTimes(2);
    expect(f.createBackend).toHaveBeenCalledTimes(2);
    expect(f.createBackend.mock.results[0].value).not.toBe(f.createBackend.mock.results[1].value);
  });

  it("dispose closes admission synchronously while close awaits known-handle shutdown", async () => {
    const f = fixture();
    const execution = f.create();
    const entered = f.gate();
    const held = f.gate();
    const closed = f.gate();
    const operation = execution.host.spawnChild({ prompt: "first", withSession: async () => { entered.resolve(); await held.promise; } });
    await entered.promise;
    const rejected = expect(operation).rejects.toBeInstanceOf(ConsumerCancellation);
    f.backend.shutdown.mockReturnValueOnce(closed.promise);
    expect(execution.dispose()).toBeUndefined();
    expect(execution.signal).toBe(execution.host.signal);
    expect(execution.signal.aborted).toBe(true);
    await expect(execution.host.spawnChild({ prompt: "too late", withSession: async () => {} })).rejects.toBeInstanceOf(ConsumerCancellation);
    await rejected;
    const done = vi.fn();
    const closing = execution.close();
    expect(execution.close()).toBe(closing);
    void closing.then(done);
    execution.dispose();
    await flush();
    expect(done).not.toHaveBeenCalled();
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(f.handles[0]);
    closed.resolve();
    await closing;
    expect(done).toHaveBeenCalledOnce();
    held.resolve();
  });

  it("does not let disposal of one execution cancel another execution", async () => {
    const first = fixture();
    const second = fixture();
    const one = first.create();
    const two = second.create();
    const ready = deferred<void>();
    const held = second.gate();
    const sibling = two.host.spawnChild({ prompt: "independent run", withSession: async child => {
      ready.resolve();
      await held.promise;
      expect(child.signal?.aborted).toBe(false);
      await child.sendUserMessage("still live");
    } });
    await ready.promise;
    one.dispose();
    await one.close();
    expect(two.signal.aborted).toBe(false);
    expect(second.backend.shutdown).not.toHaveBeenCalled();
    held.resolve();
    await sibling;
    expect(second.backend.resume).toHaveBeenCalledOnce();
  });

  it.each([
    { runId: "" }, { runId: "  " }, { childSessionsDir: "relative" }, { childSessionsDir: "" }, { childSessionsDir: 3 },
  ])("rejects invalid run options %j before creating context or backend", extra => {
    const f = fixture();
    expect(() => f.create({ ...f.run, ...extra } as WorkflowRunOptions)).toThrow();
    expect(f.getContext).not.toHaveBeenCalled();
    expect(f.createBackend).not.toHaveBeenCalled();
  });

  it("does not leak a manager timer when current context cwd is invalid", () => {
    vi.useFakeTimers();
    const f = fixture();
    const count = vi.getTimerCount();
    f.getContext.mockReturnValueOnce({ ...f.ctx, cwd: "relative" } as ExtensionContext);
    expect(() => f.create()).toThrow();
    expect(vi.getTimerCount()).toBe(count);
    expect(f.backend.run).not.toHaveBeenCalled();
  });

  it.each(["identity", "branch", "mode", "system", "model", "registry"] as const)("does not leak a manager timer when %s capture throws in construction", field => {
    vi.useFakeTimers();
    const f = fixture();
    const count = vi.getTimerCount();
    const failure = new Error("context invalidated during host creation");
    const fail = () => { throw failure; };
    if (field === "identity") f.observer.sessionManager.getSessionId = fail;
    else if (field === "branch") f.observer.sessionManager.getBranch = fail;
    else if (field === "system") f.ctx.getSystemPrompt = fail;
    else Object.defineProperty(f.ctx, field === "registry" ? "modelRegistry" : field, { get: fail });
    expect(() => f.create()).toThrow(failure);
    expect(vi.getTimerCount()).toBe(count);
    expect(f.backend.run).not.toHaveBeenCalled();
  });
});
