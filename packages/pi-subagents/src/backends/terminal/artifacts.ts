import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { i18n } from "../../i18n.js";
import type { TerminalArtifacts } from "./types.js";

function readOptional(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Adapted from interactive-subagents' session summary reader; only reads the new run's entries. */
function lastAssistantSummary(entries: unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = object(entries[index]);
    if (entry?.type !== "message") continue;
    const message = object(entry.message);
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(typeof message.errorMessage === "string" && message.errorMessage
        ? message.errorMessage
        : i18n.t("terminal.assistantFailed"));
    }
    if (!Array.isArray(message.content)) continue;
    const blocks = message.content.map(object).filter((block) => block !== undefined);
    const text = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string" && block.text.trim())
      .map((block) => block.text as string)
      .join("\n");
    const done = blocks.find((block) =>
      (block.type === "toolCall" || block.type === "tool_use") && block.name === "subagent_done"
      && object(block.arguments)?.result != null,
    );
    if (done) {
      const structured = JSON.stringify(object(done.arguments)!.result, null, 2);
      return text ? `${text}\n\n${structured}` : structured;
    }
    if (text) return text;
  }
  return undefined;
}

/** Preserves session history and launch artifacts; only stale completion sidecars are removed. */
export function createTerminalArtifacts(): TerminalArtifacts {
  return {
    prepare(session) {
      const raw = readOptional(session.sessionFile) ?? Buffer.alloc(0);
      if (raw.length > 0) {
        const header = object(JSON.parse(raw.toString("utf8").split("\n").find((line) => line.trim()) ?? "null"));
        if (header?.type !== "session" || header.id !== session.sessionId) {
          throw new Error(i18n.t("terminal.sessionMismatch"));
        }
        // A settled append-only transcript must end on an entry boundary.
        if (raw[raw.length - 1] !== 10) throw new Error(i18n.t("terminal.transcriptChanged"));
      }
      const cursor = { byteOffset: raw.length, prefixDigest: digest(raw), sessionId: session.sessionId };
      rmSync(`${session.sessionFile}.exit`, { force: true });
      return cursor;
    },
    readSummary(sessionFile, cursor) {
      const raw = readOptional(sessionFile) ?? Buffer.alloc(0);
      if (raw.length < cursor.byteOffset
        || (cursor.prefixDigest !== undefined && digest(raw.subarray(0, cursor.byteOffset)) !== cursor.prefixDigest)) {
        throw new Error(i18n.t("terminal.transcriptChanged"));
      }
      if (raw.length > 0 && cursor.sessionId !== undefined) {
        const header = object(JSON.parse(raw.toString("utf8").split("\n").find((line) => line.trim()) ?? "null"));
        if (header?.type !== "session" || header.id !== cursor.sessionId) {
          throw new Error(i18n.t("terminal.sessionMismatch"));
        }
      }
      const entries = raw.subarray(cursor.byteOffset).toString("utf8").split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown);
      return lastAssistantSummary(entries);
    },
  };
}
