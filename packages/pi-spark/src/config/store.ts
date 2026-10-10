import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { extensionConfigPath, readJsonObject, updateJsonObjectAtomic } from "pi-utils";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SparkConfig, SparkConfigInput } from "./schema.ts";
import { clearConfigCache } from "./index.ts";

const PACKAGE_NAME = "pi-spark";
const CONFIG_FILE = "config.json";
const LEGACY_FILE = "spark.json";

/** Resolves the global Spark config path. */
export function sparkConfigPath(agentDir = getAgentDir()): string {
  return extensionConfigPath(PACKAGE_NAME, CONFIG_FILE, agentDir);
}

/** Resolves the retired global spark.json path. Read only when the new file is absent. */
export function legacySparkConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, LEGACY_FILE);
}

/** Resolves the project-local Spark config path. */
export function projectSparkConfigPath(cwd: string): string {
  return extensionConfigPath(PACKAGE_NAME, CONFIG_FILE, join(cwd, CONFIG_DIR_NAME));
}

/** Resolves the retired project spark.json path. Read only when the new file is absent. */
export function legacyProjectSparkConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, LEGACY_FILE);
}

/** Prefers the extension config file and falls back to a retired spark.json. */
export function readableSparkConfigPath(primary: string, legacy: string): string {
  return existsSync(primary) || !existsSync(legacy) ? primary : legacy;
}

/** Reads one JSON object. Missing files are absent; malformed/non-object files throw. */
export function readConfigObject(path: string): Record<string, unknown> | undefined {
  return readJsonObject(path);
}

function copyLegacySparkConfig(path: string): void {
  const legacy = join(dirname(dirname(dirname(path))), LEGACY_FILE);
  if (existsSync(path) || !existsSync(legacy)) return;
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(legacy, path);
}

/** Preserving read-patch-write for one spark feature. */
export function patchConfigFeature<K extends keyof SparkConfig>(
  path: string,
  key: K,
  value: SparkConfigInput[K],
): string {
  copyLegacySparkConfig(path);
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
  const parsed = readConfigObject(readableSparkConfigPath(projectSparkConfigPath(cwd), legacyProjectSparkConfigPath(cwd)));
  return parsed !== undefined && key in parsed;
}
