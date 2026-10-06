import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAgentDir,
  ProjectTrustStore,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkflowCommand } from "../src/command.js";
import { getWorkflowExecutionProvider, registerWorkflowExecutionHost } from "../src/execution-host.js";
import type { WorkflowHostContext } from "../src/host.js";
import { i18n } from "../src/i18n.js";
import { installPiWorkflowExecution, type PiWorkflowExecutionRuntime } from "../src/pi-execution.js";
import {
  WORKFLOW_EXECUTOR_DISCOVERY,
  type WorkflowExecutorDiscovery,
  type WorkflowExecutorExecution,
  type WorkflowExecutorOffer,
  type WorkflowExecutorRequest,
} from "../src/pi-protocol.js";
import { listRuns, readAllStages } from "../src/state/index.js";
import {
  createMockCommandCtx,
  createMockPi,
  createMockSessionChain,
  mockAssistantMessage,
} from "./upstream/index.ts";

const EXECUTOR_ID = "pi-subagents";
const HASH = "a".repeat(64);
const runtimes: PiWorkflowExecutionRuntime[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

async function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function createEventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(name: string, listener: (data: unknown) => void) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, set = new Set());
      set.add(listener);
      return () => { set!.delete(listener); };
    },
    emit(name: string, data: unknown) {
      for (const listener of [...listeners.get(name) ?? []]) listener(data);
    },
  };
}

type TestBus = ReturnType<typeof createEventBus>;

function installed(bus = createEventBus(), skills: readonly string[] = []) {
  const { pi, captured } = createMockPi({ skills, events: bus as ExtensionAPI["events"] });
  const runtime = installPiWorkflowExecution(pi);
  runtimes.push(runtime);
  for (const start of captured.events.get("session_start") ?? []) start({ reason: "startup" });
  const provider = getWorkflowExecutionProvider();
  if (!provider) throw new Error("installPiWorkflowExecution did not register its public provider");
  return { pi, captured, bus, runtime, provider };
}

function observer(cwd: string): WorkflowHostContext {
  return createMockCommandCtx({ cwd, hasUI: true }) as unknown as WorkflowHostContext;
}

function trustedCommandCtx(cwd: string): ReturnType<typeof createMockCommandCtx> {
  return Object.assign(createMockCommandCtx({ cwd, hasUI: true }), {
    isProjectTrusted: () => true,
  });
}

function runOptions(cwd: string) {
  return {
    runId: "admission-regression",
    childSessionsDir: join(cwd, "children"),
    cancellationError: (signal: AbortSignal) => new Error("cancelled", { cause: signal.reason }),
  };
}

function validIdentity() {
  return {
    version: 1 as const,
    executor: EXECUTOR_ID,
    backend: "embedded" as const,
    promptBinding: {
      resolverId: "test/workflow-executor@1",
      resourceSetDigest: HASH,
      assetMode: "live" as const,
    },
  };
}

function execution(
  cwd: string,
  close: () => Promise<void>,
  overrides: Partial<WorkflowExecutorExecution> = {},
): WorkflowExecutorExecution {
  return {
    host: createMockCommandCtx({ cwd }) as unknown as WorkflowHostContext,
    identity: validIdentity(),
    close,
    dispose: vi.fn(),
    readSessionBranch: () => undefined,
    ...overrides,
  };
}

function offer(factory: WorkflowExecutorOffer["createExecution"]): WorkflowExecutorOffer {
  return {
    version: 1,
    id: EXECUTOR_ID,
    backends: ["embedded"],
    createExecution: factory,
  };
}

function registerOffer(bus: TestBus, value: WorkflowExecutorOffer): () => void {
  return bus.on(WORKFLOW_EXECUTOR_DISCOVERY, data => {
    (data as WorkflowExecutorDiscovery).offer(value);
  });
}

describe("Pi execution admission and retirement regressions", () => {
  it("returns its cancellation signal even if the executor exposes no signal", async () => {
    const cwd = tempRoot("pi-workflow-optional-executor-signal-");
    const f = installed();
    const close = vi.fn(async () => {});
    registerOffer(f.bus, offer(() => execution(cwd, close)));
    const acquired = await f.provider.createHost(observer(cwd), runOptions(cwd));
    expect(acquired.signal).toBeInstanceOf(AbortSignal);
    expect(acquired.signal?.aborted).toBe(false);
    expect(await f.runtime.cancelRun("admission-regression")).toBe(true);
    expect(acquired.signal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a returned close-capable execution before rejecting its invalid identity", async () => {
    const cwd = tempRoot("pi-workflow-invalid-identity-");
    const f = installed();
    const release = deferred();
    const close = vi.fn(() => release.promise);
    registerOffer(f.bus, offer(() => execution(cwd, close, {
      identity: { ...validIdentity(), executor: "wrong-executor" },
    })));

    let settled = false;
    const creation = Promise.resolve(f.provider.createHost(observer(cwd), runOptions(cwd)));
    const observed = creation.then(
      () => new Error("invalid execution unexpectedly admitted"),
      (error: unknown) => error as Error,
    ).finally(() => { settled = true; });

    try {
      await flush();
      expect(close).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      release.resolve();
      const error = await observed;
      expect(error.message).toBe(i18n.t("execution.invalidIdentity", { executor: EXECUTOR_ID }));
    } finally {
      release.resolve();
      await observed;
    }
  });

  it("preserves both invalid-identity and cleanup failures from a rejected execution", async () => {
    const cwd = tempRoot("pi-workflow-invalid-identity-cleanup-");
    const f = installed();
    const cleanupError = new Error("invalid execution cleanup failed");
    const close = vi.fn(async () => { throw cleanupError; });
    registerOffer(f.bus, offer(() => execution(cwd, close, {
      identity: { ...validIdentity(), executor: "wrong-executor" },
    })));

    const error = await Promise.resolve(f.provider.createHost(observer(cwd), runOptions(cwd))).catch(
      (reason: unknown) => reason,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(AggregateError);
    const errors = (error as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe(i18n.t("execution.invalidIdentity", { executor: EXECUTOR_ID }));
    expect(errors[1]).toBe(cleanupError);
  });

  it("runtime.close preserves a retirement rejection while awaiting every other close", async () => {
    const cwd = tempRoot("pi-workflow-close-errors-");
    const f = installed();
    const slow = deferred();
    const retirementError = new Error("first retirement failed");
    const firstClose = vi.fn(async () => { throw retirementError; });
    const secondClose = vi.fn(() => slow.promise);
    const queue = [execution(cwd, firstClose), execution(cwd, secondClose)];
    registerOffer(f.bus, offer(() => queue.shift()!));
    await f.provider.createHost(observer(cwd), { ...runOptions(cwd), runId: "first" });
    await f.provider.createHost(observer(cwd), { ...runOptions(cwd), runId: "second" });

    let settled = false;
    const closing = f.runtime.close();
    const observed = closing.then(
      () => undefined,
      error => error,
    ).finally(() => { settled = true; });
    await flush();
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    slow.resolve();
    expect(await observed).toBe(retirementError);
    await expect(closing).rejects.toBe(retirementError);
  });

  it("preserves an already-retiring rejection when runtime.close starts at the empty-active microtask boundary", async () => {
    const cwd = tempRoot("pi-workflow-retiring-race-");
    const f = installed();
    const pending = deferred();
    const retirementError = new Error("already-retiring close failed");
    const close = vi.fn(() => pending.promise);
    registerOffer(f.bus, offer(() => execution(cwd, close)));
    const wrapped = await f.provider.createHost(observer(cwd), runOptions(cwd));
    const retirement = wrapped.close!();
    const observedRetirement = retirement.catch((error: unknown) => error);

    // Let the executor promise reject the published barrier, then resume this
    // continuation before the barrier's retiring-set removal microtask. Starting
    // root close here deterministically places that removal ahead of its first
    // Promise.allSettled([]) continuation.
    pending.reject(retirementError);
    await Promise.resolve();
    const closing = f.runtime.close();

    expect(await observedRetirement).toBe(retirementError);
    await expect(closing).rejects.toBe(retirementError);
    expect(close).toHaveBeenCalledOnce();
  });

  it("awaits invalid asynchronous execution cleanup that starts after runtime.close", async () => {
    const cwd = tempRoot("pi-workflow-async-invalid-close-");
    const f = installed();
    const creation = deferred<WorkflowExecutorExecution>();
    const release = deferred();
    const close = vi.fn(() => release.promise);
    registerOffer(f.bus, offer(() => creation.promise));
    const acquiring = Promise.resolve(f.provider.createHost(observer(cwd), runOptions(cwd))).then(
      () => new Error("invalid asynchronous execution unexpectedly admitted"),
      (error: unknown) => error as Error,
    );
    await flush();

    let rootSettled = false;
    const rootClose = f.runtime.close().finally(() => { rootSettled = true; });
    creation.resolve(execution(cwd, close, {
      identity: { ...validIdentity(), executor: "wrong-executor" },
    }));

    try {
      await flush();
      expect(close).toHaveBeenCalledOnce();
      expect(rootSettled).toBe(false);
    } finally {
      release.resolve();
    }
    const error = await acquiring;
    expect(error.message).toBe(i18n.t("execution.invalidIdentity", { executor: EXECUTOR_ID }));
    await rootClose;
  });

  it("publishes one close promise before an execution.close callback reenters retirement", async () => {
    const cwd = tempRoot("pi-workflow-reentrant-close-");
    const f = installed();
    const release = deferred();
    let wrapped!: Awaited<ReturnType<typeof f.provider.createHost>>;
    let reentered: Promise<void> | undefined;
    let first = true;
    const close = vi.fn(() => {
      if (first) {
        first = false;
        reentered = wrapped.close!();
      }
      return release.promise;
    });
    registerOffer(f.bus, offer(() => execution(cwd, close)));
    wrapped = await f.provider.createHost(observer(cwd), runOptions(cwd));

    const barrier = wrapped.close!();
    try {
      expect(close).toHaveBeenCalledOnce();
      expect(reentered).toBe(barrier);
      expect(wrapped.close!()).toBe(barrier);
    } finally {
      release.resolve();
      await barrier;
    }
  });

  it("publishes runtime.close before an execution close callback reenters root shutdown", async () => {
    const cwd = tempRoot("pi-workflow-reentrant-root-close-");
    const f = installed();
    const release = deferred();
    let reentered: Promise<void> | undefined;
    const close = vi.fn(() => {
      reentered = f.runtime.close();
      return release.promise;
    });
    registerOffer(f.bus, offer(() => execution(cwd, close)));
    await f.provider.createHost(observer(cwd), runOptions(cwd));

    let outerSettled = false;
    const outer = f.runtime.close();
    void outer.then(
      () => { outerSettled = true; },
      () => { outerSettled = true; },
    );
    try {
      expect(close).toHaveBeenCalledOnce();
      expect(reentered).toBe(outer);
      await flush();
      expect(outerSettled).toBe(false);
    } finally {
      release.resolve();
    }
    await outer;
    expect(await reentered!).toBeUndefined();
  });

  it("does not throw into an executor that reports an offer after the synchronous discovery turn", async () => {
    const cwd = tempRoot("pi-workflow-late-offer-");
    const f = installed();
    const close = vi.fn(async () => {});
    const value = offer(() => execution(cwd, close));
    let discovery!: WorkflowExecutorDiscovery;
    f.bus.on(WORKFLOW_EXECUTOR_DISCOVERY, data => {
      discovery = data as WorkflowExecutorDiscovery;
      discovery.offer(value);
    });
    const acquired = await f.provider.createHost(observer(cwd), runOptions(cwd));

    expect(() => discovery.offer(value)).not.toThrow();
    await acquired.close!();
    expect(close).toHaveBeenCalledOnce();
  });
});

interface CommandHarness {
  readonly cwd: string;
  readonly pi: ExtensionAPI;
  readonly captured: ReturnType<typeof createMockPi>["captured"];
  readonly chain: ReturnType<typeof createMockSessionChain>;
  readonly requests: WorkflowExecutorRequest[];
  readonly finished: Promise<void>;
  readonly runtime: PiWorkflowExecutionRuntime;
}

function commandHarness(stageSkill: string, ambientSkills: readonly string[]): CommandHarness {
  const cwd = tempRoot(`pi-workflow-command-${stageSkill}-`);
  const configDir = join(cwd, ".rpiv", "workflows");
  const piConfigDir = join(cwd, ".pi");
  const skillDir = join(cwd, "approved-skill");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(piConfigDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: approved\ndescription: approved fixture\n---\nDo approved work.\n");
  writeFileSync(join(configDir, "config.ts"), [
    'import { acts, defineWorkflow, STOP } from "@maplezzk/pi-workflow";',
    "export default defineWorkflow({",
    `  name: "${stageSkill}-flow",`,
    '  start: "work",',
    `  stages: { work: acts({ skill: "${stageSkill}" }) },`,
    "  edges: { work: STOP },",
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(piConfigDir, "pi-workflow.json"), JSON.stringify({
    execution: {
      executor: EXECUTOR_ID,
      profile: "managed",
      backend: "embedded",
      agentType: "workflow-offline",
      maxConcurrency: 1,
    },
    skills: [{ name: "approved", filePath: join(skillDir, "SKILL.md"), baseDir: skillDir, format: "pi" }],
    requiredTools: [],
  }));
  new ProjectTrustStore(getAgentDir()).set(cwd, true);

  const bus = createEventBus();
  const mock = createMockPi({ skills: ambientSkills, events: bus as ExtensionAPI["events"] });
  const runtime = installPiWorkflowExecution(mock.pi);
  runtimes.push(runtime);
  for (const start of mock.captured.events.get("session_start") ?? []) start({ reason: "startup" });
  const chain = createMockSessionChain({
    cwd,
    steps: [{ branch: [mockAssistantMessage("done", "stop")] }],
  });
  const requests: WorkflowExecutorRequest[] = [];
  const done = deferred();
  registerOffer(bus, offer(request => {
    requests.push(request);
    return execution(cwd, vi.fn(async () => { done.resolve(); }), { host: chain.ctx });
  }));
  registerWorkflowCommand(mock.pi);
  return { cwd, pi: mock.pi, captured: mock.captured, chain, requests, finished: done.promise, runtime };
}

async function invokeWf(f: CommandHarness, workflow: string): Promise<void> {
  const command = f.captured.commands.get("wf");
  if (!command) throw new Error("/wf was not registered");
  const ctx = trustedCommandCtx(f.cwd);
  await command.handler(`${workflow} task`, ctx);
  await within(f.finished, 10_000, "floated /wf run did not retire");
}

describe("actual /wf approved-skill preflight boundary", () => {
  it("does not impose managed approvals on a generic programmatic execution provider", async () => {
    const f = commandHarness("ambient-unapproved", ["ambient-unapproved"]);
    const done = deferred();
    const unregister = registerWorkflowExecutionHost({
      createHost: () => ({ host: f.chain.ctx, close: async () => { done.resolve(); } }),
    });
    try {
      const command = f.captured.commands.get("wf")!;
      await command.handler("ambient-unapproved-flow task", trustedCommandCtx(f.cwd));
      await within(done.promise, 10_000, "generic provider did not retire");
      expect(f.requests).toEqual([]);
      expect(f.chain.ctx.spawnChild).toHaveBeenCalledOnce();
      const runs = listRuns(f.cwd);
      expect(readAllStages(f.cwd, runs[0]!.runId)).toMatchObject([{ stage: "work", status: "completed" }]);
    } finally { unregister(); }
  });

  it("admits an explicitly approved skill even when it is absent from ambient Pi commands", async () => {
    const f = commandHarness("approved", ["ambient-unapproved"]);
    await invokeWf(f, "approved-flow");

    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.settings.skills?.map(skill => skill.name)).toEqual(["approved"]);
    expect(f.requests[0]!.settings.skills?.map(skill => skill.name)).not.toContain("ambient-unapproved");
    expect(f.chain.ctx.spawnChild).toHaveBeenCalledOnce();
    const runs = listRuns(f.cwd);
    expect(runs).toHaveLength(1);
    expect(readAllStages(f.cwd, runs[0]!.runId)).toMatchObject([{ stage: "work", skill: "approved", status: "completed" }]);
  });

  it("does not treat an ambient but unapproved Pi skill as available to the managed workflow", async () => {
    const f = commandHarness("ambient-unapproved", ["ambient-unapproved"]);
    await invokeWf(f, "ambient-unapproved-flow");

    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.settings.skills?.map(skill => skill.name)).toEqual(["approved"]);
    expect(f.chain.ctx.spawnChild).not.toHaveBeenCalled();
    const runs = listRuns(f.cwd);
    expect(runs).toHaveLength(1);
    const rows = readAllStages(f.cwd, runs[0]!.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "work", skill: "ambient-unapproved", status: "failed", session: null });
    expect(rows[0]!.errMsg).toContain("ambient-unapproved");
    expect(rows[0]!.errMsg).toContain("registered with Pi");
  });
});
