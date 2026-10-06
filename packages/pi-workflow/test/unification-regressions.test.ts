import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acts, defineRoute, defineWorkflow, produces } from "../src/api.js";
import { registerBuiltIns } from "../src/built-ins.js";
import { makeWfHandler } from "../src/command.js";
import type * as CommandRunModule from "../src/command-run.js";
import workflowExtension from "../src/extension.js";
import { getWorkflowExecutionProvider, registerWorkflowExecutionHost } from "../src/execution-host.js";
import { fs as fsHandle } from "../src/handle.js";
import type { WorkflowHost, WorkflowHostContext, WorkflowSessionContext } from "../src/host.js";
import { fanout } from "../src/loop-constructors.js";
import type { Outcome } from "../src/output-spec.js";
import {
  installPiWorkflowExecution,
  registerWorkflowCancellationCommand,
  type PiWorkflowExecutionRuntime,
} from "../src/pi-execution.js";
import {
  WORKFLOW_EXECUTOR_DISCOVERY,
  type WorkflowExecutorDiscovery,
  type WorkflowExecutorExecution,
  type WorkflowExecutorOffer,
  type WorkflowExecutorRequest,
} from "../src/pi-protocol.js";
import { resumeWorkflow, runWorkflow } from "../src/runner/index.js";
import {
  listRuns,
  readAllStages,
  readHeader,
  readRoutingDecisions,
  readRunTerminal,
} from "../src/state/index.js";
import { createMockCommandCtx, createMockPi, mockAssistantMessage } from "./upstream/index.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
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

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw last;
}

class SyncBus implements EventBus {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(data);
  }

  on(channel: string, listener: (data: unknown) => void): () => void {
    const set = this.listeners.get(channel) ?? new Set();
    set.add(listener);
    this.listeners.set(channel, set);
    return () => { set.delete(listener); };
  }
}

function piHarness(bus = new SyncBus()) {
  const lifecycle = new Map<string, Set<(event: unknown) => unknown>>();
  const mock = createMockPi({
    events: bus,
    on: ((name: string, handler: (event: unknown) => unknown) => {
      const set = lifecycle.get(name) ?? new Set();
      set.add(handler);
      lifecycle.set(name, set);
      return () => { set.delete(handler); };
    }) as ExtensionAPI["on"],
  });
  return {
    ...mock,
    bus,
    async fire(name: string, event: unknown): Promise<void> {
      for (const handler of [...(lifecycle.get(name) ?? [])]) await handler(event);
    },
  };
}

const roots: string[] = [];
const runtimes: PiWorkflowExecutionRuntime[] = [];
const unregisterHosts: Array<() => void> = [];

function workspace(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function workflowConfig(cwd: string, execution: Record<string, unknown>): void {
  const path = join(cwd, ".pi", "pi-workflow.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ execution }, null, 2)}\n`);
}

function observer(cwd: string, sessionId = "root"): WorkflowHostContext {
  return createMockCommandCtx({ cwd, hasUI: true, sessionId }) as unknown as WorkflowHostContext;
}

const promptBinding = Object.freeze({
  resolverId: "test/unification-regressions@1",
  resourceSetDigest: "digest",
  assetMode: "live" as const,
});

function executionFor(
  request: WorkflowExecutorRequest,
  close: () => Promise<void> = async () => {},
): WorkflowExecutorExecution {
  return {
    host: request.observer,
    signal: request.signal,
    identity: {
      version: 1,
      executor: "pi-subagents",
      backend: request.identity?.backend ?? request.settings.backend ?? "embedded",
      promptBinding,
    },
    close,
    dispose: vi.fn(),
    readSessionBranch: () => undefined,
  };
}

function registerOffer(
  bus: SyncBus,
  createExecution: WorkflowExecutorOffer["createExecution"],
): () => void {
  const value: WorkflowExecutorOffer = {
    version: 1,
    id: "pi-subagents",
    backends: ["embedded", "terminal"],
    createExecution,
  };
  return bus.on(WORKFLOW_EXECUTOR_DISCOVERY, (raw) => {
    (raw as WorkflowExecutorDiscovery).offer(value);
  });
}

function provider() {
  const value = getWorkflowExecutionProvider();
  if (!value) throw new Error("workflow provider missing");
  return value;
}

function runOptions(cwd: string, runId: string) {
  return {
    runId,
    childSessionsDir: join(cwd, "children", runId),
    cancellationError: (signal: AbortSignal) => new Error(`cancelled:${runId}`, { cause: signal.reason }),
  };
}

function directExecution(signal: AbortSignal, close: () => Promise<void> = async () => {}) {
  const unregister = registerWorkflowExecutionHost({
    createHost: (ctx) => ({ host: ctx, signal, close }),
  });
  unregisterHosts.push(unregister);
}

const artifactOutcome: Outcome<unknown, "artifact-md", Record<string, unknown>> = {
  name: "artifacts",
  collector: {
    collect: (ctx) => {
      const text = JSON.stringify(ctx.branch);
      const match = text.match(/(\.rpiv\/artifacts\/[^"\\]+\.md)/);
      if (!match) return { kind: "fatal", message: `${ctx.skill} produced no artifact path` };
      return { kind: "ok", artifacts: [{ handle: fsHandle(match[1]!), role: "primary" }] };
    },
  },
  parser: { parse: () => ({ kind: "ok", payload: { kind: "artifact-md", data: {} } }) },
};

afterEach(async () => {
  for (const unregister of unregisterHosts.splice(0)) unregister();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("unified workflow ownership regressions", () => {
  it("cancels a held script and permanently fences its late success and routing", async () => {
    const cwd = workspace("pi-workflow-held-script-");
    const abort = new AbortController();
    const entered = deferred();
    const release = deferred();
    directExecution(abort.signal);
    const workflow = defineWorkflow({
      name: "held-script",
      start: "work",
      stages: {
        work: acts.script({
          run: async () => {
            entered.resolve();
            await release.promise;
          },
        }),
      },
      edges: { work: defineRoute(["stop"], () => "stop", { readsData: false }) },
    });
    const ctx = observer(cwd);

    const running = runWorkflow(ctx, { workflow, input: "x" });
    await entered.promise;
    abort.abort("cancel held script");
    const result = await within(running, 1_000, "held script cancellation did not settle");

    expect(result.success).toBe(false);
    expect(result.termination?.status).toBe("aborted");
    const before = readAllStages(cwd, result.runId!);
    expect(before.map((row) => row.status)).toEqual(["aborted"]);
    expect(readRoutingDecisions(cwd, result.runId!)).toEqual([]);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringMatching(/complete/i), "info");

    release.resolve();
    await flush();
    expect(readAllStages(cwd, result.runId!)).toEqual(before);
    expect(readRoutingDecisions(cwd, result.runId!)).toEqual([]);
  });

  it("cancels while a nonterminal lifecycle hook is held, with no later route or success", async () => {
    const cwd = workspace("pi-workflow-held-lifecycle-");
    const abort = new AbortController();
    const entered = deferred();
    const release = deferred();
    directExecution(abort.signal);
    const workflow = defineWorkflow({
      name: "held-lifecycle",
      start: "work",
      stages: { work: acts.script({ run: () => {} }) },
      edges: { work: defineRoute(["stop"], () => "stop", { readsData: false }) },
    });
    const ctx = observer(cwd);

    const running = runWorkflow(ctx, {
      workflow,
      input: "x",
      lifecycle: {
        onStageEnd: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    });
    await entered.promise;
    abort.abort("cancel held lifecycle");
    const result = await within(running, 1_000, "held lifecycle cancellation did not settle");

    expect(result.success).toBe(false);
    expect(result.termination?.status).toBe("aborted");
    const before = readAllStages(cwd, result.runId!);
    expect(before.map((row) => row.status)).toEqual(["completed", "aborted"]);
    expect(readRoutingDecisions(cwd, result.runId!)).toEqual([]);

    release.resolve();
    await flush();
    expect(readAllStages(cwd, result.runId!)).toEqual(before);
    expect(readRoutingDecisions(cwd, result.runId!)).toEqual([]);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringMatching(/complete/i), "info");
  });

  it("fail-fast aborts an in-flight sibling and leaves exactly one terminal failure", async () => {
    const cwd = workspace("pi-workflow-fail-fast-");
    const siblingStarted = deferred();
    let siblingObservedAbort = false;
    const notifications: Array<{ message: string; level: string }> = [];
    const spawnChild: WorkflowHostContext["spawnChild"] = vi.fn(async (options) => {
      const sibling = options.prompt.includes("u1");
      if (sibling) {
        siblingStarted.resolve();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        siblingObservedAbort = options.signal?.aborted === true;
      } else {
        await siblingStarted.promise;
      }
      const branch = sibling
        ? [mockAssistantMessage("interrupted sibling", "aborted")]
        : [mockAssistantMessage("no artifact path")];
      const child = {
        cwd,
        hasUI: true,
        ui: { notify: (message: string, level = "info") => { notifications.push({ message, level }); } },
        sessionManager: {
          getBranch: () => branch,
          getSessionId: () => sibling ? "sibling" : "failing",
          getSessionFile: () => undefined,
        },
        waitForIdle: async () => {},
        maxConcurrency: 2,
        signal: options.signal,
        sendUserMessage: async () => {},
        spawnChild,
      } as unknown as WorkflowSessionContext;
      return options.withSession(child);
    });
    const ctx = {
      ...observer(cwd),
      maxConcurrency: 2,
      spawnChild,
    } as WorkflowHostContext;
    const workflow = defineWorkflow({
      name: "fail-fast-sibling",
      start: "fan",
      stages: {
        fan: produces({
          outcome: artifactOutcome,
          loop: fanout({
            failFast: true,
            units: () => [
              { id: "u0", label: "u0", prompt: "u0" },
              { id: "u1", label: "u1", prompt: "u1" },
            ],
          }),
        }),
      },
      edges: { fan: "stop" },
    });

    const stageErrorEntered = deferred();
    const releaseStageError = deferred();
    const running = runWorkflow(ctx, {
      workflow,
      input: "x",
      lifecycle: {
        onStageError: async () => {
          stageErrorEntered.resolve();
          await releaseStageError.promise;
        },
      },
    });
    await stageErrorEntered.promise;
    await eventually(() => expect(siblingObservedAbort).toBe(true));
    releaseStageError.resolve();
    const result = await running;
    const rows = readAllStages(cwd, result.runId!);

    expect(result.success).toBe(false);
    expect(siblingObservedAbort).toBe(true);
    expect(rows.filter((row) => row.status === "failed")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "completed")).toHaveLength(0);
  });

  it("persists failed retirement, refuses replay, and reports the refusal through the real /wf wrapper", async () => {
    const cwd = workspace("pi-workflow-cleanup-marker-");
    workflowConfig(cwd, { profile: "managed", backend: "embedded" });
    const h = piHarness();
    const cleanupError = new Error("executor retirement exploded");
    const closeExecution = vi.fn(async () => { throw cleanupError; });
    const createExecution = vi.fn((request: WorkflowExecutorRequest) => executionFor(request, closeExecution));
    registerOffer(h.bus, createExecution);
    workflowExtension(h.pi);
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const workflow = defineWorkflow({
      name: "cleanup-marker-refusal",
      start: "effect",
      stages: { effect: acts.script({ run: () => { effects++; } }) },
      edges: { effect: "stop" },
    });
    let effects = 0;
    registerBuiltIns([workflow]);

    await expect(runWorkflow(observer(cwd), { workflow, input: "x" })).rejects.toThrow("executor retirement exploded");
    const [summary] = listRuns(cwd);
    expect(summary).toBeDefined();
    const runId = summary!.runId;
    const terminal = readRunTerminal(cwd, runId);
    expect(terminal).toMatchObject({ status: "cleanup-failed", workflowStatus: "completed", stagesCompleted: 1 });
    expect(effects).toBe(1);

    const header = readHeader(cwd, runId)!;
    const directResume = await resumeWorkflow(observer(cwd), { workflow, header, ref: runId });
    expect(directResume).toMatchObject({ success: false, stagesCompleted: 1 });
    expect(directResume).not.toHaveProperty("runId");
    expect(directResume.error).toContain("cannot resume this run");
    expect(effects).toBe(1);
    expect(createExecution).toHaveBeenCalledOnce();

    const ctx = createMockCommandCtx({ cwd, hasUI: true });
    const command = h.captured.commands.get("wf");
    expect(command).toBeDefined();
    await command!.handler(`@${runId}`, ctx);
    await eventually(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cannot resume this run"), "error");
    });
    expect(effects).toBe(1);
    expect(createExecution).toHaveBeenCalledOnce();
    expect(readAllStages(cwd, runId)).toHaveLength(1);

    await Promise.allSettled([h.fire("session_shutdown", { type: "session_shutdown", reason: "quit" })]);
  });

  it("makes a cold /wf admission cancelable before lazy import or malformed config is touched", async () => {
    const cwd = workspace("pi-workflow-cold-command-");
    const configPath = join(cwd, ".pi", "pi-workflow.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{");
    registerBuiltIns([defineWorkflow({
      name: "cold-cancel",
      start: "work",
      stages: { work: acts.script({ run: () => {} }) },
      edges: { work: "stop" },
    })]);
    const h = piHarness();
    const runtime = installPiWorkflowExecution(h.pi);
    runtimes.push(runtime);
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    registerWorkflowCancellationCommand(h.pi, runtime);
    const cold = deferred<typeof CommandRunModule>();
    const host: WorkflowHost = {
      getCommands: () => h.pi.getCommands(),
      registerCommand: (name, command) => h.pi.registerCommand(name, command),
    };
    const wf = makeWfHandler(host, () => cold.promise);
    h.pi.registerCommand("wf", {
      description: "workflow",
      handler: (args, ctx) => runtime.runCommand(ctx, (current) => wf(args, current)),
    });
    const ctx = createMockCommandCtx({ cwd, hasUI: true });

    let invocationSettled = false;
    const invocation = h.captured.commands.get("wf")!.handler("cold-cancel target", ctx).finally(() => {
      invocationSettled = true;
    });
    await flush();
    expect(runtime.activeRunIds()).toHaveLength(1);
    expect(runtime.activeRunIds()[0]).toMatch(/^pending-/);
    expect(invocationSettled).toBe(false);

    const cancelCtx = createMockCommandCtx({ cwd, hasUI: true });
    await within(
      h.captured.commands.get("wf-cancel")!.handler("", cancelCtx),
      1_000,
      "cold cancellation command did not settle",
    );
    expect(runtime.activeRunIds()).toEqual([]);
    expect(invocationSettled).toBe(false);

    cold.resolve(await import("../src/command-run.js"));
    await within(invocation, 1_000, "cancelled cold /wf did not unwind after import");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Invalid pi-workflow configuration"), "error");
  });

  it("hands an admitted standard run to the next root bus while a filtered child cannot claim ownership", async () => {
    const cwd = workspace("pi-workflow-root-handoff-");
    workflowConfig(cwd, { profile: "standard" });
    const first = piHarness();
    const closeExecution = vi.fn(async () => {});
    const requests: WorkflowExecutorRequest[] = [];
    registerOffer(first.bus, (request) => {
      requests.push(request);
      return executionFor(request, closeExecution);
    });
    const firstRuntime = installPiWorkflowExecution(first.pi);
    runtimes.push(firstRuntime);
    expect(getWorkflowExecutionProvider()).toBeUndefined();
    await first.fire("session_start", { type: "session_start", reason: "startup" });
    await provider().createHost(observer(cwd, "first-root"), runOptions(cwd, "standard-handoff"));
    expect(requests[0]?.settings).toMatchObject({ profile: "standard" });
    expect(requests[0]?.settings.backend).toBeUndefined();

    const child = piHarness();
    const childRuntime = installPiWorkflowExecution(child.pi);
    runtimes.push(childRuntime);
    const originalProvider = getWorkflowExecutionProvider();
    await child.fire("session_start", { type: "session_start", reason: "startup" });
    expect(childRuntime.installed).toBe(false);
    expect(getWorkflowExecutionProvider()).toBe(originalProvider);

    await first.fire("session_shutdown", { type: "session_shutdown", reason: "new" });
    expect(closeExecution).not.toHaveBeenCalled();

    const second = piHarness();
    const secondRuntime = installPiWorkflowExecution(second.pi);
    runtimes.push(secondRuntime);
    expect(secondRuntime.installed).toBe(false);
    expect(getWorkflowExecutionProvider()).toBe(originalProvider);

    await second.fire("session_start", { type: "session_start", reason: "startup" });
    expect(secondRuntime.installed).toBe(true);
    expect(secondRuntime.activeRunIds()).toEqual(["standard-handoff"]);
    await expect(provider().createHost(
      observer(cwd, "second-root"),
      runOptions(cwd, "standard-handoff"),
    )).rejects.toThrow(/already active/);
    await expect(secondRuntime.cancelRun("standard-handoff")).resolves.toBe(true);
    expect(closeExecution).toHaveBeenCalledOnce();
    expect(childRuntime.installed).toBe(false);
  });

  it.each(["quit", "reload"] as const)("%s shutdown waits for admitted execution retirement", async (reason) => {
    const cwd = workspace(`pi-workflow-${reason}-drain-`);
    workflowConfig(cwd, { profile: "standard" });
    const h = piHarness();
    const release = deferred();
    const closeExecution = vi.fn(() => release.promise);
    registerOffer(h.bus, (request) => executionFor(request, closeExecution));
    const runtime = installPiWorkflowExecution(h.pi);
    runtimes.push(runtime);
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await provider().createHost(observer(cwd), runOptions(cwd, `${reason}-run`));

    let settled = false;
    const shutdown = h.fire("session_shutdown", { type: "session_shutdown", reason }).finally(() => {
      settled = true;
    });
    await flush();
    expect(closeExecution).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    release.resolve();
    await shutdown;
    expect(runtime.activeRunIds()).toEqual([]);
  });
});
