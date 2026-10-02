import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SparkConfig, SparkConfigInput } from "./schema.ts";
import { clearConfigCache } from "./index.ts";

const CONFIG_FILE = "spark.json";

/** Resolves the global spark.json path. */
export function sparkConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, CONFIG_FILE);
}

/** Resolves the project-local spark.json path. */
export function projectSparkConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
}

/** Reads one JSON object. Missing files are absent; malformed/non-object files throw. */
export function readConfigObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("configuration must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Preserving read-patch-write for one spark feature. */
export function patchConfigFeature<K extends keyof SparkConfig>(
  path: string,
  key: K,
  value: SparkConfigInput[K],
): string {
  const raw = readConfigObject(path) ?? {};
  raw[key] = value;
  writeConfigObjectAtomic(path, raw);
  clearConfigCache();
  return path;
}

/** Writes one feature into the global spark.json without dropping sibling fields. */
export function patchGlobalFeature<K extends keyof SparkConfig>(
  key: K,
  value: SparkConfigInput[K],
  agentDir = getAgentDir(),
): string {
  return patchConfigFeature(sparkConfigPath(agentDir), key, value);
}

/** True when the project file explicitly owns a feature and overrides global state. */
export function projectOverridesFeature(cwd: string, key: keyof SparkConfig): boolean {
  const parsed = readConfigObject(projectSparkConfigPath(cwd));
  return parsed !== undefined && key in parsed;
}

function writeConfigObjectAtomic(path: string, value: Record<string, unknown>): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
