import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NOTICE_TAG_COLOR, notifyWithSource, type NoticeContext } from "pi-extensions-i18n";
import { AgentManager } from "../agent-manager.js";
import type { ExecutionSession } from "../backends/session.js";
import type { PersistentSessionReference } from "../backends/session-reference.js";
import type { AgentExecutionBackend, ExecutionSessionSnapshot } from "../backends/types.js";
import { i18n } from "../i18n.js";
import { checkModelScope } from "../model-scope.js";
import type { AgentRecord, EffectiveThinkingLevel } from "../types.js";
import type { CompiledSchema } from "./json-schema.js";
import {
  WORKFLOW_EXECUTION_CAPABILITIES,
  type ManagedWorkflowHost, type ManagedWorkflowSessionContext, type ManagedWorkflowChildOptions,
  type WorkflowModelSelection, type WorkflowObserverContext, type WorkflowExecutionCapabilities,
} from "./execution-contract.js";
import { ExecutionSemaphore } from "./execution-semaphore.js";
import { snapshotPreparedPrompt, type PreparedWorkflowPrompt, type WorkflowPromptPreparer } from "./prompt-preparation.js";

export interface WorkflowExecutionHostOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  observer: WorkflowObserverContext;
  backend: AgentExecutionBackend;
  runId: string;
  /** Dedicated managed subdirectory; never put these files in a consumer's raw-JSONL sweep. */
  sessionDir: string;
  agentType?: string;
  maxConcurrency?: number;
  maxTurns?: number;
  structuredOutput?: CompiledSchema;
  /** Explicit trusted-owner preparation; absent means the original plain-prompt-only profile. */
  preparePrompt?: WorkflowPromptPreparer;
  signal?: AbortSignal;
  /** Return the consumer's ACTUAL nominal cancellation error, not a similarly named local class. */
  cancellationError?: (signal: AbortSignal) => Error;
}

/** Local default only. External runners with instanceof checks must inject their own error factory. */
export class WorkflowExecutionAbortError extends Error {
  constructor(signal: AbortSignal) {
    super(i18n.t("workflowExecution.cancelled"), { cause: signal.reason });
    this.name = "WorkflowExecutionAbortError";
  }
}

interface ChildScope {
  controller: AbortController;
  detach(): void;
  closing: boolean;
  record?: AgentRecord;
  unpin?: () => void;
  pending?: Promise<void>;
  cancelPending?: () => void;
  lastInvocation: Promise<void>;
  preparation?: PreparedWorkflowPrompt;
  release?: Promise<void>;
}

/** No registration, UI ownership, global model mutation, or public backend routing. */
export class SubagentWorkflowExecutionHost implements ManagedWorkflowHost {
  readonly capabilities: WorkflowExecutionCapabilities;
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly maxConcurrency: number;
  readonly signal: AbortSignal;
  readonly ui: WorkflowObserverContext["ui"];
  readonly sessionManager: WorkflowObserverContext["sessionManager"];
  private readonly manager: AgentManager;
  private readonly controller = new AbortController();
  private readonly semaphore: ExecutionSemaphore;
  private readonly scopes = new Set<ChildScope>();
  private readonly invocations = new Set<Promise<unknown>>();
  private readonly detach: () => void;
  private readonly abortError: (signal: AbortSignal) => Error;
  private disposed = false;
  private disposal?: Promise<void>;
  private readonly options: WorkflowExecutionHostOptions;

  constructor(options: WorkflowExecutionHostOptions) {
    if (!options.runId?.trim() || !isAbsolute(options.sessionDir) || !isAbsolute(options.ctx.cwd)
      || !validSignal(options.signal) || !validSignal(options.observer.signal)
      || !Number.isSafeInteger(options.maxConcurrency ?? 4) || (options.maxConcurrency ?? 4) < 1
      || (options.agentType !== undefined && !options.agentType.trim())
      || (options.preparePrompt !== undefined && typeof options.preparePrompt !== "function")
      || (options.maxTurns !== undefined && (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 0))) {
      throw failure("invalidOptions");
    }
    if (![options.backend.inspect, options.backend.reattach, options.backend.fork].every(port => typeof port === "function")) throw failure("managedRequired");
    this.capabilities = options.preparePrompt
      ? Object.freeze({ ...WORKFLOW_EXECUTION_CAPABILITIES, plainPromptsOnly: false, promptPreparation: true })
      : WORKFLOW_EXECUTION_CAPABILITIES;
    this.cwd = realpathSync(options.ctx.cwd);
    if (realpathSync(options.observer.cwd) !== this.cwd) throw failure("cwdMismatch");
    this.hasUI = options.observer.hasUI;
    this.maxConcurrency = options.maxConcurrency ?? 4;
    const cancellationError = options.cancellationError ?? (signal => new WorkflowExecutionAbortError(signal));
    this.abortError = signal => {
      try {
        const error = cancellationError(signal);
        return error instanceof Error ? error : failure("invalidOptions");
      } catch (error) { return error instanceof Error ? error : failure("invalidOptions"); }
    };
    this.signal = this.controller.signal;
    this.semaphore = new ExecutionSemaphore(this.maxConcurrency, this.abortError);
    // Capture observer identity/UI now, not guarded context getters halfway through a run.
    const id = options.observer.sessionManager.getSessionId();
    const file = options.observer.sessionManager.getSessionFile();
    const branch = structuredClone(options.observer.sessionManager.getBranch());
    this.sessionManager = { getSessionId: () => id, getSessionFile: () => file, getBranch: () => structuredClone(branch) };
    const notice: NoticeContext = { mode: options.ctx.mode, ui: options.observer.ui };
    this.ui = { notify: (message, level = "info") => notifyWithSource({
      ctx: notice, source: { tag: "agents", color: NOTICE_TAG_COLOR }, level, message,
    }) };
    const systemPrompt = options.ctx.getSystemPrompt();
    const ctx = Object.create(options.ctx, {
      cwd: { value: this.cwd }, model: { value: options.ctx.model },
      modelRegistry: { value: options.ctx.modelRegistry }, getSystemPrompt: { value: () => systemPrompt },
    }) as ExtensionContext;
    this.options = Object.freeze({ ...options, ctx });
    // Allocate resources only after all fallible context reads have succeeded.
    this.manager = new AgentManager(undefined, this.maxConcurrency, undefined, undefined, undefined, options.backend);
    this.detach = linkSignals(this.controller, [options.signal, options.observer.signal]);
  }

  async spawnChild<T>(input: ManagedWorkflowChildOptions<T>): Promise<T> {
    this.assertActive(this.signal);
    if (!input || typeof input.withSession !== "function" || typeof input.prompt !== "string"
      || !validSignal(input.signal) || !validSource(input.reattach) || !validSource(input.fork)
      || (input.model !== undefined && (!input.model || typeof input.model !== "object" || Array.isArray(input.model)))
      || (input.reattach !== undefined && input.fork !== undefined)) throw failure("invalidOptions");
    // Freeze mutable dispatch fields before queueing. A queued request cannot be retargeted.
    const options = { ...input, model: input.model && { ...input.model },
      reattach: input.reattach && { ...input.reattach }, fork: input.fork && { ...input.fork } };
    if (options.reattach || options.fork) {
      if (!isAbsolute((options.reattach ?? options.fork)!.sessionFile)) throw failure("invalidOptions");
    } else this.assertInputPrompt(options.prompt);
    const scope: ChildScope = { controller: new AbortController(), detach: () => {}, closing: false, lastInvocation: Promise.resolve() };
    scope.detach = linkSignals(scope.controller, [this.signal, options.signal]);
    this.scopes.add(scope);
    const stop = () => { void this.release(scope).catch(() => {}); };
    scope.controller.signal.addEventListener("abort", stop, { once: true });
    const task = this.runChild(scope, options).finally(() => {
      scope.controller.signal.removeEventListener("abort", stop);
      scope.detach();
      this.scopes.delete(scope);
    });
    // Waiting may cancel before bounded retirement completes; close() remains the cleanup barrier.
    return raceAbort(task, scope.controller.signal, this.abortError);
  }

  async waitForIdle(): Promise<void> {
    while (this.invocations.size) await raceAbort(Promise.all([...this.invocations]), this.signal, this.abortError);
    this.assertActive(this.signal);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    // Publish the shared barrier before abort/shutdown listeners can reenter disposal.
    this.disposal = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    void this.disposal.catch(() => {});
    this.disposed = true;
    try {
      this.controller.abort();
      this.detach();
      void this.manager.dispose().then(resolve, reject);
    } catch (error) { reject(error); }
    return this.disposal;
  }

  private async runChild<T>(scope: ChildScope, options: ManagedWorkflowChildOptions<T>): Promise<T> {
    try {
      // Stop awaiting cancelled work, but retain capacity until the actual invocation settles.
      await raceAbort(this.invoke(scope, async () => {
        const selection = this.resolveSelection(options.model);
        const source = options.reattach ?? options.fork;
        if (source) {
          const snapshot = this.options.backend.inspect!(source.sessionFile);
          this.validateRestore(snapshot, options.model, selection.model);
          const adopted = await this.manager.restore(snapshot.reference, {
            mode: options.fork ? "fork" : "reattach", ctx: this.options.ctx,
            type: snapshot.policy.type, description: i18n.t("workflowExecution.child", { runId: this.options.runId }),
            workflowId: this.options.runId, signal: scope.controller.signal,
            structuredOutput: this.options.structuredOutput,
          });
          this.own(scope, adopted.record);
          // Check the actual acquired destination as well as the preflight source.
          this.validateRestore(this.options.backend.inspect!(adopted.record.session!.reference.sessionFile!), options.model, selection.model);
        } else {
          const prepared = await this.prepare(scope, options.prompt);
          this.assertScope(scope);
          const id = this.manager.spawn(this.options.pi, this.options.ctx,
            this.options.agentType ?? "general-purpose", prepared.text, {
              description: i18n.t("workflowExecution.child", { runId: this.options.runId }),
              workflowId: this.options.runId, isolated: true, inheritContext: false, isolation: "off", isBackground: false,
              cwd: this.cwd, model: selection.model, thinkingLevel: selection.thinking,
              maxTurns: this.options.maxTurns, structuredOutput: this.options.structuredOutput,
              requiredTools: prepared.requiredTools, signal: scope.controller.signal,
            });
          const record = this.manager.getRecord(id)!;
          this.own(scope, record);
          await this.manager.awaitStartup(id);
          if (record.promise) await record.promise;
          this.checkResult(scope, record);
        }
        const session = this.session(scope);
        if (!options.reattach) this.validateDestination(session.reference.sessionFile!);
        this.branch(scope, true); // Fail closed if the backend cannot supply authentic raw entries.
      }), scope.controller.signal, this.abortError);
      this.assertScope(scope);
      const child = this.childContext(scope);
      const result = await raceAbort(Promise.resolve().then(() => options.withSession(child)), scope.controller.signal, this.abortError);
      if (scope.pending) throw failure("unfinishedInvocation");
      // A forgotten send may already have rejected and cleared pending; it still cannot become success.
      await scope.lastInvocation;
      this.assertScope(scope);
      return result;
    } finally {
      scope.closing = true;
      // Cancel queued sends before detaching their parent signal; running calls keep their permit until settlement.
      scope.cancelPending?.();
      await this.release(scope);
      scope.unpin?.();
    }
  }

  private childContext(scope: ChildScope): ManagedWorkflowSessionContext {
    const reference = Object.freeze({ ...this.session(scope).reference }) as PersistentSessionReference;
    return {
      cwd: this.cwd, hasUI: this.hasUI, ui: this.ui, maxConcurrency: this.maxConcurrency,
      signal: scope.controller.signal, reference,
      get preparation() { return scope.preparation; },
      sessionManager: {
        getSessionId: () => reference.sessionId,
        getSessionFile: () => reference.sessionFile,
        getBranch: () => this.branch(scope),
      },
      waitForIdle: async () => {
        await raceAbort(scope.lastInvocation, scope.controller.signal, this.abortError);
        this.assertScope(scope);
      },
      sendUserMessage: content => {
        try {
          this.assertScope(scope);
          this.assertInputPrompt(content);
          if (scope.pending) throw failure("busy");
          return this.invoke(scope, async () => {
            const prepared = await this.prepare(scope, content);
            this.assertScope(scope);
            const record = await this.manager.resume(scope.record!.id, prepared.text, scope.controller.signal, {
              requiredTools: prepared.requiredTools,
            });
            if (!record) throw failure("resumeRefused");
            this.checkResult(scope, record);
          });
        } catch (error) {
          const rejected = Promise.reject<void>(error);
          void rejected.catch(() => {});
          return rejected;
        }
      },
      spawnChild: () => Promise.reject(failure("nestedUnsupported")),
      abort: () => { scope.controller.abort(); return this.release(scope); },
    };
  }

  private async prepare(scope: ChildScope, input: string): Promise<PreparedWorkflowPrompt> {
    this.assertScope(scope);
    const prepare = this.options.preparePrompt;
    const session = scope.record?.session?.reference;
    const context = Object.freeze({ cwd: this.cwd, signal: scope.controller.signal,
      ...(session?.sessionFile ? { session: Object.freeze({ ...session }) as PersistentSessionReference } : {}),
    });
    let prepared: PreparedWorkflowPrompt;
    if (prepare) {
      const result = prepare(input, context);
      // A synchronous preparer may reuse a result object across siblings: snapshot before yielding.
      prepared = result && typeof (result as PromiseLike<PreparedWorkflowPrompt>).then === "function"
        ? snapshotPreparedPrompt(await result)
        : snapshotPreparedPrompt(result as PreparedWorkflowPrompt);
    } else prepared = Object.freeze({ text: input });
    // A slow or cancellation-ignoring preparer must never dispatch into a retired scope.
    this.assertScope(scope);
    assertPlainPrompt(prepared.text);
    scope.preparation = prepared;
    return prepared;
  }

  private assertInputPrompt(prompt: string): void {
    if (typeof prompt !== "string" || !prompt.trim()) throw failure("invalidPrompt");
    if (!this.options.preparePrompt) assertPlainPrompt(prompt);
  }

  private invoke(scope: ChildScope, work: () => Promise<void>): Promise<void> {
    // Scope closure can cancel an unused queued send without masquerading as user cancellation
    // of an otherwise successful callback. Active work is retired through manager.release.
    const admission = new AbortController();
    const detach = linkSignals(admission, [scope.controller.signal]);
    const cancelPending = () => admission.abort();
    scope.cancelPending = cancelPending;
    const task = (async () => {
      try {
        const release = await this.semaphore.acquire(admission.signal);
        try { this.assertScope(scope); await work(); this.assertScope(scope); }
        catch (error) { if (scope.controller.signal.aborted) throw this.abortError(scope.controller.signal); throw error; }
        finally { release(); }
      } finally { detach(); }
    })();
    scope.pending = task;
    scope.lastInvocation = task;
    this.invocations.add(task);
    // Observe rejected unawaited sends; still return the original rejecting promise to the caller.
    void task.then(() => done(), () => done());
    const done = () => {
      if (scope.pending === task) scope.pending = undefined;
      if (scope.cancelPending === cancelPending) scope.cancelPending = undefined;
      this.invocations.delete(task);
    };
    return task;
  }

  private own(scope: ChildScope, record: AgentRecord): void {
    if (scope.record === record) return;
    scope.record = record;
    if (scope.controller.signal.aborted || scope.closing) { void this.release(scope).catch(() => {}); return; }
    scope.unpin = this.manager.retain(record.id);
  }

  private release(scope: ChildScope): Promise<void> {
    // A pre-acquisition cancellation must not memoize a no-op: a late record still needs cleanup.
    if (!scope.record) return Promise.resolve();
    scope.closing = true;
    return scope.release ??= this.manager.release(scope.record.id);
  }

  private session(scope: ChildScope): ExecutionSession {
    const session = scope.record?.session;
    if (!session?.reference.sessionFile || session.reference.backend !== this.options.backend.kind) throw failure("invalidSession");
    return session;
  }

  private branch(scope: ChildScope, preparing = false): unknown {
    this.assertScope(scope);
    if (!preparing && scope.pending) throw failure("busy");
    const branch = this.session(scope).getBranch?.();
    if (!Array.isArray(branch)) throw failure("invalidSession");
    // Preserve raw entries and offsets while preventing a consumer from mutating a native branch.
    return structuredClone(branch);
  }

  private checkResult(scope: ChildScope, record: AgentRecord): void {
    this.assertScope(scope);
    if (record.error || (record.status !== "completed" && record.status !== "steered")) {
      throw failure("invocationFailed", { reason: record.error ?? record.status });
    }
    this.session(scope);
  }

  private resolveSelection(selection?: WorkflowModelSelection): { model?: Model<any>; thinking?: EffectiveThinkingLevel } {
    if (!selection) return {};
    if (selection.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(selection.thinking)) throw failure("invalidOptions");
    let model: Model<any> | undefined;
    if (selection.model !== undefined) {
      const key = selection.model;
      const slash = typeof key === "string" ? key.indexOf("/") : -1;
      model = slash > 0 ? this.options.ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1)) : undefined;
      if (!model) throw failure("unknownModel", { model: String(key) });
      const verdict = checkModelScope({ model, cwd: this.cwd, modelRegistry: this.options.ctx.modelRegistry,
        callerSupplied: true, agentLabel: this.options.agentType ?? "general-purpose", modelInput: key });
      if (verdict.kind === "error") throw failure("modelOutOfScope", { model: key });
    }
    return { model, thinking: selection.thinking };
  }

  private validateRestore(snapshot: ExecutionSessionSnapshot, selection?: WorkflowModelSelection, model?: Model<any>): void {
    if (snapshot.reference.backend !== this.options.backend.kind) throw failure("invalidSession");
    if (realpathSync(snapshot.policy.cwd) !== this.cwd) throw failure("cwdMismatch");
    if (model && (model.provider !== snapshot.policy.model.provider || model.id !== snapshot.policy.model.id)) throw failure("policyOverride");
    if (selection?.thinking !== undefined) {
      const restoredModel = model ?? this.options.ctx.modelRegistry.find(snapshot.policy.model.provider, snapshot.policy.model.id);
      if (!restoredModel || clampThinkingLevel(restoredModel, selection.thinking) !== snapshot.policy.thinkingLevel) throw failure("policyOverride");
    }
  }

  private validateDestination(file: string): void {
    const path = relative(realpathSync(this.options.sessionDir), realpathSync(file));
    if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw failure("storageMismatch");
  }

  private assertActive(signal: AbortSignal): void {
    if (signal.aborted) throw this.abortError(signal);
    if (this.disposed) throw failure("closed");
  }

  private assertScope(scope: ChildScope): void {
    this.assertActive(scope.controller.signal);
    if (scope.closing) throw failure("closed");
  }
}

function assertPlainPrompt(prompt: string): void {
  if (typeof prompt !== "string" || !prompt.trim()) throw failure("invalidPrompt");
  // Isolated resources cannot expand skills, extension commands or prompt templates.
  if (prompt.trimStart().startsWith("/")) throw failure("commandUnsupported");
}

function failure(key: string, params?: Record<string, string>): Error {
  return new Error(i18n.t(`workflowExecution.${key}`, params));
}

function validSignal(signal: unknown): signal is AbortSignal | undefined {
  return signal === undefined || signal instanceof AbortSignal;
}

function validSource(source: unknown): source is { sessionFile: string } | undefined {
  if (source === undefined) return true;
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const file = (source as { sessionFile?: unknown }).sessionFile;
  return typeof file === "string" && isAbsolute(file);
}

function linkSignals(controller: AbortController, signals: (AbortSignal | undefined)[]): () => void {
  const removers: (() => void)[] = [];
  for (const signal of new Set(signals)) {
    if (!signal) continue;
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else { signal.addEventListener("abort", abort, { once: true }); removers.push(() => signal.removeEventListener("abort", abort)); }
  }
  return () => { for (const remove of removers) remove(); };
}

function raceAbort<T>(task: Promise<T>, signal: AbortSignal, error: (signal: AbortSignal) => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(error(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
