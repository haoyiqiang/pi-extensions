import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorTui {
  stop(): void;
  start(): void;
  requestRender(force?: boolean): void;
}

export interface ExternalEditorOptions {
  signal: AbortSignal;
  launchMessage: string;
  terminationGraceMs?: number;
  resumeTui?: () => boolean;
}

const DEFAULT_TERMINATION_GRACE_MS = 750;

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("External editor operation aborted");
  error.name = "AbortError";
  return error;
}

function runEditor(
  command: string,
  file: string,
  signal: AbortSignal,
  terminationGraceMs: number,
): Promise<void> {
  // Keep the command grammar identical to Pi's built-in external-editor flow. A
  // separate shell or argv parser here would make Ctrl+G behave differently.
  const [editor, ...args] = command.split(" ");
  if (!editor)
    return Promise.reject(new Error("External editor command is empty"));
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise((resolve, reject) => {
    const child = spawn(editor, [...args, file], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    let launchError: Error | undefined;
    let closeSeen = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const requestTermination = () => {
      if (closeSeen) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // A failed signal is not proof of exit. The close event remains authoritative.
      }
      killTimer = setTimeout(() => {
        if (closeSeen) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // Still wait for close; child.killed only means a signal request was accepted.
        }
      }, terminationGraceMs);
    };

    const onAbort = () => requestTermination();
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      launchError = error;
    });
    child.once("close", (code, closeSignal) => {
      closeSeen = true;
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        reject(abortError(signal));
        return;
      }
      if (launchError) {
        reject(launchError);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const reason = closeSignal
        ? `signal ${closeSignal}`
        : `exit code ${code ?? "unknown"}`;
      reject(new Error(`External editor exited with ${reason}`));
    });

    if (signal.aborted) requestTermination();
  });
}

/**
 * Edit a custom answer with Pi's configured external-editor command. Cleanup and
 * TUI restoration happen only after the child emits close, including cancellation.
 * This owns only the launcher process it spawned; an editor may delegate to an
 * already-running GUI instance outside this process lifecycle.
 */
export async function editWithExternalEditor(
  tui: ExternalEditorTui,
  command: string,
  value: string,
  options: ExternalEditorOptions,
): Promise<string> {
  if (options.signal.aborted) throw abortError(options.signal);
  const tempDir = mkdtempSync(join(tmpdir(), "pi-ask-user-question-"));
  const tempFile = join(tempDir, "answer.md");
  let tuiStopped = false;

  try {
    writeFileSync(tempFile, value, "utf8");
    tui.stop();
    tuiStopped = true;
    process.stdout.write(`${options.launchMessage}\n`);
    await runEditor(
      command,
      tempFile,
      options.signal,
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    );
    return readFileSync(tempFile, "utf8").replace(/\r?\n$/, "");
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Temp cleanup is best effort; never leave the TUI stopped because it failed.
    }
    if (tuiStopped && (options.resumeTui?.() ?? true)) {
      tui.start();
      tui.requestRender(true);
    }
  }
}
