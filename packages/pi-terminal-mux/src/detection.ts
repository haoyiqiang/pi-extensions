import { appendFileSync } from "node:fs";
import { isOrcaRuntimeAvailable } from "./orca.ts";
import { hasCommand } from "./backends/shared.ts";

export type MuxBackend = "tmux" | "orca";

export function muxLog(message: string): void {
  try {
    appendFileSync("/tmp/pi-terminal-mux.log", `[${new Date().toISOString()}] ${message}`);
  } catch {
    // Logging must not interrupt terminal operations.
  }
}

function muxPreference(): MuxBackend | null {
  const preference = (process.env.PI_TERMINAL_MUX ?? process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (!preference) return null;
  if (preference === "tmux" || preference === "orca") return preference;
  throw new Error(`Unsupported terminal multiplexer: ${preference}. Choose tmux or orca.`);
}

export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isOrcaAvailable(): boolean {
  return isOrcaRuntimeAvailable();
}

/** A forced backend never falls back to another terminal backend. */
export function getMuxBackend(): MuxBackend | null {
  const preference = muxPreference();
  if (preference === "tmux") return isTmuxAvailable() ? "tmux" : null;
  if (preference === "orca") return isOrcaAvailable() ? "orca" : null;
  if (isTmuxAvailable()) return "tmux";
  if (isOrcaAvailable()) return "orca";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  const preference = muxPreference();
  if (preference === "tmux") return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  if (preference === "orca") return "Run pi inside Orca (Orca sets TERM_PROGRAM=Orca and ORCA_TERMINAL_HANDLE automatically).";
  return "Start pi inside tmux or Orca, or use headless mode.";
}
