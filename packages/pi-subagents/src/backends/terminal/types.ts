import type { PersistentSessionReference, RunReference } from "../session-reference.js";

/** Lifecycle only: callers prepare session files, prompts, model/tool policy and CLI arguments. */
export interface TerminalLaunchPlan {
  readonly run: RunReference<"terminal">;
  readonly name: string;
  readonly launchScriptFile: string;
  /** Explicit shell selection; omitted preserves pi-terminal-mux's Bash default. */
  readonly interpreter?: "bash" | "powershell";
  /** Receives the newly owned surface for child identity/environment wiring. */
  readonly buildCommand: (surface: string) => string;
  readonly shellReadyDelayMs?: number;
  readonly signal?: AbortSignal;
  /** Observation only: errors here must not terminate the child. */
  readonly onTick?: (elapsedSeconds: number) => void;
}

export interface TerminalExit {
  readonly reason: "done" | "ping" | "structured_output" | "sentinel";
  readonly exitCode: number;
  readonly ping?: { name: string; message: string };
  readonly structuredOutput?: unknown;
}

export interface TerminalRunResult {
  readonly run: RunReference<"terminal">;
  readonly status: "completed" | "failed" | "cancelled";
  readonly exitCode: number;
  readonly summary: string;
  readonly elapsedSeconds: number;
  readonly reason?: TerminalExit["reason"];
  readonly ping?: TerminalExit["ping"];
  readonly structuredOutput?: unknown;
  readonly error?: string;
  /** Cleanup failure is observable without overwriting the child's result. */
  readonly cleanupError?: string;
}

export interface TerminalRun {
  readonly run: RunReference<"terminal">;
  readonly surface: string;
  /** Starts automatically. Consumers await completion rather than polling logs. */
  readonly completion: Promise<TerminalRunResult>;
  /** Escape only; the run, pane and completion watcher remain alive. */
  interrupt(): Promise<void>;
  /** Cancels watching and closes the owned surface; idempotent. */
  cancel(): Promise<TerminalRunResult>;
}

export interface TerminalTransport {
  createSurface(name: string): string;
  sendCommand(surface: string, command: string, scriptPath: string, interpreter?: "bash" | "powershell"): void;
  sendEscape(surface: string): void;
  closeSurface(surface: string): void;
  waitForExit(
    surface: string,
    signal: AbortSignal,
    options: { sessionFile: string; onTick?: (elapsedSeconds: number) => void },
  ): Promise<TerminalExit>;
}

export interface TerminalTranscriptCursor {
  readonly byteOffset: number;
  readonly sessionId?: string;
  /** Digest of the old prefix; detects replacement/rewrite without retaining its contents. */
  readonly prefixDigest?: string;
}

export interface TerminalArtifacts {
  /** Remove a stale .exit marker and snapshot the existing transcript before launch. */
  prepare(session: PersistentSessionReference<"terminal">): TerminalTranscriptCursor;
  /** Only this invocation's assistant output; never return a previous turn as new output. */
  readSummary(sessionFile: string, cursor: TerminalTranscriptCursor): string | undefined;
}

export interface TerminalDependencies {
  readonly transport: TerminalTransport;
  readonly artifacts: TerminalArtifacts;
  readonly now: () => number;
  /** Must detach its abort listener and clear its timer when it settles. */
  readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
