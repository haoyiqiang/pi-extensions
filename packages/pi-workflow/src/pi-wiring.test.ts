import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  ProjectTrustStore,
  type EventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acts, defineWorkflow } from "./api.js";
import { registerBuiltIns } from "./built-ins.js";
import { registerWorkflowCommand } from "./command.js";
import { getWorkflowExecutionProvider } from "./execution-host.js";
import type { WorkflowHostContext, WorkflowLauncherContext } from "./host.js";
import {
  discoverExecutor,
  installPiWorkflowExecution,
  isPiWorkflowExecutionProvider,
} from "./pi-execution.js";
import {
  WORKFLOW_EXECUTOR_DISCOVERY,
  type WorkflowExecutorDiscovery,
  type WorkflowExecutorExecution,
  type WorkflowExecutorOffer,
  type WorkflowExecutorRequest,
} from "./pi-protocol.js";

class SyncBus implements EventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  emit(channel: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }
  on(channel: string, handler: (data: unknown) => void): () => void {
    const listeners = this.handlers.get(channel) ?? new Set();
    listeners.add(handler);
    this.handlers.set(channel, listeners);
    return () => listeners.delete(handler);
  }
}

interface FakePi {
  pi: ExtensionAPI;
  bus: SyncBus;
  commands: Map<string, { handler(args: string, ctx: WorkflowLauncherContext): Promise<void> }>;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

const roots: string[] = [];

function fakePi(): FakePi {
  const bus = new SyncBus();
  const commands = new Map<string, { handler(args: string, ctx: WorkflowLauncherContext): Promise<void> }>();
  const lifecycle = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const pi = {
    events: bus,
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const handlers = lifecycle.get(event) ?? new Set();
      handlers.add(handler);
      lifecycle.set(event, handlers);
      return () => handlers.delete(handler);
    },
    registerCommand(name: string, options: { handler(args: string, ctx: WorkflowLauncherContext): Promise<void> }) {
      commands.set(name, options);
    },
    getCommands: () => [],
  } as unknown as ExtensionAPI;
  return {
    pi,
    bus,
    commands,
    async start() {
      for (const handler of [...(lifecycle.get("session_start") ?? [])]) {
        await handler({ type: "session_start", reason: "startup" });
      }
    },
    async shutdown() {
      for (const handler of [...(lifecycle.get("session_shutdown") ?? [])]) await handler({ type: "session_shutdown" });
    },
  };
}

function observer(cwd: string, id: string, mode?: string): WorkflowHostContext {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    mode,
    ui: { notify: vi.fn() },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => id,
      getSessionFile: () => undefined,
    },
    waitForIdle: async () => {},
    maxConcurrency: 1,
    spawnChild: async () => { throw new Error("not used"); },
    modelRegistry: { find: vi.fn() },
    getSystemPrompt: () => "system",
  } as unknown as WorkflowHostContext;
}

const promptBinding = Object.freeze({
  resolverId: "test/workflow@1",
  resourceSetDigest: "digest",
  assetMode: "live" as const,
});

function executionFor(request: WorkflowExecutorRequest, close = vi.fn(async () => {})): WorkflowExecutorExecution {
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
    dispose: () => { void close(); },
    readSessionBranch: () => undefined,
  };
}

function offer(factory: (request: WorkflowExecutorRequest) => WorkflowExecutorExecution | Promise<WorkflowExecutorExecution>): WorkflowExecutorOffer {
  return { version: 1, id: "pi-subagents", backends: ["embedded", "terminal"], createExecution: factory };
}

function registerOffer(bus: SyncBus, value: WorkflowExecutorOffer): () => void {
  return bus.on(WORKFLOW_EXECUTOR_DISCOVERY, (raw) => (raw as WorkflowExecutorDiscovery).offer(value));
}

function provider() {
  const value = getWorkflowExecutionProvider();
  if (!value) throw new Error("provider not registered");
  return value as unknown as {
    createHost(observer: WorkflowHostContext, options: {
      runId: string;
      childSessionsDir: string;
      workflow?: string;
      input?: string;
      cancellationError(signal: AbortSignal): Error;
      signal?: AbortSignal;
      identity?: {
        version: 1;
        executor: string;
        backend: string;
        promptBinding?: typeof promptBinding;
      };
    }): Promise<WorkflowExecutorExecution>;
  };
}

function runOptions(root: string) {
  return {
    runId: "run-1",
    childSessionsDir: join(root, "sessions"),
    cancellationError: (signal: AbortSignal) => Object.assign(new Error("cancelled"), { signal }),
  };
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-wiring-"));
  projectConfig(root, { execution: { profile: "managed", backend: "embedded" } });
  new ProjectTrustStore(getAgentDir()).set(root, true);
  roots.push(root);
  return root;
}

function projectConfig(cwd: string, value: unknown): void {
  const file = join(cwd, ".pi", "pi-workflow.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { assertion(); return; } catch (error) { last = error; await tick(); }
  }
  throw last;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi executor discovery", () => {
  it("fails closed when the selected executor is missing", async () => {
    const root = workspace();
    const host = fakePi();
    const runtime = installPiWorkflowExecution(host.pi);
    expect(getWorkflowExecutionProvider()).toBeUndefined();
    await host.start();
    await expect(provider().createHost(observer(root, "a"), runOptions(root))).rejects.toThrow(/No compatible workflow executor/);
    await runtime.close();
  });

  it("fails closed on ambiguous offers", async () => {
    const root = workspace();
    const host = fakePi();
    const candidate = offer((request) => executionFor(request));
    registerOffer(host.bus, candidate);
    registerOffer(host.bus, candidate);
    const runtime = installPiWorkflowExecution(host.pi);
    await host.start();
    await expect(provider().createHost(observer(root, "a"), runOptions(root))).rejects.toThrow(/offered 2 times/);
    await runtime.close();
  });

  it("ignores offers made after emit returns without throwing into the executor", () => {
    const bus = new SyncBus();
    let query: WorkflowExecutorDiscovery | undefined;
    bus.on(WORKFLOW_EXECUTOR_DISCOVERY, (raw) => { query = raw as WorkflowExecutorDiscovery; });
    expect(() => discoverExecutor(bus, "pi-subagents", "embedded")).toThrow(/No compatible workflow executor/);
    expect(() => query!.offer(offer((request) => executionFor(request)))).not.toThrow();
  });

  it("snapshots offer fields and invokes the snapshotted factory with its original this", () => {
    const bus = new SyncBus();
    let receiver: unknown;
    const candidate: WorkflowExecutorOffer = {
      version: 1,
      id: "pi-subagents",
      backends: ["embedded"],
      createExecution(this: unknown, request) {
        receiver = this;
        return executionFor(request);
      },
    };
    bus.on(WORKFLOW_EXECUTOR_DISCOVERY, (raw) => {
      (raw as WorkflowExecutorDiscovery).offer(candidate);
      (candidate as { id: string }).id = "mutated";
      (candidate as { backends: WorkflowExecutorOffer["backends"] }).backends = ["terminal"];
    });

    const admitted = discoverExecutor(bus, "pi-subagents", "embedded");
    expect(admitted.id).toBe("pi-subagents");
    expect(admitted.backends).toEqual(["embedded"]);
    const root = workspace();
    const request = {
      observer: observer(root, "snapshot"),
      run: { runId: "snapshot", childSessionsDir: join(root, "sessions") },
      settings: { profile: "managed" as const, backend: "embedded" as const },
      cancellationError: () => new Error("cancelled"),
    };
    admitted.createExecution(request);
    expect(receiver).toBe(candidate);
  });

  it("captures offer getter failures inside the discovery callback", () => {
    const bus = new SyncBus();
    const getterError = new Error("getter exploded");
    const candidate = Object.defineProperty({}, "version", { get() { throw getterError; } });
    let callbackThrew = false;
    bus.on(WORKFLOW_EXECUTOR_DISCOVERY, (raw) => {
      try { (raw as WorkflowExecutorDiscovery).offer(candidate as WorkflowExecutorOffer); }
      catch { callbackThrew = true; }
    });
    expect(() => discoverExecutor(bus, "pi-subagents", "embedded")).toThrow(/getter exploded/);
    expect(callbackThrew).toBe(false);
  });
});

describe("Pi executor forwarding and ownership", () => {
  it("reads settings per run, forwards the live observer/error factory/signal, and keeps saved backend identity sticky", async () => {
    const root = workspace();
    projectConfig(root, {
      execution: { profile: "managed", backend: "embedded", maxConcurrency: 9 },
      models: {
        defaults: { model: "test/default", thinking: "medium" },
        skills: { review: { thinking: "off" } },
      },
    });
    const host = fakePi();
    const requests: WorkflowExecutorRequest[] = [];
    registerOffer(host.bus, offer((request) => { requests.push(request); return executionFor(request); }));
    const runtime = installPiWorkflowExecution(host.pi);
    await host.start();
    const current = observer(root, "current");
    const signal = new AbortController().signal;
    const cancellationError = (input: AbortSignal) => Object.assign(new Error("stop"), { input });
    const identity = { version: 1 as const, executor: "pi-subagents", backend: "terminal", promptBinding };

    const first = await provider().createHost(current, {
      ...runOptions(root), cancellationError, signal, identity,
    });
    expect(requests[0]?.observer).toBe(current);
    expect(requests[0]?.cancellationError).toBe(cancellationError);
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(requests[0]?.signal).not.toBe(signal);
    expect(requests[0]!.signal!.aborted).toBe(false);
    expect(requests[0]?.settings).toMatchObject({ profile: "managed", backend: "embedded", maxConcurrency: 9 });
    expect(requests[0]?.identity).toEqual(identity);
    expect(first.identity.backend).toBe("terminal");
    expect(first.resolveModel?.({ workflow: "flow", stage: "work", skill: "review" }))
      .toEqual({ model: "test/default", thinking: "off" });

    projectConfig(root, { execution: { profile: "managed", backend: "terminal", maxConcurrency: 2 } });
    const newer = observer(root, "newer");
    await provider().createHost(newer, { ...runOptions(root), runId: "run-2" });
    expect(requests[1]?.observer).toBe(newer);
    expect(requests[1]?.settings).toMatchObject({ profile: "managed", backend: "terminal", maxConcurrency: 2 });
    await runtime.close();
  });

  it("rejects configured-versus-saved executor mismatch before invoking any factory", async () => {
    const root = workspace();
    projectConfig(root, { execution: { executor: "different-executor" } });
    const host = fakePi();
    const createExecution = vi.fn((request: WorkflowExecutorRequest) => executionFor(request));
    registerOffer(host.bus, offer(createExecution));
    const runtime = installPiWorkflowExecution(host.pi);
    await host.start();
    await expect(provider().createHost(observer(root, "mismatch"), {
      ...runOptions(root),
      identity: { version: 1, executor: "pi-subagents", backend: "embedded", promptBinding },
    })).rejects.toThrow(/does not match configured executor/);
    expect(createExecution).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("identifies only the Pi workflow adapter provider", async () => {
    const host = fakePi();
    const runtime = installPiWorkflowExecution(host.pi);
    expect(getWorkflowExecutionProvider()).toBeUndefined();
    await host.start();
    expect(isPiWorkflowExecutionProvider(getWorkflowExecutionProvider())).toBe(true);
    expect(isPiWorkflowExecutionProvider({ createHost: vi.fn() })).toBe(false);
    await runtime.close();
  });

  it("an old reload unregister cannot remove the newer same-bus provider", async () => {
    const host = fakePi();
    const first = installPiWorkflowExecution(host.pi);
    await host.start();
    const oldProvider = getWorkflowExecutionProvider();
    const second = installPiWorkflowExecution(host.pi);
    expect(getWorkflowExecutionProvider()).toBe(oldProvider);
    await host.start();
    const newProvider = getWorkflowExecutionProvider();
    expect(newProvider).toBeDefined();
    expect(newProvider).not.toBe(oldProvider);

    await first.close();
    expect(getWorkflowExecutionProvider()).toBe(newProvider);
    await second.close();
    expect(getWorkflowExecutionProvider()).toBeUndefined();
  });

  it("a child event bus cannot replace the root-owned provider", async () => {
    const root = fakePi();
    const child = fakePi();
    const rootRuntime = installPiWorkflowExecution(root.pi);
    await root.start();
    const rootProvider = getWorkflowExecutionProvider();
    const childRuntime = installPiWorkflowExecution(child.pi);
    await child.start();
    expect(childRuntime.installed).toBe(false);
    expect(getWorkflowExecutionProvider()).toBe(rootProvider);
    await childRuntime.close();
    await rootRuntime.close();
  });

  it("shutdown waits for pending creation and closes the late execution", async () => {
    const root = workspace();
    const host = fakePi();
    let resolveExecution!: (execution: WorkflowExecutorExecution) => void;
    let request!: WorkflowExecutorRequest;
    const pending = new Promise<WorkflowExecutorExecution>((resolve) => { resolveExecution = resolve; });
    const closeExecution = vi.fn(async () => {});
    registerOffer(host.bus, offer((input) => { request = input; return pending; }));
    const runtime = installPiWorkflowExecution(host.pi);
    await host.start();
    const creation = provider().createHost(observer(root, "a"), runOptions(root));
    await tick();
    expect(request).toBeDefined();
    const observed = creation.then(
      () => new Error("pending creation unexpectedly admitted"),
      (error: unknown) => error as Error,
    );
    const closing = runtime.close();
    resolveExecution(executionFor(request, closeExecution));
    expect((await observed).message).toBe("cancelled");
    await closing;
    expect(closeExecution).toHaveBeenCalledTimes(1);
  });
});

describe("actual /wf command wiring", () => {
  it("registers the real handler and executes a script workflow through the discovered executor", async () => {
    const root = workspace();
    const host = fakePi();
    let ran = 0;
    const closeExecution = vi.fn(async () => {});
    registerBuiltIns([defineWorkflow({
      name: "wired",
      start: "tick",
      stages: { tick: acts.script({ run: () => { ran++; } }) },
      edges: { tick: "stop" },
    })]);
    registerOffer(host.bus, offer((request) => executionFor(request, closeExecution)));
    const runtime = installPiWorkflowExecution(host.pi);
    registerWorkflowCommand(host.pi, host.pi);
    await host.start();
    const handler = host.commands.get("wf")?.handler;
    expect(handler).toBeDefined();

    const current = observer(root, "launcher", "rpc");
    const ctx = current as unknown as WorkflowLauncherContext;
    await handler!("wired run it", ctx);
    expect(current.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/^\[workflow\] rpiv: loading workflow runtime/),
      "info",
    );
    await eventually(() => expect(ran).toBe(1));
    await eventually(() => expect(closeExecution).toHaveBeenCalled());
    await runtime.close();
  });
});
