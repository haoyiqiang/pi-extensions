import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { i18n } from "../../i18n.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../../structured-output.js";
import { assertRequiredTools, snapshotRequiredTools } from "../tool-requirements.js";
import type { ExecutionSession, SessionViewEvent, TranscriptMessage } from "../session.js";
import type { AgentExecutionBackend, ExecutionResumeOptions, ExecutionRunOptions, ExecutionRunResult } from "../types.js";
import type { ChildFeedback, TerminalSnapshot } from "./bridge-protocol.js";
import { openTerminalBridge, type TerminalBridge } from "./bridge-server.js";
import { launchTerminalRun } from "./lifecycle.js";
import { createTerminalDependencies } from "./mux-adapter.js";
import {
  prepareTerminalLaunch, prepareTerminalPolicy,
  type TerminalBackendConfig, type TerminalPolicy,
} from "./prepare.js";
import type { TerminalDependencies, TerminalRun } from "./types.js";
import { waitForProcessExit } from "./process-exit.js";
import { compileTerminalSchema } from "./run-policy.js";
import type { CompiledSchema } from "../../workflow/json-schema.js";
import type { PersistentSessionReference } from "../session-reference.js";
import { ManagedTerminalSession } from "./session-store.js";
import { inspectManagedSession } from "../managed-session.js";
import { createStandardTerminalExecutionBackend } from "./standard-backend.js";

export type { TerminalBackendConfig } from "./prepare.js";
export { createStandardTerminalExecutionBackend, STANDARD_TERMINAL_BACKEND_CAPABILITIES } from "./standard-backend.js";
export type { StandardTerminalPolicy, StandardTerminalCli } from "./standard-policy.js";
export const TERMINAL_BACKEND_CAPABILITIES = Object.freeze({
  isolated: true, fresh: true, resumeOwnedSession: true, steer: true, interrupt: true,
  inheritContext: false, reattach: true, fork: true, structuredOutput: true, maxTurns: true,
  managedSessionsOnly: true, crashRecovery: false,
  nativeWindows: false, powershellRuntime: false,
});

interface SessionState {
  handle: ExecutionSession;
  policy: TerminalPolicy;
  managed: ManagedTerminalSession;
  structuredCheck?: (value: unknown) => true | string;
  wireSchema?: CompiledSchema;
  snapshot: TerminalSnapshot;
  listeners: Set<(event: SessionViewEvent) => void>;
  closed: boolean;
  poisoned: boolean;
  running: boolean;
  controller?: AbortController;
  bridge?: TerminalBridge;
  terminal?: TerminalRun;
  operation?: Promise<ExecutionRunResult>;
  shutdown?: Promise<void>;
  retirementError?: unknown;
}

function validateStructuredResult(state: SessionState, final: Extract<ChildFeedback, { type: "settled" }>): { json?: string; failure?: string } {
  const invalid = () => ({ failure: i18n.t("terminalPolicy.invalidResult") });
  if (!state.wireSchema) return final.structuredJson !== undefined || final.structuredRetried ? invalid() : {};
  if (final.structuredJson === undefined) return final.failure || final.aborted ? {} : invalid();
  try {
    const value: unknown = JSON.parse(final.structuredJson);
    if (state.wireSchema.check(value) !== true || state.structuredCheck?.(value) !== true) return invalid();
    return { json: JSON.stringify(value) };
  } catch { return invalid(); }
}

/** Injectable transport/bridge for deterministic tests; production always uses the real child bridge. */
export interface TerminalBackendPorts {
  dependencies?: TerminalDependencies;
  bridge?: typeof openTerminalBridge;
  waitForExit?: typeof waitForProcessExit;
}

function safely(action: (() => void) | undefined): void { try { action?.(); } catch { /* observational callback */ } }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function mergeFailure(primary: string | undefined, cleanup: readonly string[]): string | undefined {
  if (cleanup.length === 0) return primary;
  const suffix = cleanup.map((error) => i18n.t("terminalBackend.cleanupFailed", { error })).join("\n");
  return primary ? `${primary}\n${suffix}` : suffix;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(signal.reason ?? new Error(i18n.t("terminal.cancelled"))); };
    const cleanup = () => signal.removeEventListener("abort", stop);
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
}

function withExitDeadline<T>(completion: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(i18n.t("bridge.retirementTimeout"))), milliseconds);
    completion.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function retirementReceipt(wait: (signal: AbortSignal) => Promise<unknown>, milliseconds: number): Promise<void> {
  const controller = new AbortController();
  await new Promise<void>((resolve, reject) => {
    const timeoutError = new Error(i18n.t("bridge.retirementTimeout"));
    const timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, milliseconds);
    let completion: Promise<unknown>;
    try { completion = wait(controller.signal); }
    catch (error) { clearTimeout(timer); reject(error); return; }
    completion.then(
      () => { clearTimeout(timer); resolve(); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Private opt-in backend. Default AgentManager construction still selects embedded execution. */
export function createManagedTerminalExecutionBackend(
  config: TerminalBackendConfig = {},
  ports: TerminalBackendPorts = {},
): AgentExecutionBackend {
  // Windows TerminateProcess can bypass supervisor signal handlers; require a job-object adapter first.
  if (process.platform === "win32" && !ports.bridge) throw new Error(i18n.t("terminalBackend.unsupported", { feature: "win32/process-tree" }));
  if (config.interpreter === "powershell" && !ports.bridge) throw new Error(i18n.t("terminalBackend.unsupported", { feature: "powershell/process-tree" }));
  const timeout = config.startupTimeoutMs ?? 30_000;
  const exitTimeout = config.exitTimeoutMs ?? 5_000;
  if (!Number.isFinite(exitTimeout) || exitTimeout <= 0) throw new Error(i18n.t("terminalBackend.invalidConfig"));
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(i18n.t("terminalBackend.invalidConfig"));
  const states = new WeakMap<ExecutionSession, SessionState>();
  const files = new Map<string, SessionState>();
  const dependencies = ports.dependencies ?? createTerminalDependencies();

  const getState = (handle: ExecutionSession): SessionState => {
    const state = states.get(handle);
    if (!state) throw new Error(i18n.t("backend.invalidSession"));
    if (state.closed) throw new Error(i18n.t("backend.closedSession"));
    return state;
  };
  const publish = (state: SessionState, snapshot: TerminalSnapshot, event: SessionViewEvent) => {
    // Reuse unchanged message objects across wire snapshots for viewer cache stability.
    const previous = state.snapshot.messages;
    const messages = snapshot.messages.map((entry, index) => {
      const old = previous[index];
      return old && JSON.stringify(old) === JSON.stringify(entry) ? old : entry;
    });
    state.snapshot = {
      messages,
      stats: snapshot.stats,
      thinkingLevel: snapshot.thinkingLevel,
      model: snapshot.model && { provider: snapshot.model.provider, id: snapshot.model.id, name: snapshot.model.name },
    };
    if (!state.closed) for (const listener of state.listeners) safely(() => listener(event));
  };

  const invoke = (
    state: SessionState, prompt: string,
    callbacks: ExecutionResumeOptions & Pick<ExecutionRunOptions, "onTextDelta" | "onTurnEnd" | "onSessionCreated"> = {},
  ): Promise<ExecutionRunResult> => {
    if (state.running) return Promise.reject(new Error(i18n.t("terminalBackend.busy")));
    if (state.poisoned) return Promise.reject(new Error(i18n.t("terminalBackend.quarantined")));
    state.running = true;
    const controller = new AbortController();
    state.controller = controller;
    const parentSignal = callbacks.signal;
    const parentAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) parentAbort(); else parentSignal?.addEventListener("abort", parentAbort, { once: true });
    const signal = controller.signal;
    const run = { runId: randomUUID(), session: state.handle.reference as { backend: "terminal"; sessionId: string; sessionFile: string } };
    let text = "";
    const execute = async (): Promise<ExecutionRunResult> => {
      let bridge: TerminalBridge | undefined;
      let terminal: TerminalRun | undefined;
      let launch: ReturnType<typeof prepareTerminalLaunch> | undefined;
      let ready = false;
      let retired = false;
      let outcome: ExecutionRunResult | undefined;
      let primaryError: unknown;
      let cleanupAggregate: AggregateError | undefined;
      const cleanupFailures: string[] = [];
      try {
        signal.throwIfAborted();
        state.managed.beginRun(run.runId);
        bridge = await (ports.bridge ?? openTerminalBridge)(run, (event: ChildFeedback) => {
          if (state.closed || signal.aborted) return;
          switch (event.type) {
            case "ready": publish(state, event.snapshot, { type: "changed" }); break;
            case "snapshot": publish(state, event.snapshot, event.event); break;
            case "idle": publish(state, event.snapshot, { type: "changed" }); break;
            case "settled": publish(state, event.snapshot, { type: "changed" }); break;
            case "text": text = event.fullText; safely(() => callbacks.onTextDelta?.(event.delta, event.fullText)); break;
            case "tool": safely(() => callbacks.onToolActivity?.(event.activity)); break;
            case "usage": safely(() => callbacks.onAssistantUsage?.(event.usage)); break;
            case "turn": safely(() => callbacks.onTurnEnd?.(event.count)); break;
            case "compaction": safely(() => callbacks.onCompaction?.(event.info)); break;
            case "execution_request": case "ack": case "failure": break;
          }
        }, timeout);
        state.bridge = bridge;
        signal.throwIfAborted();
        launch = prepareTerminalLaunch(state.policy, run.session, run.runId, bridge.endpoint, prompt, config);
        signal.throwIfAborted();
        // Keep receipt observation alive while authenticated abort asks Pi to
        // settle; terminal.cancel() below is only the bounded force fallback.
        terminal = await launchTerminalRun(launch, {
          ...dependencies,
          transport: {
            ...dependencies.transport,
            waitForExit: async (_surface, transportSignal) => {
              const exit = await (ports.waitForExit ?? waitForProcessExit)(launch!.processExit, transportSignal);
              retired = !transportSignal.aborted;
              return exit;
            },
          },
        });
        state.terminal = terminal;
        const exitedBeforeReady = terminal.completion.then(() => {
          throw new Error(i18n.t("bridge.exitedBeforeReady"));
        });
        await abortable(Promise.race([bridge.ready, exitedBeforeReady]), signal);
        ready = true;
        callbacks.onSessionCreated?.(state.handle);
        signal.throwIfAborted();
        bridge.start();
        // Child reports agent_settled, but the process must also exit before this file is resumable.
        const final = await abortable(bridge.settled, signal);
        text = final.text;
        const result = await withExitDeadline(terminal.completion, exitTimeout);
        if (!retired || result.cleanupError || result.status === "cancelled") state.poisoned = true;
        if (!state.poisoned) {
          state.managed.checkpoint(state.snapshot.thinkingLevel, final.witness);
          state.policy = state.managed.policy;
        }
        const structured = validateStructuredResult(state, final);
        outcome = {
          session: state.handle,
          responseText: final.text,
          aborted: final.aborted || result.status === "cancelled",
          steered: final.steered === true,
          ...(structured.json !== undefined ? { structuredJson: structured.json } : {}),
          ...(final.structuredRetried ? { structuredRetried: true } : {}),
          failure: structured.failure ?? final.failure ?? (result.status === "failed"
            && !(final.aborted && result.reason === "sentinel" && result.exitCode === 1)
            ? result.error ?? result.summary : undefined),
        };
        return outcome;
      } catch (error) {
        state.poisoned = true;
        if (signal.aborted) {
          bridge?.abort();
          outcome = { session: state.handle, responseText: text, aborted: true, steered: false };
          return outcome;
        }
        if (ready) {
          outcome = { session: state.handle, responseText: text, aborted: false, steered: false,
            failure: error instanceof Error ? error.message : i18n.t("bridge.failed") };
          return outcome;
        }
        primaryError = error;
        throw error;
      } finally {
        // Give authenticated SDK abort one bounded chance to retire naturally
        // before closing the owned surface, then verify with a fresh watcher.
        if (terminal && signal.aborted && !retired) {
          try {
            const result = await withExitDeadline(terminal.completion, exitTimeout);
            if (result.reason === "sentinel") retired = true;
            if (result.cleanupError) cleanupFailures.push(result.cleanupError);
          } catch { /* force cancellation below */ }
        }
        if (terminal) {
          try {
            const result = await terminal.cancel();
            if (result.reason === "sentinel") retired = true;
            if (result.cleanupError) cleanupFailures.push(result.cleanupError);
          } catch (error) { cleanupFailures.push(errorText(error)); }
        }
        if (!retired && terminal && launch) {
          try {
            await retirementReceipt(
              (retirementSignal) => (ports.waitForExit ?? waitForProcessExit)(launch!.processExit, retirementSignal),
              exitTimeout,
            );
            retired = true;
          } catch (error) { cleanupFailures.push(errorText(error)); }
        }
        if (!retired && terminal) state.poisoned = true;
        if (bridge) {
          try { await withExitDeadline(bridge.close(), exitTimeout); }
          catch (error) { cleanupFailures.push(errorText(error)); state.poisoned = true; }
        }
        if (cleanupFailures.length > 0) {
          const uniqueCleanupFailures = [...new Set(cleanupFailures)];
          state.poisoned = true;
          state.retirementError = new Error(uniqueCleanupFailures.join("\n"));
          if (outcome) outcome.failure = mergeFailure(outcome.failure, uniqueCleanupFailures);
          else if (primaryError !== undefined) {
            cleanupAggregate = new AggregateError(
              [primaryError, ...uniqueCleanupFailures.map((message) => new Error(message))],
              errorText(primaryError),
              { cause: primaryError },
            );
          }
        }
        parentSignal?.removeEventListener("abort", parentAbort);
        state.bridge = undefined;
        state.terminal = undefined;
        state.controller = undefined;
        state.running = false;
        if (state.poisoned) state.managed.quarantine();
        if (cleanupAggregate) throw cleanupAggregate;
      }
    };
    const operation = execute();
    state.operation = operation;
    return operation;
  };

  const adopt = (managed: ManagedTerminalSession, validator?: CompiledSchema): SessionState => {
    try {
      const messages = managed.readReady().manager.buildSessionProjection().messages as readonly TranscriptMessage[];
      const tokens = { input: 0, output: 0, cacheWrite: 0 };
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        const usage = (message as { usage?: Record<string, unknown> }).usage;
        for (const key of ["input", "output", "cacheWrite"] as const) {
          const value = usage?.[key];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) tokens[key] += value;
        }
      }
      const policy = managed.policy;
      const listeners = new Set<(event: SessionViewEvent) => void>();
      const state = {
        managed, policy, listeners, closed: false, poisoned: false, running: false,
        wireSchema: policy.structuredSchema ? compileTerminalSchema(policy.structuredSchema) : undefined,
        structuredCheck: validator?.check.bind(validator),
        snapshot: { messages, model: policy.model, thinkingLevel: policy.thinkingLevel, stats: { tokens, contextUsage: { percent: null } } },
      } as SessionState;
      const handle: ExecutionSession = Object.freeze({
        reference: managed.reference,
        get model() { return state.snapshot.model; },
        get thinkingLevel() { return state.snapshot.thinkingLevel; },
        get messages() { return state.snapshot.messages; },
        getSessionStats: () => state.snapshot.stats,
        getBranch() {
          getState(handle);
          if (state.running) throw new Error(i18n.t("sessionStore.unsafe"));
          return managed.readReady().manager.getBranch();
        },
        subscribe(listener: (event: SessionViewEvent) => void) {
          if (!state.closed) listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      });
      state.handle = handle;
      states.set(handle, state);
      files.set(managed.reference.sessionFile, state);
      return state;
    } catch (error) {
      try { managed.release(); } catch { managed.quarantine(); }
      throw error;
    }
  };
  const ownedReference = (reference: PersistentSessionReference): SessionState | undefined => {
    if (!reference || reference.backend !== "terminal" || typeof reference.sessionFile !== "string" || !isAbsolute(reference.sessionFile)
      || typeof reference.sessionId !== "string" || !reference.sessionId.trim()) throw new Error(i18n.t("sessionStore.invalidRecord"));
    let path: string;
    try { path = realpathSync(reference.sessionFile); } catch { throw new Error(i18n.t("sessionStore.invalidFile")); }
    const state = files.get(path);
    if (state && reference.sessionId !== state.handle.reference.sessionId) throw new Error(i18n.t("sessionStore.invalidRecord"));
    return state;
  };

  return {
    kind: "terminal",
    inspect: (file) => inspectManagedSession(file, "terminal"),
    async run(ctx, type, prompt, options) {
      options.signal?.throwIfAborted();
      const policy = await prepareTerminalPolicy(ctx, type, options);
      options.signal?.throwIfAborted();
      const state = adopt(ManagedTerminalSession.create(policy, config), options.structuredOutput);
      try { return await invoke(state, prompt, options); }
      catch (error) { files.delete(state.managed.reference.sessionFile); throw error; }
    },
    async reattach(reference, options = {}) {
      options.signal?.throwIfAborted();
      if (ownedReference(reference)) throw new Error(i18n.t("sessionStore.alreadyOwned"));
      return adopt(ManagedTerminalSession.open(reference, options), options.structuredOutput).handle;
    },
    async fork(reference, options = {}) {
      options.signal?.throwIfAborted();
      const owned = ownedReference(reference);
      if (owned?.running) throw new Error(i18n.t("terminalBackend.busy"));
      if (owned?.poisoned || owned?.closed) throw new Error(i18n.t("terminalBackend.quarantined"));
      const source = owned?.managed ?? ManagedTerminalSession.open(reference, options);
      let forked: ManagedTerminalSession | undefined;
      try { forked = source.fork(config, options); }
      finally {
        if (!owned) {
          try { source.release(); }
          catch (error) {
            try { forked?.release(); } catch { forked?.quarantine(); }
            throw error;
          }
        }
      }
      return adopt(forked, options.structuredOutput).handle;
    },
    async resume(handle, prompt, options) {
      const requiredTools = snapshotRequiredTools(options?.requiredTools);
      const state = getState(handle);
      const policy = state.managed.policy;
      assertRequiredTools(requiredTools, policy.structuredSchema === undefined
        ? policy.tools : [...policy.tools, STRUCTURED_OUTPUT_TOOL_NAME]);
      const result = await invoke(state, prompt, options);
      return {
        text: result.responseText, failure: result.failure ?? (result.aborted ? i18n.t("terminal.cancelled") : undefined),
        ...(result.aborted ? { aborted: true } : {}),
        ...(result.steered ? { steered: true } : {}),
        ...(result.structuredJson !== undefined ? { structuredJson: result.structuredJson } : {}),
        ...(result.structuredRetried ? { structuredRetried: true } : {}),
      };
    },
    async steer(handle, text) {
      const state = getState(handle);
      if (!state.running || !state.bridge) throw new Error(i18n.t("bridge.notRunning"));
      await state.bridge.steer(text);
    },
    async interrupt(handle) {
      const state = getState(handle);
      if (!state.running || !state.bridge) throw new Error(i18n.t("terminal.notRunning"));
      await state.bridge.interrupt();
    },
    shutdown(handle) {
      if (!handle) return Promise.resolve();
      const state = states.get(handle);
      if (!state) return Promise.reject(new Error(i18n.t("backend.invalidSession")));
      if (state.shutdown) return state.shutdown;
      state.closed = true;
      state.listeners.clear();
      state.bridge?.abort();
      state.controller?.abort();
      const settled = state.operation?.then(() => {}, () => {}) ?? Promise.resolve();
      state.shutdown = settled.then(() => {
        try {
          if (state.poisoned) state.managed.quarantine();
          else state.managed.release();
        } finally { files.delete(state.managed.reference.sessionFile); }
        if (state.retirementError !== undefined) throw state.retirementError;
      });
      return state.shutdown;
    },
  };
}

/**
 * Terminal backend entrypoint. Managed remains the compatibility default;
 * callers opt into ordinary product execution with profile: "standard" or the
 * explicit createStandardTerminalExecutionBackend factory.
 */
export function createTerminalExecutionBackend(
  config: TerminalBackendConfig = {},
  ports: TerminalBackendPorts = {},
): AgentExecutionBackend {
  return config.profile === "standard"
    ? createStandardTerminalExecutionBackend(config, ports)
    : createManagedTerminalExecutionBackend(config, ports);
}
