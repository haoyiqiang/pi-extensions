import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { i18n } from "../../i18n.js";
import type { CompiledSchema } from "../../workflow/json-schema.js";
import type { ExecutionSession, SessionBranchEntry, SessionViewEvent, TranscriptMessage } from "../session.js";
import type { PersistentSessionReference } from "../session-reference.js";
import { snapshotRequiredTools } from "../tool-requirements.js";
import type {
  AgentExecutionBackend,
  ExecutionRestoreOptions,
  ExecutionResumeOptions,
  ExecutionResumeResult,
  ExecutionRunOptions,
  ExecutionRunResult,
} from "../types.js";
import type { ChildFeedback, ChildSettlement, TerminalSnapshot } from "./bridge-protocol.js";
import { openTerminalBridge, type TerminalBridge } from "./bridge-server.js";
import { launchTerminalRun } from "./lifecycle.js";
import { createTerminalDependencies } from "./mux-adapter.js";
import {
  prepareStandardTerminalLaunch,
  type TerminalBackendConfig,
} from "./prepare.js";
import { waitForProcessExit } from "./process-exit.js";
import { compileTerminalSchema } from "./run-policy.js";
import {
  adoptStandardTerminalSession,
  createStandardTerminalSession,
  forkStandardTerminalSession,
  openStandardTerminalSession,
  quarantineStandardTerminalSession,
  readStandardSessionSnapshot,
  removeStandardTerminalSession,
} from "./standard-session.js";
import { prepareStandardTerminalPolicy, type StandardTerminalPolicy } from "./standard-policy.js";
import type { TerminalDependencies, TerminalRun, TerminalRunResult } from "./types.js";
import type { TerminalBackendPorts } from "./backend.js";

export const STANDARD_TERMINAL_BACKEND_CAPABILITIES = Object.freeze({
  isolated: false,
  fresh: true,
  resumeOwnedSession: true,
  reattach: true,
  fork: true,
  structuredOutput: true,
  maxTurns: true,
  steer: true,
  interrupt: true,
  interactive: true,
  autoExit: true,
  managedSessionsOnly: false,
  inheritContext: true,
  crashRecovery: false,
});

type StandardCallbacks = ExecutionResumeOptions & Pick<ExecutionRunOptions, "onTextDelta" | "onTurnEnd" | "onSessionCreated">;

interface RoundWaiter {
  resolve(result: ExecutionResumeResult): void;
  reject(error: unknown): void;
}

interface StandardState {
  handle: ExecutionSession;
  reference: PersistentSessionReference<"terminal">;
  policy: StandardTerminalPolicy;
  exposeSessionFile: boolean;
  ephemeralOwned: boolean;
  structuredCheck?: (value: unknown) => true | string;
  wireSchema?: CompiledSchema;
  snapshot: TerminalSnapshot;
  branch: readonly SessionBranchEntry[];
  listeners: Set<(event: SessionViewEvent) => void>;
  closed: boolean;
  poisoned: boolean;
  running: boolean;
  roundQueued: boolean;
  roundActive: boolean;
  roundAdmitted: boolean;
  executionId?: string;
  roundText: string;
  callbacks: StandardCallbacks;
  pendingCallbacks?: StandardCallbacks;
  activeCallbacks?: StandardCallbacks;
  roundWaiter?: RoundWaiter;
  diskStamp?: string;
  controller?: AbortController;
  bridge?: TerminalBridge;
  terminal?: TerminalRun;
  operation?: Promise<ExecutionRunResult>;
  shutdown?: Promise<void>;
  lastIdle?: ChildSettlement;
  retirementError?: unknown;
}

const EMPTY_STATS = Object.freeze({
  tokens: Object.freeze({ input: 0, output: 0, cacheWrite: 0 }),
  contextUsage: Object.freeze({ percent: null }),
});

function safely(action: (() => void) | undefined): void { try { action?.(); } catch { /* observation only */ } }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function deferredRound(): { promise: Promise<ExecutionResumeResult>; waiter: RoundWaiter } {
  let resolve!: RoundWaiter["resolve"];
  let reject!: RoundWaiter["reject"];
  const promise = new Promise<ExecutionResumeResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, waiter: { resolve, reject } };
}
function mergeFailure(primary: string | undefined, cleanup: readonly string[]): string | undefined {
  if (cleanup.length === 0) return primary;
  const suffix = cleanup.map((error) => i18n.t("terminalBackend.cleanupFailed", { error })).join("\n");
  return primary ? `${primary}\n${suffix}` : suffix;
}
function fileStamp(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.size}:${stat.mtimeNs}`;
  } catch { return undefined; }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(signal.reason ?? new Error(i18n.t("terminal.cancelled"))); };
    const cleanup = () => signal.removeEventListener("abort", stop);
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
}

function exitDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(i18n.t("bridge.retirementTimeout"))), milliseconds);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function retirementReceipt(
  wait: (signal: AbortSignal) => Promise<unknown>,
  milliseconds: number,
): Promise<void> {
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

function tokenStats(messages: readonly TranscriptMessage[]) {
  const tokens = { input: 0, output: 0, cacheWrite: 0 };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const usage = (message as { usage?: Record<string, unknown> }).usage;
    for (const key of ["input", "output", "cacheWrite"] as const) {
      const value = usage?.[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) tokens[key] += value;
    }
  }
  return { tokens, contextUsage: { percent: null } };
}

function validateStructuredResult(
  state: StandardState,
  final: Pick<ChildSettlement, "structuredJson" | "structuredRetried" | "failure" | "aborted">,
): { json?: string; failure?: string } {
  const invalid = () => ({ failure: i18n.t("terminalPolicy.invalidResult") });
  if (!state.wireSchema) return final.structuredJson !== undefined || final.structuredRetried ? invalid() : {};
  if (final.structuredJson === undefined) return final.failure || final.aborted ? {} : invalid();
  try {
    const value: unknown = JSON.parse(final.structuredJson);
    if (state.wireSchema.check(value) !== true || state.structuredCheck?.(value) !== true) return invalid();
    return { json: JSON.stringify(value) };
  } catch { return invalid(); }
}

function settlementResult(state: StandardState, final: ChildSettlement): ExecutionResumeResult {
  const structured = validateStructuredResult(state, final);
  const failure = structured.failure ?? final.failure;
  return {
    text: final.text,
    ...(failure !== undefined ? { failure } : {}),
    ...(final.aborted ? { aborted: true } : {}),
    ...(final.steered ? { steered: true } : {}),
    ...(structured.json !== undefined ? { structuredJson: structured.json } : {}),
    ...(final.structuredRetried ? { structuredRetried: true } : {}),
  };
}

/** Standard profile: normal Pi resources and a real long-lived terminal when requested. */
export function createStandardTerminalExecutionBackend(
  config: TerminalBackendConfig = {},
  ports: TerminalBackendPorts = {},
): AgentExecutionBackend {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(i18n.t("terminalBackend.invalidConfig"));
  if (process.platform === "win32" && !ports.bridge) throw new Error(i18n.t("terminalBackend.unsupported", { feature: "win32/process-tree" }));
  if (config.interpreter === "powershell" && !ports.bridge) throw new Error(i18n.t("terminalBackend.unsupported", { feature: "powershell/process-tree" }));
  const startupTimeout = config.startupTimeoutMs ?? 120_000;
  const exitTimeout = config.exitTimeoutMs ?? 5_000;
  const agentDir = config.agentDir ?? getAgentDir();
  const sessionDir = config.sessionDir ?? join(agentDir, "terminal-subagents", "sessions");
  if (!isAbsolute(agentDir) || !isAbsolute(sessionDir) || !Number.isFinite(startupTimeout)
    || startupTimeout <= 0 || !Number.isFinite(exitTimeout) || exitTimeout <= 0) {
    throw new Error(i18n.t("terminalBackend.invalidConfig"));
  }
  const dependencies = ports.dependencies ?? createTerminalDependencies();
  const states = new WeakMap<ExecutionSession, StandardState>();
  const files = new Map<string, StandardState>();

  const getState = (handle: ExecutionSession): StandardState => {
    const state = states.get(handle);
    if (!state) throw new Error(i18n.t("backend.invalidSession"));
    if (state.closed) throw new Error(i18n.t("backend.closedSession"));
    return state;
  };

  const refreshFromDisk = (state: StandardState): void => {
    try {
      const stamp = fileStamp(state.reference.sessionFile);
      if (stamp !== undefined && stamp === state.diskStamp) return;
      const current = readStandardSessionSnapshot(state.reference.sessionFile, state.policy.cwd);
      state.diskStamp = stamp;
      state.branch = current.branch;
      state.snapshot = {
        ...state.snapshot,
        messages: current.messages,
        stats: {
          ...tokenStats(current.messages),
          // The JSONL transcript has no live context-window percentage. Preserve
          // the authenticated SDK snapshot rather than replacing it with null.
          contextUsage: state.snapshot.stats?.contextUsage ?? { percent: null },
        },
      };
    } catch { /* a live append can be between JSONL writes; bridge snapshot remains authoritative */ }
  };

  const publish = (state: StandardState, snapshot: TerminalSnapshot, event: SessionViewEvent) => {
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
    refreshFromDisk(state);
    if (!state.closed) for (const listener of state.listeners) safely(() => listener(event));
  };

  const adopt = (
    reference: PersistentSessionReference<"terminal">,
    policy: StandardTerminalPolicy,
    validator?: CompiledSchema,
    lifetime: { exposeSessionFile?: boolean; ephemeralOwned?: boolean } = {},
  ): StandardState => {
    const initial = readStandardSessionSnapshot(reference.sessionFile, policy.cwd);
    const listeners = new Set<(event: SessionViewEvent) => void>();
    const state = {
      reference,
      policy,
      exposeSessionFile: lifetime.exposeSessionFile ?? true,
      ephemeralOwned: lifetime.ephemeralOwned ?? false,
      listeners,
      branch: initial.branch,
      snapshot: {
        messages: initial.messages,
        stats: tokenStats(initial.messages),
        ...(policy.model ? { model: policy.model } : {}),
        ...(policy.thinkingLevel ? { thinkingLevel: policy.thinkingLevel } : {}),
      },
      structuredCheck: validator?.check.bind(validator),
      wireSchema: policy.structuredSchema ? compileTerminalSchema(policy.structuredSchema) : undefined,
      closed: false,
      poisoned: false,
      running: false,
      roundQueued: false,
      roundActive: false,
      roundAdmitted: false,
      roundText: "",
      callbacks: {},
      diskStamp: fileStamp(reference.sessionFile),
    } as StandardState;
    let handle!: ExecutionSession;
    const publicReference = state.exposeSessionFile
      ? reference
      : Object.freeze({ backend: "terminal" as const, sessionId: reference.sessionId });
    handle = Object.freeze({
      reference: publicReference,
      get model() { return state.snapshot.model; },
      get thinkingLevel() { return state.snapshot.thinkingLevel; },
      get messages() { return state.snapshot.messages; },
      get terminal() {
        return Object.freeze({
          cli: state.policy.cli,
          interactive: state.policy.interactive,
          autoExit: state.policy.autoExit,
          ...(state.terminal ? { surface: state.terminal.surface } : {}),
        });
      },
      getSessionStats: () => state.snapshot.stats ?? EMPTY_STATS,
      getBranch: () => state.branch,
      subscribe(listener: (event: SessionViewEvent) => void) {
        if (!state.closed) listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    });
    state.handle = handle;
    states.set(handle, state);
    files.set(realpathSync(reference.sessionFile), state);
    return state;
  };

  const invoke = (
    state: StandardState,
    prompt: string,
    callbacks: StandardCallbacks = {},
  ): Promise<ExecutionRunResult> => {
    if (state.running) return Promise.reject(new Error(i18n.t("terminalBackend.busy")));
    if (state.poisoned) return Promise.reject(new Error(i18n.t("terminalBackend.quarantined")));
    const required = snapshotRequiredTools(callbacks.requiredTools);
    state.running = true;
    state.roundQueued = false;
    state.roundActive = false;
    state.roundAdmitted = false;
    state.executionId = undefined;
    state.roundText = "";
    state.lastIdle = undefined;
    state.callbacks = callbacks;
    state.pendingCallbacks = callbacks;
    const controller = new AbortController();
    state.controller = controller;
    const parentSignal = callbacks.signal;
    const parentAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) parentAbort(); else parentSignal?.addEventListener("abort", parentAbort, { once: true });
    const runId = randomUUID();

    const execute = async (): Promise<ExecutionRunResult> => {
      let bridge: TerminalBridge | undefined;
      let terminal: TerminalRun | undefined;
      let launch: ReturnType<typeof prepareStandardTerminalLaunch> | undefined;
      let terminalResult: TerminalRunResult | undefined;
      let retirementProven = false;
      let outcome: ExecutionRunResult | undefined;
      let fatalFailure: Error | undefined;
      const cleanupFailures: string[] = [];
      const rejectRound = (error: unknown) => {
        const waiter = state.roundWaiter;
        state.roundWaiter = undefined;
        waiter?.reject(error);
      };
      try {
        controller.signal.throwIfAborted();
        const run = { runId, session: state.reference };
        bridge = await (ports.bridge ?? openTerminalBridge)(run, (event: ChildFeedback) => {
          if (state.closed || controller.signal.aborted) return;
          const active = state.activeCallbacks ?? state.callbacks;
          switch (event.type) {
            case "ready": publish(state, event.snapshot, { type: "changed" }); break;
            case "snapshot": publish(state, event.snapshot, event.event); break;
            case "execution_request": {
              if (state.roundActive || state.roundAdmitted) {
                try { bridge?.admit(event.id, i18n.t("terminalBackend.busy")); } catch { /* bridge teardown owns failure */ }
                break;
              }
              state.roundQueued = false;
              state.roundActive = true;
              state.roundAdmitted = false;
              state.executionId = event.id;
              state.lastIdle = undefined;
              state.roundText = "";
              state.activeCallbacks = state.pendingCallbacks ?? state.callbacks;
              const { signal: _roundSignal, ...persistentCallbacks } = state.activeCallbacks;
              state.callbacks = persistentCallbacks;
              state.pendingCallbacks = undefined;
              const admission = state.activeCallbacks.acquireExecution;
              const callbackSignal = state.activeCallbacks.signal;
              const admissionSignal = callbackSignal && callbackSignal !== controller.signal
                ? AbortSignal.any([controller.signal, callbackSignal])
                : controller.signal;
              void (async () => {
                try {
                  await admission?.(admissionSignal);
                  admissionSignal.throwIfAborted();
                  state.roundAdmitted = true;
                  bridge?.admit(event.id);
                } catch (error) {
                  // A denied exact request still owns the following terminal
                  // settlement; keep its id until the child reports that abort.
                  state.roundAdmitted = true;
                  rejectRound(error);
                  try { bridge?.admit(event.id, errorText(error)); }
                  catch (deliveryError) {
                    fatalFailure = deliveryError instanceof Error ? deliveryError : new Error(errorText(deliveryError));
                    state.poisoned = true;
                    controller.abort(fatalFailure);
                  }
                }
              })();
              break;
            }
            case "idle": {
              if (!state.roundActive || !state.roundAdmitted || event.executionId !== state.executionId) {
                const error = new Error(i18n.t("bridge.protocol"));
                fatalFailure = error;
                state.poisoned = true;
                rejectRound(error);
                controller.abort(error);
                break;
              }
              state.lastIdle = event;
              state.roundText = event.text;
              publish(state, event.snapshot, { type: "changed" });
              const result = settlementResult(state, event);
              state.roundActive = false;
              state.roundAdmitted = false;
              state.executionId = undefined;
              state.activeCallbacks = undefined;
              safely(() => active.onExecutionIdle?.(result));
              const waiter = state.roundWaiter;
              state.roundWaiter = undefined;
              waiter?.resolve(result);
              break;
            }
            case "settled":
              if (!state.roundActive || !state.roundAdmitted || event.executionId !== state.executionId) {
                fatalFailure = new Error(i18n.t("bridge.protocol"));
                state.poisoned = true;
                controller.abort(fatalFailure);
                break;
              }
              state.lastIdle = event;
              state.roundText = event.text;
              state.roundActive = false;
              state.roundAdmitted = false;
              state.executionId = undefined;
              state.activeCallbacks = undefined;
              publish(state, event.snapshot, { type: "changed" });
              break;
            case "text": state.roundText = event.fullText; safely(() => active.onTextDelta?.(event.delta, event.fullText)); break;
            case "tool": safely(() => active.onToolActivity?.(event.activity)); break;
            case "usage": safely(() => active.onAssistantUsage?.(event.usage)); break;
            case "turn": safely(() => active.onTurnEnd?.(event.count)); break;
            case "compaction": safely(() => active.onCompaction?.(event.info)); break;
            case "ack": case "failure": break;
          }
        }, startupTimeout);
        state.bridge = bridge;
        controller.signal.throwIfAborted();
        launch = prepareStandardTerminalLaunch(state.policy, state.reference, runId, bridge.endpoint, prompt, required, config);
        controller.signal.throwIfAborted();
        // Runtime cancellation is coordinated through the authenticated bridge
        // first; the lifecycle watcher stays alive long enough to observe the
        // supervisor receipt. terminal.cancel() is the bounded force fallback.
        terminal = await launchTerminalRun(launch, {
          ...dependencies,
          transport: {
            ...dependencies.transport,
            waitForExit: async (_surface, signal) => (ports.waitForExit ?? waitForProcessExit)(launch!.processExit, signal),
          },
        });
        state.terminal = terminal;
        controller.signal.throwIfAborted();
        const exitedBeforeReady = terminal.completion.then(() => { throw new Error(i18n.t("bridge.exitedBeforeReady")); });
        await abortable(Promise.race([bridge.ready, exitedBeforeReady]), controller.signal);
        callbacks.onSessionCreated?.(state.handle);
        bridge.start();

        let final: ChildSettlement;
        if (state.policy.autoExit) {
          final = await abortable(bridge.settled, controller.signal);
          terminalResult = await exitDeadline(terminal.completion, exitTimeout);
        } else {
          terminalResult = await abortable(terminal.completion, controller.signal);
          refreshFromDisk(state);
          final = state.lastIdle ?? {
            snapshot: state.snapshot,
            text: state.roundText,
            aborted: false,
            failure: terminalResult.status === "failed" ? terminalResult.error ?? terminalResult.summary : undefined,
          };
        }
        retirementProven = terminalResult.reason === "sentinel";
        refreshFromDisk(state);
        const structured = validateStructuredResult(state, final);
        outcome = {
          session: state.handle,
          responseText: final.text,
          aborted: final.aborted || terminalResult.status === "cancelled",
          steered: final.steered === true,
          ...(structured.json !== undefined ? { structuredJson: structured.json } : {}),
          ...(final.structuredRetried ? { structuredRetried: true } : {}),
          failure: structured.failure ?? final.failure ?? (terminalResult.status === "failed"
            // Pi print mode uses exit 1 for an acknowledged SDK abort. A proven
            // exit with that outcome is not a provider/retirement failure.
            && !(final.aborted && terminalResult.reason === "sentinel" && terminalResult.exitCode === 1)
            ? terminalResult.error ?? terminalResult.summary : undefined),
        };
        return outcome;
      } catch (error) {
        if (fatalFailure) {
          bridge?.abort();
          outcome = { session: state.handle, responseText: state.roundText, aborted: false, steered: false, failure: fatalFailure.message };
        } else if (controller.signal.aborted) {
          bridge?.abort();
          outcome = { session: state.handle, responseText: state.roundText, aborted: true, steered: false };
        } else {
          outcome = { session: state.handle, responseText: state.roundText, aborted: false, steered: false, failure: errorText(error) };
        }
        return outcome;
      } finally {
        if (terminal && controller.signal.aborted && !retirementProven) {
          try {
            terminalResult = await exitDeadline(terminal.completion, exitTimeout);
            if (terminalResult.reason === "sentinel") retirementProven = true;
            if (terminalResult.cleanupError) cleanupFailures.push(terminalResult.cleanupError);
          } catch { /* force cancellation below, then independently await receipt */ }
        }
        if (terminal) {
          try {
            terminalResult = await terminal.cancel();
            if (terminalResult.reason === "sentinel") retirementProven = true;
            if (terminalResult.cleanupError) cleanupFailures.push(terminalResult.cleanupError);
          } catch (error) { cleanupFailures.push(errorText(error)); }
        }
        if (!retirementProven && terminal && launch) {
          try {
            await retirementReceipt(
              (signal) => (ports.waitForExit ?? waitForProcessExit)(launch!.processExit, signal),
              exitTimeout,
            );
            retirementProven = true;
          } catch (error) { cleanupFailures.push(errorText(error)); }
        }
        if (!retirementProven && terminal) state.poisoned = true;
        if (bridge) {
          try { await exitDeadline(bridge.close(), exitTimeout); }
          catch (error) { cleanupFailures.push(errorText(error)); }
        }
        if (state.poisoned) {
          try { quarantineStandardTerminalSession(state.reference); }
          catch (error) { cleanupFailures.push(errorText(error)); }
        }
        if (cleanupFailures.length > 0) {
          const uniqueCleanupFailures = [...new Set(cleanupFailures)];
          state.retirementError = new Error(uniqueCleanupFailures.join("\n"));
          if (outcome) outcome.failure = mergeFailure(outcome.failure, uniqueCleanupFailures);
        }
        rejectRound(new Error(outcome?.failure ?? i18n.t("bridge.notRunning")));
        parentSignal?.removeEventListener("abort", parentAbort);
        state.bridge = undefined;
        state.terminal = undefined;
        state.controller = undefined;
        state.pendingCallbacks = undefined;
        state.activeCallbacks = undefined;
        state.roundQueued = false;
        state.roundActive = false;
        state.roundAdmitted = false;
        state.executionId = undefined;
        state.running = false;
      }
    };
    const operation = execute();
    state.operation = operation;
    return operation;
  };

  const resumePersistent = async (
    state: StandardState,
    prompt: string,
    options: ExecutionResumeOptions = {},
  ): Promise<ExecutionResumeResult> => {
    if (!state.running || state.policy.autoExit) {
      const result = await invoke(state, prompt, options);
      return {
        text: result.responseText,
        ...(result.failure !== undefined ? { failure: result.failure } : {}),
        ...(result.aborted ? { aborted: true } : {}),
        ...(result.steered ? { steered: true } : {}),
        ...(result.structuredJson !== undefined ? { structuredJson: result.structuredJson } : {}),
        ...(result.structuredRetried ? { structuredRetried: true } : {}),
      };
    }
    if (state.poisoned) throw new Error(i18n.t("terminalBackend.quarantined"));
    if (!state.bridge || !state.lastIdle || state.roundQueued || state.roundActive || state.roundWaiter) {
      throw new Error(i18n.t("terminalBackend.busy"));
    }
    options.signal?.throwIfAborted();
    const callbacks: StandardCallbacks = {
      ...state.callbacks,
      ...options,
      acquireExecution: options.acquireExecution ?? state.callbacks.acquireExecution,
      onExecutionIdle: options.onExecutionIdle ?? state.callbacks.onExecutionIdle,
    };
    const pending = deferredRound();
    state.roundQueued = true;
    state.pendingCallbacks = callbacks;
    state.roundWaiter = pending.waiter;
    const onAbort = () => {
      if (state.roundAdmitted) void state.bridge?.interrupt().catch((error) => pending.waiter.reject(error));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await state.bridge.steer(prompt);
      return await pending.promise;
    } catch (error) {
      if (state.roundWaiter === pending.waiter) state.roundWaiter = undefined;
      if (state.pendingCallbacks === callbacks) state.pendingCallbacks = undefined;
      state.roundQueued = false;
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  };

  const owned = (reference: PersistentSessionReference): StandardState | undefined => {
    if (!reference || reference.backend !== "terminal" || !isAbsolute(reference.sessionFile)) {
      throw new Error(i18n.t("sessionStore.invalidRecord"));
    }
    let canonical: string;
    try { canonical = realpathSync(reference.sessionFile); }
    catch { throw new Error(i18n.t("sessionStore.invalidFile")); }
    const state = files.get(canonical);
    if (state && state.reference.sessionId !== reference.sessionId) throw new Error(i18n.t("sessionStore.invalidRecord"));
    return state;
  };

  return {
    kind: "terminal",
    async run(ctx, type, prompt, options) {
      options.signal?.throwIfAborted();
      const prepared = await prepareStandardTerminalPolicy(ctx, type, options);
      options.signal?.throwIfAborted();
      const callerSupplied = options.resumeSessionFile !== undefined;
      const reference = callerSupplied
        ? adoptStandardTerminalSession(options.resumeSessionFile!, prepared.policy)
        : createStandardTerminalSession(prepared.policy, prepared.policy.sessionDir ?? sessionDir);
      const state = adopt(reference, prepared.policy, options.structuredOutput, {
        exposeSessionFile: callerSupplied || prepared.policy.persistSession,
        ephemeralOwned: !callerSupplied && !prepared.policy.persistSession,
      });
      return invoke(state, prepared.prompt(prompt), options);
    },
    async reattach(reference, options: ExecutionRestoreOptions = {}) {
      options.signal?.throwIfAborted();
      if (owned(reference)) throw new Error(i18n.t("sessionStore.alreadyOwned"));
      const opened = openStandardTerminalSession(reference, options);
      return adopt(opened.reference, opened.policy, options.structuredOutput).handle;
    },
    async fork(reference, options: ExecutionRestoreOptions = {}) {
      options.signal?.throwIfAborted();
      const current = owned(reference);
      if (current?.running) throw new Error(i18n.t("terminalBackend.busy"));
      if (current?.poisoned || current?.closed) throw new Error(i18n.t("terminalBackend.quarantined"));
      const stored = openStandardTerminalSession(reference, options);
      const opened = current ?? { reference: stored.reference, policy: stored.policy };
      const forked = forkStandardTerminalSession(opened.reference, opened.policy, opened.policy.sessionDir ?? sessionDir);
      return adopt(forked, opened.policy, options.structuredOutput).handle;
    },
    async resume(handle, prompt, options) {
      return resumePersistent(getState(handle), prompt, options);
    },
    async steer(handle, message) {
      const state = getState(handle);
      if (!state.running || typeof message !== "string" || !message.trim() || !state.bridge) {
        throw new Error(i18n.t("bridge.notRunning"));
      }
      await state.bridge.steer(message);
    },
    async interrupt(handle) {
      const state = getState(handle);
      if (!state.running || !state.roundAdmitted || !state.bridge) throw new Error(i18n.t("terminal.notRunning"));
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
      state.shutdown = (async () => {
        let failure: unknown;
        let canonical = state.reference.sessionFile;
        try { canonical = realpathSync(state.reference.sessionFile); } catch { /* cleanup still owns the recorded path */ }
        try { await state.operation; } catch (error) { failure = error; }
        try {
          if (state.ephemeralOwned && !state.poisoned && state.retirementError === undefined) {
            removeStandardTerminalSession(state.reference);
          }
        } finally {
          files.delete(canonical);
        }
        if (failure !== undefined) throw failure;
        if (state.retirementError !== undefined) throw state.retirementError;
      })();
      return state.shutdown;
    },
  };
}
