import { execFileSync } from "node:child_process";
import { getMuxBackend, type MuxBackend } from "./detection.ts";
import { type RenameOperation, type RenameTarget } from "./surface.ts";
import { renameOrcaTerminal } from "./backends/orca.ts";

export const TERMINAL_RENAME_CONTEXT_ENV = "PI_TERMINAL_RENAME_CONTEXT";
const COMMAND_TIMEOUT_MS = 5_000;

export interface TerminalRenameTarget {
  backend: MuxBackend;
  operation: RenameOperation;
  target: RenameTarget;
  id: string;
  scope: "surface" | "shared";
}

/** Neither tmux nor Orca panes prove exclusive ownership of their window/tab. */
export interface SurfaceRenameContext {
  version: 1;
  backend: MuxBackend | null;
  surface: string;
  ownedTarget: null;
}

export type TerminalRenameOutcome =
  | { status: "ready" | "renamed"; reference: TerminalRenameTarget }
  | { status: "skipped"; operation: RenameOperation; reason: "unsupported" | "disabled" | "shared" | "unverified" | "missing-id"; setting?: string }
  | { status: "failed"; operation: RenameOperation; error: string };

export function createSurfaceRenameContext(surface: string, backend = getMuxBackend()): SurfaceRenameContext {
  return { version: 1, backend: surface.startsWith("headless:") ? null : backend, surface, ownedTarget: null };
}

/** Invalid ownership never falls back to unrestricted parent permissions. */
export function readSurfaceRenameContext(env: NodeJS.ProcessEnv = process.env): SurfaceRenameContext | undefined {
  const raw = env[TERMINAL_RENAME_CONTEXT_ENV];
  if (raw === undefined) {
    if (env.PI_SUBAGENT_ID || env.PI_SUBAGENT_SURFACE) {
      return { version: 1, backend: null, surface: "", ownedTarget: null };
    }
    return undefined;
  }
  const invalid = () => new Error("Invalid terminal rename ownership context; terminal names were not changed.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const context = value as Record<string, unknown>;
  if (context.version !== 1 || ![null, "tmux", "orca"].includes(context.backend as string | null) ||
      typeof context.surface !== "string" || context.ownedTarget !== null ||
      Object.keys(context).some((key) => !["version", "backend", "surface", "ownedTarget"].includes(key))) {
    throw invalid();
  }
  return context as unknown as SurfaceRenameContext;
}

export interface ResolveRenameOptions {
  tab: boolean;
  workspace: boolean;
  backend?: MuxBackend | null;
  env?: NodeJS.ProcessEnv;
}

export type RenameIdQuery = (command: string, args: string[]) => string;

function queryRenameId(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS });
}

/** Resolve explicit identities; legacy rename opt-ins do not apply here. */
export function resolveTerminalRenameTargets(options: ResolveRenameOptions, query: RenameIdQuery = queryRenameId): TerminalRenameOutcome[] {
  const env = options.env ?? process.env;
  const context = readSurfaceRenameContext(env);
  const backend = options.backend === undefined ? getMuxBackend() : options.backend;
  const outcomes: TerminalRenameOutcome[] = [];
  for (const operation of ["workspace", "tab"] as const) {
    if (!options[operation]) continue;
    if (context) {
      outcomes.push({ status: "skipped", operation, reason: operation === "workspace" ? "shared" : "unverified" });
      continue;
    }
    if (!backend || (backend === "orca" && operation === "workspace")) {
      outcomes.push({ status: "skipped", operation, reason: "unsupported" });
      continue;
    }
    try {
      const id = backend === "tmux"
        ? (env.TMUX_PANE ? query("tmux", ["display-message", "-p", "-t", env.TMUX_PANE,
          operation === "tab" ? "#{window_id}" : "#{session_id}"]).trim() : undefined)
        : env.ORCA_TERMINAL_HANDLE;
      const target: RenameTarget = backend === "orca" ? "terminal" : operation === "tab" ? "window" : "session";
      outcomes.push(id?.trim() ? { status: "ready", reference: {
        backend, operation, target, id, scope: "shared",
      } } : { status: "skipped", operation, reason: "missing-id" });
    } catch (error) {
      outcomes.push({ status: "failed", operation, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

export type RenameCommandRunner = (command: string, args: string[]) => void;

function runRenameCommand(command: string, args: string[]): void {
  execFileSync(command, args, { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS });
}

/** Execute only against the already-resolved identity, never the current focus. */
export function renameTerminalTarget(
  reference: TerminalRenameTarget,
  title: string,
  dependencies: { run: RenameCommandRunner; renameOrca: typeof renameOrcaTerminal } = { run: runRenameCommand, renameOrca: renameOrcaTerminal },
): TerminalRenameOutcome {
  const { backend, operation, id } = reference;
  try {
    if (!id.trim()) throw new Error("Cannot determine the terminal rename target ID.");
    if (backend === "tmux") {
      dependencies.run("tmux", [operation === "tab" ? "rename-window" : "rename-session", "-t", id, title]);
    } else if (!dependencies.renameOrca(id, title)) {
      throw new Error("orca did not complete terminal renaming.");
    }
    return { status: "renamed", reference };
  } catch (error) {
    return { status: "failed", operation, error: error instanceof Error ? error.message : String(error) };
  }
}
