import { isAbsolute, resolve } from "node:path";
import { i18n } from "../../i18n.js";
import type { RunReference } from "../session-reference.js";
import type {
  TerminalDependencies,
  TerminalExit,
  TerminalLaunchPlan,
  TerminalRun,
  TerminalRunResult,
  TerminalTranscriptCursor,
} from "./types.js";

const DEFAULT_SHELL_READY_DELAY_MS = 500;
const FAILURE_EXIT_CODE = 1;

interface CloseResult {
  readonly ok: boolean;
  readonly error?: unknown;
}

type WaitOutcome =
  | { readonly kind: "exit"; readonly exit: TerminalExit }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "aborted" };

/** Launch one owned terminal surface and watch it through cleanup. */
export async function launchTerminalRun(
  plan: TerminalLaunchPlan,
  dependencies: TerminalDependencies,
): Promise<TerminalRun> {
  const run = snapshotRun(plan.run);
  const launchScriptFile = plan.launchScriptFile;
  const interpreter = plan.interpreter;
  const shellReadyDelayMs = plan.shellReadyDelayMs === undefined
    ? DEFAULT_SHELL_READY_DELAY_MS
    : plan.shellReadyDelayMs;
  const parentSignal = plan.signal;
  const name = plan.name;
  const buildCommand = plan.buildCommand;
  const onTick = plan.onTick;

  validatePlan(run, launchScriptFile, shellReadyDelayMs, interpreter);
  if (parentSignal?.aborted) throw abortReason(parentSignal);

  const controller = new AbortController();
  let detachParent = () => {};
  let surface: string | undefined;
  let closeResult: CloseResult | undefined;

  const closeSurfaceOnce = (): CloseResult => {
    if (closeResult) return closeResult;
    if (surface === undefined) return { ok: true };
    try {
      dependencies.transport.closeSurface(surface);
      closeResult = { ok: true };
    } catch (error) {
      closeResult = { ok: false, error };
    }
    return closeResult;
  };

  try {
    if (parentSignal) {
      const onParentAbort = () => {
        if (!controller.signal.aborted) controller.abort(parentSignal.reason);
      };
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      detachParent = () => parentSignal.removeEventListener("abort", onParentAbort);
      // Re-check after registration so a signal cannot abort between the first check and linkage.
      if (parentSignal.aborted) onParentAbort();
    }

    throwIfAborted(controller.signal);
    const startedAt = dependencies.now();
    throwIfAborted(controller.signal);

    const cursor = dependencies.artifacts.prepare(run.session);
    throwIfAborted(controller.signal);

    surface = dependencies.transport.createSurface(name);
    throwIfAborted(controller.signal);

    await dependencies.delay(shellReadyDelayMs, controller.signal);
    throwIfAborted(controller.signal);

    const command = buildCommand(surface);
    throwIfAborted(controller.signal);

    dependencies.transport.sendCommand(surface, command, launchScriptFile, interpreter);
    throwIfAborted(controller.signal);

    const ownedSurface = surface;
    let running = true;
    const completion = watchCompletion({
      run,
      surface: ownedSurface,
      cursor,
      controller,
      dependencies,
      startedAt,
      onTick,
      closeSurfaceOnce,
      detachParent,
      markFinished: () => { running = false; },
    });

    return {
      run,
      surface: ownedSurface,
      completion,
      async interrupt(): Promise<void> {
        if (!running || controller.signal.aborted) throw new Error(i18n.t("terminal.notRunning"));
        dependencies.transport.sendEscape(ownedSurface);
      },
      cancel(): Promise<TerminalRunResult> {
        if (running && !controller.signal.aborted) controller.abort();
        return completion;
      },
    };
  } catch (error) {
    detachParent();
    const cleanup = closeSurfaceOnce();
    if (!cleanup.ok) {
      throw new AggregateError(
        [error, cleanup.error],
        errorMessage(error),
        { cause: error },
      );
    }
    throw error;
  }
}

function snapshotRun(run: TerminalLaunchPlan["run"]): RunReference<"terminal"> {
  const session = Object.freeze({
    backend: run.session.backend,
    sessionId: run.session.sessionId,
    sessionFile: run.session.sessionFile,
  });
  return Object.freeze({ runId: run.runId, session });
}

function validatePlan(
  run: RunReference<"terminal">,
  launchScriptFile: string,
  shellReadyDelayMs: number,
  interpreter: TerminalLaunchPlan["interpreter"],
): void {
  const validReference = run.session.backend === "terminal"
    && typeof run.runId === "string"
    && run.runId.trim().length > 0
    && typeof run.session.sessionId === "string"
    && run.session.sessionId.trim().length > 0
    && typeof run.session.sessionFile === "string"
    && isAbsolute(run.session.sessionFile)
    && typeof launchScriptFile === "string"
    && isAbsolute(launchScriptFile);
  if (!validReference) throw new Error(i18n.t("terminal.invalidReference"));
  const scriptPath = resolve(launchScriptFile);
  if (scriptPath === resolve(run.session.sessionFile) || scriptPath === resolve(`${run.session.sessionFile}.exit`)) {
    throw new Error(i18n.t("terminal.scriptOverwritesSession"));
  }
  if (interpreter !== undefined && interpreter !== "bash" && interpreter !== "powershell") {
    throw new Error(i18n.t("terminal.invalidInterpreter"));
  }

  if (typeof shellReadyDelayMs !== "number" || !Number.isFinite(shellReadyDelayMs) || shellReadyDelayMs < 0) {
    throw new Error(i18n.t("terminal.invalidDelay"));
  }
}

interface CompletionOptions {
  readonly run: RunReference<"terminal">;
  readonly surface: string;
  readonly cursor: TerminalTranscriptCursor;
  readonly controller: AbortController;
  readonly dependencies: TerminalDependencies;
  readonly startedAt: number;
  readonly onTick?: (elapsedSeconds: number) => void;
  readonly closeSurfaceOnce: () => CloseResult;
  readonly detachParent: () => void;
  readonly markFinished: () => void;
}

async function watchCompletion(options: CompletionOptions): Promise<TerminalRunResult> {
  const { run, surface, cursor, controller, dependencies, startedAt } = options;
  let observing = true;
  const observedTick = options.onTick
    ? (elapsedSeconds: number) => {
      if (!observing || controller.signal.aborted) return;
      try {
        options.onTick?.(elapsedSeconds);
      } catch {
        // Observation must not change the child lifecycle.
      }
    }
    : undefined;

  let result: Omit<TerminalRunResult, "elapsedSeconds" | "cleanupError">;
  try {
    const outcome = await waitForExitOrAbort(
      () => dependencies.transport.waitForExit(surface, controller.signal, {
        sessionFile: run.session.sessionFile,
        onTick: observedTick,
      }),
      controller.signal,
    );

    if (outcome.kind === "aborted") {
      result = cancelledResult(run);
    } else if (outcome.kind === "error") {
      result = failureResult(run, outcome.error);
    } else {
      result = resultFromExit(run, outcome.exit, cursor, dependencies);
    }
  } catch (error) {
    // Port failures, malformed output and observer-independent lifecycle faults resolve as results.
    result = controller.signal.aborted ? cancelledResult(run) : failureResult(run, error);
  }

  observing = false;
  options.markFinished();
  options.detachParent();
  const cleanup = options.closeSurfaceOnce();
  const elapsedSeconds = elapsedSince(startedAt, dependencies.now);
  return {
    ...result,
    elapsedSeconds,
    ...(cleanup.ok ? {} : { cleanupError: errorMessage(cleanup.error) }),
  };
}

function resultFromExit(
  run: RunReference<"terminal">,
  exit: TerminalExit,
  cursor: TerminalTranscriptCursor,
  dependencies: TerminalDependencies,
): Omit<TerminalRunResult, "elapsedSeconds" | "cleanupError"> {
  const childFields = exitFields(exit);
  let summary: string | undefined;
  try {
    summary = dependencies.artifacts.readSummary(run.session.sessionFile, cursor);
    if (summary !== undefined && typeof summary !== "string") {
      throw new TypeError(i18n.t("terminal.invalidSummary"));
    }
  } catch (error) {
    return {
      run,
      status: "failed",
      exitCode: exit.exitCode,
      summary: i18n.t("terminal.failed", { error: errorMessage(error) }),
      error: errorMessage(error),
      ...childFields,
    };
  }

  if (exit.exitCode !== 0) {
    const exitError = i18n.t("terminal.exitError", { code: exit.exitCode });
    return {
      run,
      status: "failed",
      exitCode: exit.exitCode,
      summary: summary ?? exitError,
      ...childFields,
    };
  }

  return {
    run,
    status: "completed",
    exitCode: exit.exitCode,
    summary: summary ?? i18n.t("terminal.finished"),
    ...childFields,
  };
}

function exitFields(exit: TerminalExit): Pick<TerminalRunResult, "reason" | "ping" | "structuredOutput"> {
  return {
    reason: exit.reason,
    ...(exit.ping !== undefined ? { ping: exit.ping } : {}),
    ...(Object.prototype.hasOwnProperty.call(exit, "structuredOutput")
      ? { structuredOutput: exit.structuredOutput }
      : {}),
  };
}

function cancelledResult(
  run: RunReference<"terminal">,
): Omit<TerminalRunResult, "elapsedSeconds" | "cleanupError"> {
  return {
    run,
    status: "cancelled",
    exitCode: FAILURE_EXIT_CODE,
    summary: i18n.t("terminal.cancelled"),
  };
}

function failureResult(
  run: RunReference<"terminal">,
  error: unknown,
): Omit<TerminalRunResult, "elapsedSeconds" | "cleanupError"> {
  const message = errorMessage(error);
  return {
    run,
    status: "failed",
    exitCode: FAILURE_EXIT_CODE,
    summary: i18n.t("terminal.failed", { error: message }),
    error: message,
  };
}

function waitForExitOrAbort(startWait: () => Promise<TerminalExit>, signal: AbortSignal): Promise<WaitOutcome> {
  let wait: Promise<TerminalExit>;
  try {
    wait = startWait();
  } catch (error) {
    return Promise.resolve(signal.aborted ? { kind: "aborted" } : { kind: "error", error });
  }

  return new Promise<WaitOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: WaitOutcome) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => settle({ kind: "aborted" });

    wait.then(
      (exit) => settle({ kind: "exit", exit }),
      (error: unknown) => settle(signal.aborted ? { kind: "aborted" } : { kind: "error", error }),
    );

    if (signal.aborted) settle({ kind: "aborted" });
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

function elapsedSince(startedAt: number, now: () => number): number {
  try {
    const elapsed = (now() - startedAt) / 1_000;
    return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  } catch {
    return 0;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException(i18n.t("terminal.cancelled"), "AbortError");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  try {
    return String(error);
  } catch {
    return i18n.t("terminal.unknownError");
  }
}
