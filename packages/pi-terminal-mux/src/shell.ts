import { basename } from "node:path";

export function isFishShell(): boolean {
  return basename(process.env.SHELL ?? "") === "fish";
}

export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}

/** Single-quote POSIX shell escaping. */
export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** PowerShell single-quoted strings escape quotes by doubling them. */
export function powershellEscape(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}
