import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readJsonObject, updateJsonObjectAtomic } from "pi-utils";
import { join } from "node:path";
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
  return readJsonObject(path);
}

/** Preserving read-patch-write for one spark feature. */
export function patchConfigFeature<K extends keyof SparkConfig>(
  path: string,
  key: K,
  value: SparkConfigInput[K],
): string {
  updateJsonObjectAtomic(path, (raw) => {
    raw[key] = value;
  });
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
