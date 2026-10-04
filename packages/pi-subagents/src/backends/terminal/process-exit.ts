import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { i18n } from "../../i18n.js";
import type { TerminalExit } from "./types.js";

export interface ProcessExitReceipt {
  readonly path: string;
  readonly runId: string;
  readonly token: string;
}

/** Observe an atomic supervisor-owned receipt, never assistant/tool output or a shared .exit file. */
export function waitForProcessExit(receipt: ProcessExitReceipt, signal: AbortSignal): Promise<TerminalExit> {
  return new Promise((resolve, reject) => {
    let watcher: FSWatcher | undefined;
    let finished = false;
    const finish = (error?: unknown, exitCode?: number) => {
      if (finished) return;
      finished = true;
      watcher?.close();
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolve({ reason: "sentinel", exitCode: exitCode! });
    };
    const abort = () => finish(signal.reason ?? new Error(i18n.t("terminal.cancelled")));
    const read = () => {
      if (finished) return;
      try {
        if (statSync(receipt.path).size > 4_096) throw new Error(i18n.t("bridge.invalidReceipt"));
        const value = JSON.parse(readFileSync(receipt.path, "utf8"));
        if (!value || value.version !== 1 || value.runId !== receipt.runId || value.token !== receipt.token
          || !Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 0xffff_ffff) {
          throw new Error(i18n.t("bridge.invalidReceipt"));
        }
        finish(undefined, value.exitCode);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        finish(new Error(i18n.t("bridge.invalidReceipt")));
      }
    };
    if (signal.aborted) { abort(); return; }
    try {
      // Subscribe before the first read so a fast child cannot complete in a read/watch gap.
      watcher = watch(dirname(receipt.path), (_event, name) => {
        if (name === null || name.toString() === basename(receipt.path)) read();
      });
      watcher.on("error", () => finish(new Error(i18n.t("bridge.invalidReceipt"))));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else read();
    } catch { finish(new Error(i18n.t("bridge.invalidReceipt"))); }
  });
}
