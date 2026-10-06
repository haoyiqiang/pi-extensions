import { readFileSync } from "node:fs";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { i18n } from "../i18n.js";
import type { SessionBranchEntry, TranscriptMessage } from "./session.js";

/** Observe a Pi transcript without opening it for writes or repairing its final newline. */
export function readSessionSnapshot(sessionFile: string, cwd?: string): {
  branch: readonly SessionBranchEntry[];
  messages: readonly TranscriptMessage[];
} {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const entries: FileEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    try { entries.push(JSON.parse(lines[index]!) as FileEntry); }
    catch (error) {
      // A live writer may still be appending its last frame. Complete records,
      // including a valid final record without a newline, remain readable.
      if (index !== lines.length - 1 || raw.endsWith("\n")) throw error;
    }
  }
  const header = entries[0] as unknown as { type?: string; cwd?: string } | undefined;
  if (header?.type !== "session" || typeof header.cwd !== "string") {
    throw new Error(i18n.t("sessionStore.invalidFile"));
  }
  const manager = SessionManager.inMemory(cwd ?? header.cwd, undefined, entries);
  return { branch: manager.getBranch(), messages: manager.buildSessionProjection().messages };
}
