import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkflowExecutionProvider } from "./execution-host.js";
import type { WorkflowHostContext } from "./host.js";
import { i18n } from "./i18n.js";
import {
  installPiWorkflowExecution,
  registerWorkflowCancellationCommand,
  type PiWorkflowExecutionRuntime,
} from "./pi-execution.js";
import {
  WORKFLOW_EXECUTOR_DISCOVERY,
  type WorkflowExecutorDiscovery,
  type WorkflowExecutorExecution,
  type WorkflowExecutorOffer,
  type WorkflowExecutorRequest,
} from "./pi-protocol.js";
import { createMockCommandCtx, createMockPi } from "../test/upstream/index.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function eventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(name: string, listener: (data: unknown) => void) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
    emit(name: string, data: unknown) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(data);
    },
  };
}

type Bus = ReturnType<typeof eventBus>;

const roots: string[] = [];
const runtimes: PiWorkflowExecutionRuntime[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "pi-workflow-cancel-"));
  const configDir = join(value, ".pi");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "pi-workflow.json"), `${JSON.stringify({
    execution: { profile: "managed", backend: "embedded" },
  })}\n`);
  roots.push(value);
  return value;
}

function observer(cwd: string): WorkflowHostContext {
  return createMockCommandCtx({ cwd, hasUI: true }) as unknown as WorkflowHostContext;
}

function validExecution(request: WorkflowExecutorRequest, close: () => Promise<void>): WorkflowExecutorExecution {
  return {
    host: request.observer,
    signal: request.signal,
    identity: {
      version: 1,
      executor: "pi-subagents",
      backend: request.identity?.backend ?? request.settings.backend ?? "embedded",
      promptBinding: { resolverId: "test/cancel@1", resourceSetDigest: "digest", assetMode: "live" },
    },
    close,
    dispose: vi.fn(),
    readSessionBranch: () => undefined,
  };
}

function registerOffer(bus: Bus, factory: WorkflowExecutorOffer["createExecution"]): void {
  const value: WorkflowExecutorOffer = {
    version: 1,
    id: "pi-subagents",
    backends: ["embedded", "terminal"],
    createExecution: factory,
  };
  bus.on(WORKFLOW_EXECUTOR_DISCOVERY, (data) => (data as WorkflowExecutorDiscovery).offer(value));
}

function harness(factory: WorkflowExecutorOffer["createExecution"]) {
  const bus = eventBus();
  const mock = createMockPi({ events: bus as ExtensionAPI["events"] });
  const runtime = installPiWorkflowExecution(mock.pi);
  runtimes.push(runtime);
  for (const start of mock.captured.events.get("session_start") ?? []) start({ reason: "startup" });
  registerWorkflowCancellationCommand(mock.pi, runtime);
  registerOffer(bus, factory);
  const provider = getWorkflowExecutionProvider();
  if (!provider) throw new Error("workflow provider missing");
  return { ...mock, runtime, provider };
}

function options(cwd: string, runId: string, cancellationError = vi.fn(() => new Error(`cancelled:${runId}`))) {
  return { runId, childSessionsDir: join(cwd, "children", runId), cancellationError };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("workflow runtime cancellation", () => {
  it("tracks pending acquisition, combines its signal, and retires a late handle before cancellation settles", async () => {
    const cwd = root();
    const returned = deferred<WorkflowExecutorExecution>();
    let request!: WorkflowExecutorRequest;
    const close = vi.fn(async () => {});
    const f = harness((value) => { request = value; return returned.promise; });
    const canonical = new Error("canonical cancellation");
    const cancellationError = vi.fn(() => canonical);
    const creating = Promise.resolve(f.provider.createHost(observer(cwd), options(cwd, "pending", cancellationError)));
    await flush();

    expect(f.runtime.activeRunIds()).toEqual(["pending"]);
    const cancelling = f.runtime.cancelRun("pending");
    expect(request.signal?.aborted).toBe(true);
    returned.resolve(validExecution(request, close));

    await expect(creating).rejects.toBe(canonical);
    await expect(cancelling).resolves.toBe(true);
    expect(cancellationError).toHaveBeenCalledWith(request.signal);
    expect(close).toHaveBeenCalledOnce();
    expect(f.runtime.activeRunIds()).toEqual([]);
  });

  it("deduplicates overlapping cancellation and waits for the one retirement barrier", async () => {
    const cwd = root();
    const release = deferred();
    const close = vi.fn(() => release.promise);
    let request!: WorkflowExecutorRequest;
    const f = harness((value) => { request = value; return validExecution(value, close); });
    await f.provider.createHost(observer(cwd), options(cwd, "overlap"));

    let firstSettled = false;
    const first = f.runtime.cancelRun("overlap").finally(() => { firstSettled = true; });
    const second = f.runtime.cancelRun("overlap");
    await flush();
    expect(request.signal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(firstSettled).toBe(false);

    release.resolve();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("treats unknown run IDs as harmless", async () => {
    const cwd = root();
    const close = vi.fn(async () => {});
    const f = harness((request) => validExecution(request, close));
    await f.provider.createHost(observer(cwd), options(cwd, "known"));
    await expect(f.runtime.cancelRun("missing")).resolves.toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it("hides naturally retiring runs from cancellation while still awaiting close", async () => {
    const cwd = root();
    const release = deferred();
    const close = vi.fn(() => release.promise);
    const f = harness((request) => validExecution(request, close));
    const execution = await f.provider.createHost(observer(cwd), options(cwd, "retiring"));
    expect(f.runtime.activeRunIds()).toEqual(["retiring"]);

    const retirement = execution.close!();
    expect(f.runtime.activeRunIds()).toEqual([]);
    const command = f.captured.commands.get("wf-cancel")!;
    const ctx = createMockCommandCtx({ cwd, hasUI: true });
    await command.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(i18n.t("cancel.none"), "info");

    release.resolve();
    await retirement;
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("/wf-cancel command", () => {
  it("with no args cancels the sole active run and emits start/completion notices", async () => {
    const cwd = root();
    const close = vi.fn(async () => {});
    const f = harness((request) => validExecution(request, close));
    await f.provider.createHost(observer(cwd), options(cwd, "sole"));
    const command = f.captured.commands.get("wf-cancel")!;
    const ctx = createMockCommandCtx({ cwd, hasUI: true });

    await command.handler("", ctx);

    expect(close).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith(i18n.t("cancel.start", { runId: "sole" }), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(i18n.t("cancel.done", { runId: "sole" }), "info");
  });

  it("with no args lists multiple run IDs instead of guessing", async () => {
    const cwd = root();
    const closes = [vi.fn(async () => {}), vi.fn(async () => {})];
    let index = 0;
    const f = harness((request) => validExecution(request, closes[index++]!));
    const first = await f.provider.createHost(observer(cwd), options(cwd, "run-b"));
    const second = await f.provider.createHost(observer(cwd), options(cwd, "run-a"));
    const command = f.captured.commands.get("wf-cancel")!;
    const ctx = createMockCommandCtx({ cwd, hasUI: true });

    await command.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      i18n.t("cancel.choose", { runs: "run-a, run-b" }),
      "info",
    );
    expect(closes[0]).not.toHaveBeenCalled();
    expect(closes[1]).not.toHaveBeenCalled();
    await first.close?.();
    await second.close?.();
  });

  it("supports all and reports an unknown explicit ID without affecting active runs", async () => {
    const cwd = root();
    const closes = [vi.fn(async () => {}), vi.fn(async () => {})];
    let index = 0;
    const f = harness((request) => validExecution(request, closes[index++]!));
    await f.provider.createHost(observer(cwd), options(cwd, "one"));
    await f.provider.createHost(observer(cwd), options(cwd, "two"));
    const command = f.captured.commands.get("wf-cancel")!;
    const ctx = createMockCommandCtx({ cwd, hasUI: true });

    await command.handler("missing", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(i18n.t("cancel.unknown", { runId: "missing" }), "warning");
    expect(closes.every((close) => close.mock.calls.length === 0)).toBe(true);

    await command.handler("all", ctx);
    expect(closes[0]).toHaveBeenCalledOnce();
    expect(closes[1]).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith(i18n.t("cancel.doneAll", { count: 2 }), "info");
  });
});
