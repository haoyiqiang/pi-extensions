import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  SessionManager,
  type AgentSession,
  type ExtensionContext,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { assertRequiredTools } from "../backends/tool-requirements.js";
import { createEmbeddedInvocationPolicy, invokeEmbeddedSession, rememberEmbeddedPolicy } from "../backends/embedded-invocation.js";
import { getGraceTurns } from "../agent-runner.js";
import type { ExecutionBackendKind } from "../backends/session-reference.js";
import { runInChildSessionContext } from "../child-context.js";
import { i18n } from "../i18n.js";
import type {
  WorkflowChildOptions,
  WorkflowHostContext,
  WorkflowModelSelection,
  WorkflowObserverContext,
  WorkflowSessionContext,
} from "./execution-contract.js";
import { armStandardBashWatchdog, type StandardBashWatchdog } from "./standard-bash-timeout.js";
import { createStandardWorkflowUi } from "./standard-ui.js";
import {
  createStandardWorkflowServices,
  type StandardWorkflowRuntimeFactory,
  type StandardWorkflowRuntimeInitializer,
} from "./standard-resources.js";

export const STANDARD_WORKFLOW_MAX_NESTING = 2;
const SDK_TEARDOWN_TIMEOUT_MS = 10_000;

type ModelRuntime = AgentSession["modelRuntime"];
type ThinkingLevel = AgentSession["thinkingLevel"];

export interface StandardWorkflowExecutionHostOptions {
  ctx: ExtensionContext;
  observer: WorkflowObserverContext;
  runId: string;
  backend: ExecutionBackendKind;
  childSessionsDir: string;
  maxConcurrency?: number;
  maxTurns?: number;
  requiredTools?: readonly string[];
  initializeRuntime?: StandardWorkflowRuntimeInitializer;
  createRuntime?: StandardWorkflowRuntimeFactory;
  signal?: AbortSignal;
  cancellationError: (signal: AbortSignal) => Error;
}

interface ChildScope {
  readonly controller: AbortController;
  readonly detach: () => void;
  session?: AgentSession;
  watchdog?: StandardBashWatchdog;
  pending?: Promise<void>;
  lastInvocation: Promise<void>;
  nativeInvocation?: Promise<void>;
  abortPromise?: Promise<void>;
  abortFailure?: unknown;
  closed: boolean;
}

/** Standard SDK/resource-compatible workflow host over native Pi sessions. */
export class StandardWorkflowExecutionHost implements WorkflowHostContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly maxConcurrency: number;
  readonly signal: AbortSignal;
  readonly ui: WorkflowObserverContext["ui"];
  readonly sessionManager: WorkflowObserverContext["sessionManager"];

  private readonly options: StandardWorkflowExecutionHostOptions;
  private readonly controller = new AbortController();
  private readonly detach: () => void;
  private readonly scopes = new Set<ChildScope>();
  private readonly invocations = new Set<Promise<unknown>>();
  private readonly retirementErrors: unknown[] = [];
  private readonly modelRuntime: ModelRuntime;
  private readonly parentModel: Model<any> | undefined;
  private readonly parentThinking: ThinkingLevel;
  private disposed = false;
  private closing?: Promise<void>;

  constructor(options: StandardWorkflowExecutionHostOptions) {
    if (!options.runId?.trim() || !isAbsolute(options.childSessionsDir)
      || !Number.isSafeInteger(options.maxConcurrency ?? 4) || (options.maxConcurrency ?? 4) < 1
      || !validSignal(options.signal) || !validSignal(options.observer.signal)
      || typeof options.cancellationError !== "function") {
      throw failure("invalidOptions");
    }
    this.cwd = realpathSync(options.ctx.cwd);
    if (realpathSync(options.observer.cwd) !== this.cwd) throw failure("cwdMismatch");

    const modelRuntime = (options.ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
    if (!modelRuntime) throw failure("invalidOptions");
    this.modelRuntime = modelRuntime;
    this.parentModel = options.ctx.model;
    this.parentThinking = options.ctx.thinkingLevel ?? "off";

    // Snapshot guarded launcher values before detached work outlives that context.
    const projectTrusted = options.ctx.isProjectTrusted();
    const id = options.observer.sessionManager.getSessionId();
    const file = options.observer.sessionManager.getSessionFile();
    const branch = structuredClone(options.observer.sessionManager.getBranch());
    const ctx = Object.create(options.ctx, {
      cwd: { value: this.cwd },
      hasUI: { value: options.ctx.hasUI },
      mode: { value: options.ctx.mode },
      ui: { value: options.ctx.ui },
      model: { value: this.parentModel },
      thinkingLevel: { value: this.parentThinking },
      modelRegistry: { value: options.ctx.modelRegistry },
      isProjectTrusted: { value: () => projectTrusted },
    }) as ExtensionContext;

    this.options = Object.freeze({ ...options, ctx });
    this.hasUI = options.observer.hasUI;
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.ui = options.observer.ui;
    this.sessionManager = {
      getSessionId: () => id,
      getSessionFile: () => file,
      getBranch: () => structuredClone(branch),
    };
    this.signal = this.controller.signal;
    this.detach = linkSignals(this.controller, [options.signal, options.observer.signal]);
  }

  spawnChild<T>(input: WorkflowChildOptions<T>): Promise<T> {
    this.assertActive(this.signal);
    if (!input || typeof input.prompt !== "string" || typeof input.withSession !== "function"
      || !validSignal(input.signal) || !validSource(input.reattach) || !validSource(input.fork)
      || (input.reattach !== undefined && input.fork !== undefined)) {
      return Promise.reject(failure("invalidOptions"));
    }
    return this.spawnAtDepth(0, {
      ...input,
      model: input.model && { ...input.model },
      reattach: input.reattach && { ...input.reattach },
      fork: input.fork && { ...input.fork },
    });
  }

  async waitForIdle(): Promise<void> {
    while (this.invocations.size > 0) await Promise.allSettled([...this.invocations]);
    this.assertActive(this.signal);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const pending = deferredClose();
    // Publish before abort: signal listeners and extension shutdown can reenter.
    this.closing = pending.promise;
    this.disposed = true;
    const sideEffectErrors: unknown[] = [];
    try { this.controller.abort(); } catch (error) { sideEffectErrors.push(error); }
    try { this.detach(); } catch (error) { sideEffectErrors.push(error); }

    void (async () => {
      while (this.invocations.size > 0) await Promise.allSettled([...this.invocations]);
      const errors = [...sideEffectErrors, ...this.retirementErrors];
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, i18n.t("workflowExecution.cleanupFailed"));
    })().then(pending.resolve, pending.reject);
    return this.closing;
  }

  private spawnAtDepth<T>(depth: number, input: WorkflowChildOptions<T>): Promise<T> {
    if (depth > STANDARD_WORKFLOW_MAX_NESTING) return Promise.reject(failure("invalidOptions"));
    this.assertActive(this.signal);

    const controller = new AbortController();
    const detach = linkSignals(controller, [this.signal, input.signal]);
    const scope: ChildScope = {
      controller,
      detach,
      lastInvocation: Promise.resolve(),
      closed: false,
    };
    this.scopes.add(scope);

    const task = runInChildSessionContext(() => this.runChild(scope, depth, input));
    this.invocations.add(task);
    const done = () => { this.invocations.delete(task); };
    void task.then(done, done);
    return task;
  }

  private async runChild<T>(scope: ChildScope, depth: number, input: WorkflowChildOptions<T>): Promise<T> {
    let value: T | undefined;
    let primaryFailure: unknown;
    let cleanupFailure: unknown;
    let primaryFailed = false;
    let cleanupFailed = false;
    try {
      this.assertScope(scope);
      const manager = this.createSessionManager(input);
      const inherited = manager.buildSessionContext();
      const source = input.reattach ?? input.fork;
      const explicitModel = this.resolveModel(input.model);
      const services = await createStandardWorkflowServices({
        cwd: this.cwd,
        runId: this.options.runId,
        backend: this.options.backend,
        projectTrusted: this.options.ctx.isProjectTrusted(),
        modelRuntime: this.modelRuntime,
        initializeRuntime: this.options.initializeRuntime,
        createRuntime: this.options.createRuntime,
      });
      this.assertScope(scope);

      // An absent workflow override must preserve native SDK selection:
      // fresh sessions use settings defaults, while restored sessions recover
      // their persisted model/thinking metadata. The launcher snapshot belongs
      // to the observer/runtime facade, not the stage model baseline.
      const model = explicitModel;
      const thinkingLevel = input.model?.thinking;
      const { session } = await createAgentSessionFromServices({
        services,
        sessionManager: manager,
        ...(model ? { model } : {}),
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      });
      scope.session = session;
      this.assertScope(scope);
      rememberEmbeddedPolicy(session, createEmbeddedInvocationPolicy({
        maxTurns: this.options.maxTurns,
        graceTurns: this.options.maxTurns === undefined ? undefined : getGraceTurns(),
      }));
      scope.watchdog = armStandardBashWatchdog(session, error => {
        scope.abortFailure ??= error;
        scope.controller.abort(error);
      });
      this.persistRestoredOverrides(session, inherited, source !== undefined, explicitModel, input.model);

      const onAbort = () => { this.startSessionAbort(scope); };
      scope.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (scope.controller.signal.aborted) onAbort();
      try {
        await session.bindExtensions({
          uiContext: createStandardWorkflowUi(this.options.ctx.ui, scope.controller.signal, this.options.ctx.mode),
          mode: this.options.ctx.mode,
          abortHandler: () => { this.startSessionAbort(scope); },
          shutdownHandler: () => { scope.controller.abort(); },
        });
        this.assertScope(scope);
        assertRequiredTools(this.options.requiredTools, session.getActiveToolNames());

        if (!source) await this.prompt(scope, input.prompt);
        this.assertScope(scope);

        const child = this.childContext(scope, depth);
        const callback = Promise.resolve().then(() => {
          this.assertScope(scope);
          return input.withSession(child);
        });
        value = await raceCancellation(callback, scope.controller.signal, signal => this.cancelled(signal));
        if (scope.pending) throw failure("unfinishedInvocation");
        await scope.lastInvocation;
        this.assertScope(scope);
      } finally {
        scope.controller.signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      primaryFailed = true;
      primaryFailure = scope.controller.signal.aborted ? this.cancelled(scope.controller.signal) : error;
    }

    scope.closed = true;
    scope.controller.abort();
    try {
      await this.retireScope(scope);
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
      if (!this.retirementErrors.includes(error)) this.retirementErrors.push(error);
    } finally {
      scope.detach();
      this.scopes.delete(scope);
    }

    if (primaryFailed && cleanupFailed) {
      throw new AggregateError([primaryFailure, cleanupFailure], i18n.t("workflowExecution.cleanupFailed"));
    }
    if (cleanupFailed) throw cleanupFailure;
    if (primaryFailed) throw primaryFailure;
    return value as T;
  }

  private childContext(scope: ChildScope, depth: number): WorkflowSessionContext {
    const session = this.session(scope);
    return {
      cwd: this.cwd,
      hasUI: this.hasUI,
      ui: this.ui,
      maxConcurrency: this.maxConcurrency,
      signal: scope.controller.signal,
      sessionManager: {
        getSessionId: () => session.sessionId,
        getSessionFile: () => session.sessionFile,
        getBranch: () => structuredClone(session.sessionManager.getBranch()),
      },
      waitForIdle: async () => {
        await raceCancellation(scope.lastInvocation, scope.controller.signal, signal => this.cancelled(signal));
        await raceCancellation(session.waitForIdle(), scope.controller.signal, signal => this.cancelled(signal));
        this.assertScope(scope);
      },
      sendUserMessage: content => this.send(scope, content),
      spawnChild: input => {
        try {
          this.assertScope(scope);
          const signal = input.signal
            ? AbortSignal.any([scope.controller.signal, input.signal])
            : scope.controller.signal;
          return this.spawnAtDepth(depth + 1, { ...input, signal });
        } catch (error) {
          return Promise.reject(error);
        }
      },
      toolTimeout: () => scope.watchdog?.timedOut(),
      resetToolTimeout: () => scope.watchdog?.reset(),
    };
  }

  private send(scope: ChildScope, content: string): Promise<void> {
    try {
      this.assertScope(scope);
      if (typeof content !== "string" || !content.trim()) throw failure("invalidPrompt");
      const session = this.session(scope);
      if (scope.pending || !session.isIdle) throw failure("busy");
      assertRequiredTools(this.options.requiredTools, session.getActiveToolNames());
      const invocation = this.prompt(scope, content);
      scope.pending = invocation;
      scope.lastInvocation = invocation;
      const done = () => {
        if (scope.pending === invocation) scope.pending = undefined;
      };
      void invocation.then(done, done);
      return invocation;
    } catch (error) {
      const rejected = Promise.reject<void>(error);
      void rejected.catch(() => {});
      return rejected;
    }
  }

  private prompt(scope: ChildScope, content: string): Promise<void> {
    const session = this.session(scope);
    const branchStart = session.sessionManager.getBranch().length;
    const invocation = invokeEmbeddedSession(session, content, { signal: scope.controller.signal })
      .then(result => {
        // Provider/output-limit stops are durable transcript outcomes. Let the
        // workflow callback classify them so its failed row retains the native
        // session for death-scene inspection and in-place resume. Host-policy
        // failures (turn budget/wrap-up control) have no such new transcript
        // stop and must still reject before a callback could report success.
        if (result.failure && !hasTranscriptFailureSince(session, branchStart)) {
          throw new Error(result.failure);
        }
        if (result.aborted && !scope.watchdog?.timedOut()) throw this.cancelled(scope.controller.signal);
      });
    scope.nativeInvocation = invocation;
    return raceCancellation(invocation, scope.controller.signal, signal => this.cancelled(signal));
  }

  private startSessionAbort(scope: ChildScope): void {
    if (!scope.session || scope.abortPromise) return;
    const operation = withTeardownTimeout(scope.session.abort());
    scope.abortPromise = operation.catch(error => {
      scope.abortFailure ??= error;
    });
    void scope.abortPromise.catch(() => {});
  }

  private async retireScope(scope: ChildScope): Promise<void> {
    const session = scope.session;
    scope.watchdog?.dispose();
    if (!session) {
      if (scope.abortFailure !== undefined) throw scope.abortFailure;
      return;
    }

    const errors: unknown[] = [];
    if (!session.isIdle) this.startSessionAbort(scope);
    if (scope.nativeInvocation) {
      try { await withTeardownTimeout(scope.nativeInvocation.catch(() => {})); }
      catch (error) { errors.push(error); }
    }
    if (scope.abortPromise) await scope.abortPromise;
    if (scope.abortFailure !== undefined) errors.push(scope.abortFailure);
    try {
      if (session.hasExtensionHandlers("session_shutdown")) {
        const event: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
        await withTeardownTimeout(session.extensionRunner.emit(event));
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      session.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, i18n.t("workflowExecution.cleanupFailed"));
  }

  private createSessionManager(input: Pick<WorkflowChildOptions<unknown>, "reattach" | "fork">): SessionManager {
    if (input.reattach) return SessionManager.open(input.reattach.sessionFile, this.options.childSessionsDir, this.cwd);
    if (input.fork) return SessionManager.forkFrom(input.fork.sessionFile, this.cwd, this.options.childSessionsDir);
    return SessionManager.create(this.cwd, this.options.childSessionsDir);
  }

  private resolveModel(selection?: WorkflowModelSelection): Model<any> | undefined {
    const key = selection?.model;
    if (key === undefined) return undefined;
    const slash = key.indexOf("/");
    const model = slash > 0
      ? this.options.ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1))
      : undefined;
    if (!model) throw failure("unknownModel", { model: key });
    return model;
  }

  private persistRestoredOverrides(
    session: AgentSession,
    inherited: ReturnType<SessionManager["buildSessionContext"]>,
    restored: boolean,
    model: Model<any> | undefined,
    selection: WorkflowModelSelection | undefined,
  ): void {
    if (!restored) return;
    if (model && (inherited.model?.provider !== model.provider || inherited.model.modelId !== model.id)) {
      session.sessionManager.appendModelChange(model.provider, model.id);
    }
    if ((model !== undefined || selection?.thinking !== undefined)
      && inherited.thinkingLevel !== session.thinkingLevel) {
      session.sessionManager.appendThinkingLevelChange(session.thinkingLevel);
    }
  }

  private session(scope: ChildScope): AgentSession {
    if (!scope.session) throw failure("invalidSession");
    return scope.session;
  }

  private assertActive(signal: AbortSignal): void {
    if (signal.aborted) throw this.cancelled(signal);
    if (this.disposed) throw failure("closed");
  }

  private assertScope(scope: ChildScope): void {
    if (scope.closed) throw failure("closed");
    this.assertActive(scope.controller.signal);
  }

  private cancelled(signal: AbortSignal): Error {
    try {
      const error = this.options.cancellationError(signal);
      return error instanceof Error ? error : failure("invalidOptions");
    } catch (error) {
      return error instanceof Error ? error : failure("invalidOptions");
    }
  }
}

function hasTranscriptFailureSince(session: AgentSession, branchStart: number): boolean {
  const branch = session.sessionManager.getBranch().slice(branchStart) as Array<{
    type?: string;
    message?: { role?: string; stopReason?: string };
  }>;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    return entry.message.stopReason === "error" || entry.message.stopReason === "length";
  }
  return false;
}

function validSignal(signal: unknown): signal is AbortSignal | undefined {
  return signal === undefined || signal instanceof AbortSignal;
}

function validSource(source: unknown): source is { sessionFile: string } | undefined {
  return source === undefined || (!!source && typeof source === "object" && !Array.isArray(source)
    && typeof (source as { sessionFile?: unknown }).sessionFile === "string"
    && isAbsolute((source as { sessionFile: string }).sessionFile));
}

function linkSignals(controller: AbortController, signals: (AbortSignal | undefined)[]): () => void {
  const removers: Array<() => void> = [];
  for (const signal of new Set(signals)) {
    if (!signal) continue;
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      removers.push(() => signal.removeEventListener("abort", abort));
    }
  }
  return () => { for (const remove of removers) remove(); };
}

function raceCancellation<T>(
  task: Promise<T>,
  signal: AbortSignal,
  cancellationError: (signal: AbortSignal) => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancellationError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function withTeardownTimeout<T>(task: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(failure("cleanupFailed")), SDK_TEARDOWN_TIMEOUT_MS);
    timer.unref?.();
    void task.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function deferredClose() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function failure(key: string, params?: Record<string, string>): Error {
  return new Error(i18n.t(`workflowExecution.${key}`, params));
}
