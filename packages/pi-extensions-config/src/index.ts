import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type JsonObject = Record<string, unknown>;

export type JsonObjectReadResult =
  | { status: "missing" }
  | { status: "loaded"; value: JsonObject }
  | { status: "invalid"; error: Error };

export interface WriteJsonOptions {
  mode?: number;
}

const DEFAULT_CONFIG_MODE = 0o600;

/** Resolves Pi's agent directory with portable PI_CODING_AGENT_DIR tilde handling. */
export function resolveAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homeDirectory, ".pi", "agent");
  if (configured === "~") return homeDirectory;
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return join(homeDirectory, configured.slice(2));
  }
  return configured;
}

/** Resolves a path directly under the Pi agent directory. */
export function agentConfigPath(
  ...segments: string[]
): string {
  return join(resolveAgentDir(), ...segments);
}

/** Resolves the conventional extension config path. */
export function extensionConfigPath(
  packageName: string,
  fileName = "config.json",
  agentDir = resolveAgentDir(),
): string {
  return join(agentDir, "extensions", packageName, fileName);
}

/** Reads a JSON object. Missing files return undefined; invalid content throws. */
export function readJsonObject(path: string): JsonObject | undefined {
  const result = readJsonObjectResult(path);
  if (result.status === "missing") return undefined;
  if (result.status === "invalid") throw result.error;
  return result.value;
}

/** Reads a JSON object without throwing, preserving missing vs invalid diagnostics. */
export function readJsonObjectResult(path: string): JsonObjectReadResult {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "invalid", error: new Error("configuration must be a JSON object") };
    }
    return { status: "loaded", value: parsed as JsonObject };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** Atomically writes formatted JSON and applies owner-only permissions best-effort. */
export function writeJsonAtomic(
  path: string,
  value: unknown,
  options: WriteJsonOptions = {},
): string {
  const directory = dirname(path);
  const mode = options.mode ?? DEFAULT_CONFIG_MODE;
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
    renameSync(temporaryPath, path);
    try {
      chmodSync(path, mode);
    } catch {
      // Some filesystems do not expose portable chmod semantics.
    }
    return path;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/** Boolean save wrapper for user-facing commands that must not claim a failed save. */
export function tryWriteJsonAtomic(
  path: string,
  value: unknown,
  options: WriteJsonOptions = {},
): boolean {
  try {
    writeJsonAtomic(path, value, options);
    return true;
  } catch {
    return false;
  }
}

/** Preserving read-modify-write for one JSON object. */
export function updateJsonObjectAtomic(
  path: string,
  update: (current: JsonObject) => JsonObject | void,
  options: WriteJsonOptions = {},
): JsonObject {
  const current = { ...(readJsonObject(path) ?? {}) };
  const replacement = update(current);
  const next = replacement ?? current;
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    throw new Error("configuration update must return a JSON object");
  }
  writeJsonAtomic(path, next, options);
  return next;
}
