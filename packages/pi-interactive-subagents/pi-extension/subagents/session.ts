import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { readCompatibleLoadout, validateLoadout, type SubagentLoadout } from "./loadout.ts";
export type { SubagentLoadout } from "./loadout.ts";

export type SeededSubagentSessionMode = "lineage-only" | "fork";

/** Snapshot the live active path, never open/migrate a parent's writable JSONL.
 * Preserve compaction/context-edit entries for Pi to interpret in the child.
 * A batch is atomic for inheritance: even already-finished sibling results are
 * excluded while any call from the assistant message is still unresolved.
 */
function completeForkBranch(branch: PiSessionEntry[]): PiSessionEntry[] {
  const pending = new Set<string>();
  let complete = 0;
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index];
    if (entry.type === "message") {
      if (entry.message.role === "assistant") {
        for (const block of entry.message.content) if (block.type === "toolCall") pending.add(block.id);
      } else if (entry.message.role === "toolResult") {
        if (!pending.delete(entry.message.toolCallId)) break;
      }
    }
    if (pending.size === 0) complete = index + 1;
  }
  return branch.slice(0, complete);
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
  parentBranch?: PiSessionEntry[];
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  if (params.mode === "fork" && !params.parentBranch) throw new Error("Fork requires the live parent session branch");
  const contentLines = params.mode === "fork" ? completeForkBranch(params.parentBranch!).map((entry) => JSON.stringify(entry)) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}


/** Path of the loadout sidecar written next to a subagent session file. */
export function loadoutSidecarPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

/** Persist validated permissions atomically; a failed write must fail launch. */
export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  validateLoadout(loadout);
  const path = loadoutSidecarPath(sessionFile);
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(loadout), "utf8");
  renameSync(temporary, path);
}

/** Invalid, incomplete or unavailable snapshots never imply unrestricted defaults. */
export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  try {
    const p = loadoutSidecarPath(sessionFile);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return readCompatibleLoadout(parsed, fileURLToPath(new URL("./subagent-done.ts", import.meta.url)));
  } catch {
    return null;
  }
}

/**
 * Read the canonical session id from a session file's header.
 *
 * pi's `--session <id>` flag resolves against this header `id` (exact match,
 * then prefix), NOT the filename — so this is the value to hand back to the
 * orchestrator for follow-ups.
 */
/**
 * Read only the first line of a file without loading the whole thing into
 * memory. Session files grow to many MB, but the header we need is always the
 * first JSON line, so reading a small prefix keeps header lookups cheap — this
 * is what makes scanning a large session tree fast enough to avoid blocking the
 * event loop. Returns the first line (sans trailing newline), or null.
 */
function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a); // '\n'
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function getSessionId(sessionFile: string): string | null {
  return readHeaderId(sessionFile);
}

function readHeaderId(sessionFile: string): string | null {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a session id (or id prefix) to a session file path by scanning every
 * `*.jsonl` under `sessionsRoot` and matching the header `id`. Mirrors pi's own
 * resolution order: exact match first, then prefix match. Most recently
 * modified file wins on ties. Returns null when nothing matches.
 */
/**
 * In-process index of session id → session file, per sessions root.
 *
 * Resolving a session id naively walks every `.jsonl` under the sessions tree
 * and reads each header. With a few thousand sessions that is thousands of
 * synchronous open/read/stat syscalls — on the extension host's single thread
 * that blocks the entire terminal UI for many seconds (measured ~67s on a
 * 2010-file tree). To avoid that, we build the index once per root and cache
 * it; subsequent lookups are O(1). The cache is validated cheaply (a directory
 * listing plus statSync-only mtime checks) on every call, so new sessions are
 * picked up without re-reading unchanged headers and without ever freezing the
 * UI again.
 */
interface SessionIndex {
  idToFile: Map<string, { path: string; mtime: number }>;
  /** file path → mtime when indexed (staleness detection). */
  files: Map<string, number>;
  /** top-level dir signature used to detect newly added cwd dirs. */
  topSig: string;
}
const sessionIndexCache = new Map<string, SessionIndex>();

function topLevelSignature(root: string): string {
  const parts: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      let m = 0;
      try {
        m = statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      parts.push(`d:${e.name}:${m}`);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      parts.push(`f:${e.name}`);
    }
  }
  parts.sort();
  return parts.join("|");
}

/** Recursively index new/changed .jsonl files under dir into idx. */
function indexDir(dir: string, idx: SessionIndex): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      indexDir(full, idx);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const known = idx.files.get(full);
      if (known !== undefined && known === mtime) continue; // unchanged
      const id = readHeaderId(full); // only read headers for new/changed files
      idx.files.set(full, mtime);
      if (!id) continue;
      const prev = idx.idToFile.get(id);
      if (!prev || mtime >= prev.mtime) {
        idx.idToFile.set(id, { path: full, mtime });
      }
    }
  }
}

function getSessionIndex(sessionsRoot: string): SessionIndex {
  let idx = sessionIndexCache.get(sessionsRoot);
  const sig = topLevelSignature(sessionsRoot);
  if (!idx) {
    idx = { idToFile: new Map(), files: new Map(), topSig: sig };
    sessionIndexCache.set(sessionsRoot, idx);
    indexDir(sessionsRoot, idx); // first build: full scan, once per process
  } else if (idx.topSig !== sig) {
    idx.topSig = sig;
    indexDir(sessionsRoot, idx); // a cwd dir was added/changed: incremental rescan
  } else {
    indexDir(sessionsRoot, idx); // cheap: stats files, reads only new/changed headers
  }
  return idx;
}

export function resolveSessionFileById(sessionId: string, sessionsRoot: string): string | null {
  if (!sessionId || !existsSync(sessionsRoot)) return null;
  const idx = getSessionIndex(sessionsRoot);
  return lookupSessionIndex(idx, sessionId);
}

function lookupSessionIndex(
  idx: { idToFile: Map<string, { path: string; mtime: number }> },
  sessionId: string,
): string | null {
  // Exact match first.
  const exact = idx.idToFile.get(sessionId);
  if (exact && existsSync(exact.path)) return exact.path;

  // Prefix match: most recently modified wins (ids are unique in practice, so
  // this is only a convenience for hand-typed short prefixes).
  let best: { path: string; mtime: number } | null = null;
  for (const [id, rec] of idx.idToFile) {
    if (!id.startsWith(sessionId)) continue;
    if (!existsSync(rec.path)) continue;
    if (!best || rec.mtime > best.mtime) best = rec;
  }
  return best ? best.path : null;
}

/**
 * Async variant used by the interactive resume path. Index building/refresh is
 * synchronous I/O, which can take many seconds on a cold OS page cache with a
 * few thousand sessions; running it synchronously would block the extension
 * host's single thread and freeze the terminal UI. Deferring to a macrotask
 * keeps the event loop responsive. The heavy work only happens on the first
 * resolution per process (and incrementally thereafter); warm lookups are ~50ms.
 */
export async function resolveSessionFileByIdAsync(
  sessionId: string,
  sessionsRoot: string,
): Promise<string | null> {
  if (!sessionId || !existsSync(sessionsRoot)) return null;
  // Let the event loop breathe (and the UI repaint) before the sync scan.
  await new Promise<void>((r) => setImmediate(r));
  const idx = getSessionIndex(sessionsRoot);
  return lookupSessionIndex(idx, sessionId);
}

/** Test hook: drop the cached session index so tests start clean. */
export function resetSessionIndexCache(): void {
  sessionIndexCache.clear();
}

export interface SessionStats {
  model: string | null;
  provider?: string;
  /** Exact model metadata, absent when capacity is unknown. */
  contextWindow?: number;
  toolCount: number;
  /** Recorded assistant/tool/compaction/standalone usage in the chosen scope. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Last response's request occupancy, not a cumulative token total. */
  contextTokens: number;
  /** Recorded cost in USD in the chosen scope. */
  cost: number;
}

/**
 * Account for the supplied scope without applying context edits/compaction:
 * removing context does not refund usage. Callers choose generation or whole
 * session entries explicitly. Context occupancy is the latest request usage,
 * not a sum, and capacity comes only from matching model metadata.
 */
export function summarizeEntryUsage(entries: readonly PiSessionEntry[], model: { provider: string; id: string; contextWindow?: number } | undefined, source: AssistantMessage | undefined): SessionStats {
  const stats: SessionStats = {
    model: source?.model ?? model?.id ?? null,
    provider: source?.provider ?? model?.provider,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: source?.usage?.totalTokens ?? 0,
    cost: 0,
  };

  for (const entry of entries) {
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") stats.toolCount++;
    }
    const usage = message?.role === "assistant" || message?.role === "toolResult" ? message.usage
      : "usage" in entry ? entry.usage : undefined;
    if (usage) {
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      stats.inputTokens += num(usage.input);
      stats.outputTokens += num(usage.output);
      stats.cacheReadTokens += num(usage.cacheRead);
      stats.cacheWriteTokens += num(usage.cacheWrite);
      const cost = usage.cost;
      if (cost) stats.cost += num(cost.total);
    }
  }
  if (model && stats.model === model.id && stats.provider === model.provider && Number.isFinite(model.contextWindow) && model.contextWindow! > 0) {
    stats.contextWindow = model.contextWindow;
  }
  return stats;
}
