import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadWorkflowConfig, workflowExecutorSettings } from "./config.js";
import {
  getWorkflowExecutionProvider,
  registerWorkflowExecutionHost,
  type WorkflowExecution,
  type WorkflowExecutionIdentity,
  type WorkflowExecutionProvider,
} from "./execution-host.js";
import type { ModelSelection, WorkflowHostContext } from "./host.js";
import { i18n, notifyWorkflow } from "./i18n.js";
import {
  WORKFLOW_EXECUTOR_DISCOVERY,
  WORKFLOW_EXECUTOR_VERSION,
  type WorkflowExecutorBackend,
  type WorkflowExecutorDiscovery,
  type WorkflowExecutorExecution,
  type WorkflowExecutorIdentity,
  type WorkflowExecutorOffer,
  type WorkflowExecutorRequest,
  type WorkflowExecutorRunOptions,
} from "./pi-protocol.js";
import type { BranchEntry } from "./transcript.js";

interface ProviderCreateOptions extends WorkflowExecutorRunOptions {
  readonly cancellationError: (signal: AbortSignal) => Error;
  readonly signal?: AbortSignal;
  readonly identity?: WorkflowExecutionIdentity;
}

interface ProviderExecution extends WorkflowExecution {
  readonly host: WorkflowHostContext;
  readonly identity: WorkflowExecutionIdentity;
  close(): Promise<void>;
  dispose(): void | Promise<void>;
  readSessionBranch(file: string): BranchEntry[] | undefined;
  resolveModel?(id: { workflow: string; stage: string; skill: string }): ModelSelection | undefined;
}

interface OwnedProvider extends WorkflowExecutionProvider {
  readonly [PROVIDER_OWNER]: { events: EventBus };
}

interface RunControl {
  readonly runId: string;
  readonly controller: AbortController;
  readonly cancellationError: (signal: AbortSignal) => Error;
  acquisition?: Promise<ProviderExecution>;
  active?: ActiveExecution;
  retirement?: Promise<void>;
  cancellation?: Promise<void>;
}

interface ActiveExecution {
  readonly execution: WorkflowExecutorExecution;
  readonly control: RunControl;
  closePromise?: Promise<void>;
}

export interface PiWorkflowExecutionRuntime {
  readonly installed: boolean;
  activeRunIds(): readonly string[];
  cancelRun(runId: string): Promise<boolean>;
  cancelAll(): Promise<readonly string[]>;
  close(): Promise<void>;
}

/** Marker only; provider state remains owned by execution-host's public registrar. */
const PROVIDER_OWNER = Symbol.for("pi-workflow.execution-provider-owner.v1");

/** Narrow generic providers without importing another product or inspecting globals. */
export function isPiWorkflowExecutionProvider(value: unknown): value is WorkflowExecutionProvider {
  try {
    return !!value && typeof value === "object" && PROVIDER_OWNER in value;
  } catch {
    return false;
  }
}

/**
 * Install the Pi-facing workflow execution provider. Discovery is deliberately
 * performed for every run so extension load order and executor reloads do not
 * leave a stale captured offer.
 */
export function installPiWorkflowExecution(
  pi: Pick<ExtensionAPI, "events" | "on">,
): PiWorkflowExecutionRuntime {
  // Embedded child loaders share the workflow execution-host registry with the
  // root process. A provider already owned by a different event bus belongs to
  // that root; do not let the child replace it with a bus that has no root
  // executor listeners. Same-bus replacement remains allowed for /reload.
  const existing = getWorkflowExecutionProvider();
  if (isPiWorkflowExecutionProvider(existing) && (existing as OwnedProvider)[PROVIDER_OWNER].events !== pi.events) {
    return noopRuntime();
  }

  let closed = false;
  let closing: Promise<void> | undefined;
  const runs = new Map<string, RunControl>();
  const active = new Set<ActiveExecution>();
  const pending = new Set<Promise<ProviderExecution>>();
  const retiring = new Set<Promise<void>>();
  const retirementErrors: unknown[] = [];

  const provider: OwnedProvider = {
    [PROVIDER_OWNER]: Object.freeze({ events: pi.events }),
    createHost(observer: WorkflowHostContext, run: ProviderCreateOptions): Promise<ProviderExecution> {
      if (closed) return Promise.reject(failure("provider.closed"));
      try {
        validateRunOptions(run);
      } catch (error) {
        return Promise.reject(error);
      }
      if (runs.has(run.runId)) return Promise.reject(failure("execution.duplicateRun", { runId: run.runId }));

      const control: RunControl = {
        runId: run.runId,
        controller: new AbortController(),
        cancellationError: run.cancellationError,
      };
      runs.set(run.runId, control);
      // Defer acquisition by one microtask so the complete operation is
      // published to close/cancel before config, discovery or factory code runs.
      const acquisition = Promise.resolve().then(() => acquire(control, observer, run));
      control.acquisition = acquisition;
      pending.add(acquisition);
      void acquisition.then(
        () => pending.delete(acquisition),
        () => {
          pending.delete(acquisition);
          removeRun(control);
        },
      );
      return acquisition;
    },
  };

  const unregister = registerWorkflowExecutionHost(provider);
  let offShutdown: (() => void) | undefined;
  offShutdown = pi.on("session_shutdown", async () => {
    await close();
  });

  async function acquire(
    control: RunControl,
    observer: WorkflowHostContext,
    run: ProviderCreateOptions,
  ): Promise<ProviderExecution> {
    const signal = combineSignals(control.controller.signal, run.signal, observer.signal)!;
    if (signal.aborted) throw cancellationFor(control, signal);
    if (closed) throw failure("provider.closed");

    const config = loadWorkflowConfig(observer.cwd);
    const identity = protocolIdentity(run.identity);
    if (identity !== undefined && identity.executor !== config.execution.executor) {
      throw failure("execution.executorMismatch", {
        configured: config.execution.executor,
        saved: identity.executor,
      });
    }
    const executor = discoverExecutor(
      pi.events,
      config.execution.executor,
      identity?.backend ?? config.execution.backend,
    );
    if (signal.aborted) throw cancellationFor(control, signal);
    if (closed) throw failure("provider.closed");

    const request: WorkflowExecutorRequest = Object.freeze({
      observer,
      run: freezeRun(run),
      settings: workflowExecutorSettings(config),
      cancellationError: run.cancellationError,
      signal,
      ...(identity !== undefined ? { identity } : {}),
    });

    let execution: WorkflowExecutorExecution;
    try {
      execution = await executor.createExecution(request);
    } catch (error) {
      throw asError(error);
    }
    try {
      validateExecution(execution, executor.id);
    } catch (validationError) {
      const cleanup = closeRejectedExecution(control, execution);
      if (cleanup) {
        try {
          await cleanup;
        } catch (cleanupError) {
          throw new AggregateError(
            [validationError, cleanupError],
            i18n.t("execution.invalidAndCleanupFailed", { executor: executor.id }),
          );
        }
      }
      throw validationError;
    }

    const record: ActiveExecution = { execution, control };
    control.active = record;
    active.add(record);
    if (signal.aborted || closed) {
      await retire(record);
      if (signal.aborted) throw cancellationFor(control, signal);
      throw failure("provider.closed");
    }
    return wrapExecution(record, signal);
  }

  function wrapExecution(record: ActiveExecution, signal: AbortSignal): ProviderExecution {
    const execution = record.execution;
    const closeExecution = () => retire(record);
    return {
      host: execution.host,
      signal: combineSignals(signal, execution.signal),
      identity: execution.identity,
      readSessionBranch: (file) => execution.readSessionBranch(file),
      ...(execution.resolveModel ? { resolveModel: execution.resolveModel.bind(execution) } : {}),
      close: closeExecution,
      dispose: closeExecution,
    };
  }

  function prepareRetirement(): { promise: Promise<void>; start(invoke: () => void | Promise<void>): void } {
    let resolveBarrier!: () => void;
    let rejectBarrier!: (error: unknown) => void;
    let started = false;
    const barrier = new Promise<void>((resolve, reject) => {
      resolveBarrier = resolve;
      rejectBarrier = reject;
    });
    retiring.add(barrier);
    void barrier.then(
      () => retiring.delete(barrier),
      () => retiring.delete(barrier),
    );
    return {
      promise: barrier,
      start(invoke) {
        if (started) return;
        started = true;
        const reject = (error: unknown) => {
          recordUnique(retirementErrors, error);
          rejectBarrier(error);
        };
        try {
          Promise.resolve(invoke()).then(resolveBarrier, reject);
        } catch (error) {
          reject(error);
        }
      },
    };
  }

  function retire(record: ActiveExecution): Promise<void> {
    if (record.closePromise) return record.closePromise;
    active.delete(record);
    const retirement = prepareRetirement();
    // Publish every owner-visible reference before calling executor code:
    // close() is allowed to reenter both wrapper and root retirement.
    record.closePromise = retirement.promise;
    record.control.retirement = retirement.promise;
    void retirement.promise.then(
      () => removeRun(record.control),
      () => removeRun(record.control),
    );
    retirement.start(() => record.execution.close());
    return retirement.promise;
  }

  function closeRejectedExecution(control: RunControl, value: unknown): Promise<void> | undefined {
    if (!value || typeof value !== "object") return undefined;
    let close: unknown;
    try {
      close = (value as { close?: unknown }).close;
    } catch (error) {
      const retirement = prepareRetirement();
      control.retirement = retirement.promise;
      retirement.start(() => { throw error; });
      return retirement.promise;
    }
    if (typeof close !== "function") return undefined;
    const retirement = prepareRetirement();
    control.retirement = retirement.promise;
    retirement.start(() => close.call(value));
    return retirement.promise;
  }

  function cancelControl(control: RunControl): Promise<void> {
    if (control.cancellation) return control.cancellation;
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    const barrier = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // Publish before aborting: abort listeners and close callbacks may reenter.
    control.cancellation = barrier;
    try {
      control.controller.abort();
    } catch (error) {
      fail(error);
      return barrier;
    }
    void (async () => {
      if (control.active) {
        await retire(control.active);
      } else if (control.acquisition) {
        await Promise.allSettled([control.acquisition]);
        if (control.active) await retire(control.active);
        else if (control.retirement) await control.retirement;
      }
    })().then(finish, fail);
    return barrier;
  }

  function activeRunIds(): readonly string[] {
    return Object.freeze([...runs.keys()].sort());
  }

  async function cancelRun(runId: string): Promise<boolean> {
    const control = runs.get(runId);
    if (!control) return false;
    await cancelControl(control);
    return true;
  }

  async function cancelAll(): Promise<readonly string[]> {
    const selected = [...activeRunIds()]
      .map((runId) => ({ runId, control: runs.get(runId) }))
      .filter((entry): entry is { runId: string; control: RunControl } => entry.control !== undefined);
    const results = await Promise.allSettled(selected.map(({ control }) => cancelControl(control)));
    const errors: unknown[] = [];
    for (const result of results) if (result.status === "rejected") recordUnique(errors, result.reason);
    throwCollected(errors, "cancel.failedMultiple");
    return Object.freeze(selected.map(({ runId }) => runId));
  }

  function close(): Promise<void> {
    if (closing) return closing;
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    const barrier = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // Publish the one shared barrier before any unregister, hook, abort or
    // executor-close callback can reenter runtime.close().
    closing = barrier;
    closed = true;
    const sideEffectErrors: unknown[] = [];
    try { unregister(); } catch (error) { recordUnique(sideEffectErrors, error); }
    try { offShutdown?.(); } catch (error) { recordUnique(sideEffectErrors, error); }
    for (const control of runs.values()) {
      try { control.controller.abort(); } catch (error) { recordUnique(sideEffectErrors, error); }
    }
    void (async () => {
      await Promise.allSettled([...active].map(retire));
      while (pending.size > 0) await Promise.allSettled([...pending]);
      await Promise.allSettled([...active].map(retire));
      while (retiring.size > 0) await Promise.allSettled([...retiring]);
      const errors = [...sideEffectErrors];
      for (const error of retirementErrors) recordUnique(errors, error);
      throwCollected(errors, "provider.closeFailed");
    })().then(finish, fail);
    return barrier;
  }

  function removeRun(control: RunControl): void {
    if (runs.get(control.runId) === control) runs.delete(control.runId);
  }

  return { installed: true, activeRunIds, cancelRun, cancelAll, close };
}

/** Register the additive cancellation command without widening install()'s test seam. */
export function registerWorkflowCancellationCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  runtime: PiWorkflowExecutionRuntime,
): void {
  pi.registerCommand("wf-cancel", {
    description: i18n.t("cancel.description"),
    handler: async (args, ctx) => {
      const requested = args.trim();
      const ids = [...runtime.activeRunIds()];
      if (!requested) {
        if (ids.length === 0) {
          notifyWorkflow(ctx, i18n.t("cancel.none"), "info");
          return;
        }
        if (ids.length > 1) {
          notifyWorkflow(ctx, i18n.t("cancel.choose", { runs: ids.join(", ") }), "info");
          return;
        }
        await cancelOne(ids[0]!, ctx);
        return;
      }
      if (requested === "all") {
        if (ids.length === 0) {
          notifyWorkflow(ctx, i18n.t("cancel.none"), "info");
          return;
        }
        notifyWorkflow(ctx, i18n.t("cancel.startAll", { count: ids.length, runs: ids.join(", ") }), "info");
        try {
          await runtime.cancelAll();
          notifyWorkflow(ctx, i18n.t("cancel.doneAll", { count: ids.length }), "info");
        } catch (error) {
          notifyWorkflow(ctx, i18n.t("cancel.failed", { error: errorText(error) }), "error");
        }
        return;
      }
      if (!ids.includes(requested)) {
        notifyWorkflow(ctx, i18n.t("cancel.unknown", { runId: requested }), "warning");
        return;
      }
      await cancelOne(requested, ctx);
    },
  });

  async function cancelOne(runId: string, ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]): Promise<void> {
    notifyWorkflow(ctx, i18n.t("cancel.start", { runId }), "info");
    try {
      const found = await runtime.cancelRun(runId);
      notifyWorkflow(ctx, found ? i18n.t("cancel.done", { runId }) : i18n.t("cancel.unknown", { runId }), found ? "info" : "warning");
    } catch (error) {
      notifyWorkflow(ctx, i18n.t("cancel.failed", { error: errorText(error) }), "error");
    }
  }
}

/** Discover exactly one compatible offer during this synchronous event turn. */
export function discoverExecutor(
  events: EventBus,
  executorId: string,
  backend: WorkflowExecutorBackend,
): WorkflowExecutorOffer {
  const offers: WorkflowExecutorOffer[] = [];
  const errors: Error[] = [];
  let accepting = true;
  const query: WorkflowExecutorDiscovery = Object.freeze({
    version: WORKFLOW_EXECUTOR_VERSION,
    offer(candidate: WorkflowExecutorOffer) {
      if (!accepting) return;
      try {
        const snapshot = snapshotOffer(candidate);
        if (snapshot.id === executorId) offers.push(snapshot);
      } catch (error) {
        errors.push(asError(error));
      }
    },
  });
  try {
    events.emit(WORKFLOW_EXECUTOR_DISCOVERY, query);
  } catch (error) {
    errors.push(asError(error));
  } finally {
    accepting = false;
  }

  if (errors.length > 0) {
    throw failure("discovery.invalidOffer", { error: errors.map((error) => error.message).join("; ") });
  }
  if (offers.length === 0) throw failure("discovery.missing", { executor: executorId });
  if (offers.length > 1) throw failure("discovery.ambiguous", { executor: executorId, count: offers.length });
  const offer = offers[0]!;
  if (!offer.backends.includes(backend)) {
    throw failure("discovery.unsupportedBackend", { executor: executorId, backend });
  }
  return offer;
}

function snapshotOffer(value: unknown): WorkflowExecutorOffer {
  if (!value || typeof value !== "object") throw failure("discovery.offerObject");
  const candidate = value as Partial<WorkflowExecutorOffer>;
  const version = candidate.version;
  const id = candidate.id;
  const rawBackends = candidate.backends;
  const factory = candidate.createExecution;
  if (version !== WORKFLOW_EXECUTOR_VERSION) throw failure("discovery.offerVersion");
  if (typeof id !== "string" || !id.trim()) throw failure("discovery.offerId");
  if (!Array.isArray(rawBackends) || rawBackends.length === 0) {
    throw failure("discovery.offerBackends", { executor: id });
  }
  const backends = rawBackends.map((backend) => {
    if (!isBackend(backend)) throw failure("discovery.offerBackends", { executor: id });
    return backend;
  });
  if (typeof factory !== "function") throw failure("discovery.offerFactory", { executor: id });
  return Object.freeze({
    version: WORKFLOW_EXECUTOR_VERSION,
    id,
    backends: Object.freeze(backends),
    createExecution: factory.bind(value),
  });
}

function validateExecution(value: unknown, executorId: string): asserts value is WorkflowExecutorExecution {
  if (!value || typeof value !== "object") throw failure("execution.invalid", { executor: executorId });
  const execution = value as Partial<WorkflowExecutorExecution>;
  if (!execution.host || typeof execution.close !== "function" || typeof execution.dispose !== "function"
    || typeof execution.readSessionBranch !== "function" || !execution.identity) {
    throw failure("execution.invalid", { executor: executorId });
  }
  const identity = execution.identity;
  if (identity.version !== 1 || identity.executor !== executorId || !isBackend(identity.backend)
    || !validPromptBinding(identity.promptBinding)) {
    throw failure("execution.invalidIdentity", { executor: executorId });
  }
}

function validateRunOptions(run: ProviderCreateOptions): void {
  if (!run || typeof run !== "object" || !run.runId?.trim() || typeof run.childSessionsDir !== "string"
    || typeof run.cancellationError !== "function"
    || (run.signal !== undefined && !(run.signal instanceof AbortSignal))) {
    throw failure("execution.invalidRequest");
  }
}

function freezeRun(run: ProviderCreateOptions): WorkflowExecutorRunOptions {
  return Object.freeze({
    runId: run.runId,
    childSessionsDir: run.childSessionsDir,
    ...(run.name !== undefined ? { name: run.name } : {}),
    ...(run.workflow !== undefined ? { workflow: run.workflow } : {}),
    ...(run.input !== undefined ? { input: run.input } : {}),
  });
}

function protocolIdentity(identity: WorkflowExecutionIdentity | undefined): WorkflowExecutorIdentity | undefined {
  if (identity === undefined) return undefined;
  if (identity.version !== 1 || !identity.executor?.trim() || !isBackend(identity.backend)
    || !validPromptBinding(identity.promptBinding)) {
    throw failure("execution.savedIdentity");
  }
  return Object.freeze({
    version: 1,
    executor: identity.executor,
    backend: identity.backend,
    promptBinding: Object.freeze({ ...identity.promptBinding }),
  });
}

function validPromptBinding(value: unknown): value is WorkflowExecutorIdentity["promptBinding"] {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<WorkflowExecutorIdentity["promptBinding"]>;
  return typeof binding.resolverId === "string" && !!binding.resolverId
    && typeof binding.resourceSetDigest === "string" && !!binding.resourceSetDigest
    && binding.assetMode === "live";
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const unique = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  return AbortSignal.any(unique);
}

function cancellationFor(control: RunControl, signal: AbortSignal): Error {
  try {
    const error = control.cancellationError(signal);
    return error instanceof Error ? error : failure("execution.invalidRequest");
  } catch (error) {
    return asError(error);
  }
}

function isBackend(value: unknown): value is WorkflowExecutorBackend {
  return value === "embedded" || value === "terminal";
}

function noopRuntime(): PiWorkflowExecutionRuntime {
  const done = Promise.resolve();
  return {
    installed: false,
    activeRunIds: () => Object.freeze([]),
    cancelRun: async () => false,
    cancelAll: async () => Object.freeze([]),
    close: () => done,
  };
}

function recordUnique(errors: unknown[], error: unknown): void {
  if (!errors.includes(error)) errors.push(error);
}

function throwCollected(errors: unknown[], multipleKey: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, i18n.t(multipleKey));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function failure(key: string, params?: Record<string, string | number>): Error {
  return new Error(i18n.t(key, params));
}
