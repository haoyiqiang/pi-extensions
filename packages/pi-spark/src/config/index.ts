import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { defu } from "defu";

import { readLegacyCleanModeConfig } from "./legacy-clean-mode";
import { readLegacyMetricsConfig } from "./legacy-metrics";
import { readLegacySessionResourcesConfig } from "./legacy-resources";
import { featureSchemas } from "./schema";
import { i18n, NOTICE_SOURCE } from "../i18n";
import { notifyWithSource } from "pi-extensions-i18n";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SparkConfig } from "./schema";

const CONFIG_FILE = "spark.json";

const cache = new Map<string, SparkConfig>();

/** Drops the cached spark.json result so the next load sees a freshly saved file. */
export function clearConfigCache(): void {
  cache.clear();
}

/** Loads and validates spark.json once per session lifecycle; later calls return the cached result. */
export function loadConfig(ctx: ExtensionContext): SparkConfig {
  const cached = cache.get(ctx.cwd);
  if (cached) return cached;

  // Deep-merge the global file under the project file, so project settings win at scalar
  // leaves while deep objects (e.g., `recap.model`) combine across both.
  const [globalPath, projectPath] = getConfigPaths(ctx.cwd, CONFIG_FILE);
  const raw = defu(readJson(projectPath) ?? {}, readJson(globalPath) ?? {});
  const errors: string[] = [];
  if (raw.cleanMode === undefined) {
    const legacy = readLegacyCleanModeConfig();
    if (legacy.error) errors.push(legacy.error);
    else if (legacy.value !== undefined) raw.cleanMode = legacy.value;
  }
  if (raw.metrics === undefined) {
    const legacy = readLegacyMetricsConfig();
    if (legacy.error) errors.push(legacy.error);
    else if (legacy.value !== undefined) raw.metrics = legacy.value;
  }
  if (raw.resources === undefined) {
    const legacy = readLegacySessionResourcesConfig();
    if (legacy.error) errors.push(legacy.error);
    else if (legacy.value === false) raw.resources = false;
  }

  // Validate each feature independently so a single invalid field disables only that feature
  // (falling back to its enabled defaults) instead of taking down the whole config.
  const config = {} as Record<keyof SparkConfig, unknown>;

  for (const field of Object.keys(featureSchemas) as (keyof SparkConfig)[]) {
    const value = raw[field];

    if (value === undefined) {
      config[field] = {};
      continue;
    }

    if (value === false) {
      config[field] = false;
      continue;
    }

    const result = featureSchemas[field].safeParse(value);
    if (result.success) {
      config[field] = result.data;
      continue;
    }

    config[field] = {};
    errors.push(result.error.issues.map((issue) => `${[field, ...issue.path].join(".")}: ${issue.message}`).join("; "));
  }

  if (errors.length > 0) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "error", message: i18n.t("invalidConfig", { errors: errors.join("; ") }) });
  }

  cache.set(ctx.cwd, config as SparkConfig);
  return config as SparkConfig;
}

function getConfigPaths(cwd: string, fileName: string): [globalPath: string, projectPath: string] {
  return [join(getAgentDir(), fileName), join(cwd, CONFIG_DIR_NAME, fileName)];
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
