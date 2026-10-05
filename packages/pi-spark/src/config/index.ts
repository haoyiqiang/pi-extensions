import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { defu } from "defu";
import { readJsonObjectResult } from "pi-extensions-config";

import { readLegacyCleanModeConfig } from "./legacy-clean-mode";
import { readLegacyMetricsConfig } from "./legacy-metrics";
import { readLegacyNamingConfig } from "./legacy-naming";
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
  const global = readJsonObjectResult(globalPath);
  const project = readJsonObjectResult(projectPath);
  const globalRaw = global.status === "loaded" ? global.value : {};
  const projectRaw = project.status === "loaded" ? project.value : {};
  const raw = defu(projectRaw, globalRaw);
  const errors: string[] = [];
  const namingErrors: string[] = [];
  for (const [path, result] of [[globalPath, global], [projectPath, project]] as const) {
    if (result.status === "invalid") namingErrors.push(`${path}: ${result.error.message}`);
  }
  // Unlike defu, preserve null/invalid naming values so they fail validation, not enable defaults.
  raw.naming = mergeNaming(globalRaw.naming, projectRaw.naming);
  if (namingErrors.length === 0 && !Object.hasOwn(globalRaw, "naming") && !Object.hasOwn(projectRaw, "naming")) {
    const legacy = readLegacyNamingConfig();
    if (legacy.error) namingErrors.push(legacy.error);
    else raw.naming = legacy.value ?? {};
  }
  if (namingErrors.length > 0) {
    raw.naming = false;
    errors.push(i18n.t("naming.namingConfigFailed", { error: namingErrors.join("; ") }));
  }
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

  // Validate independently. Naming fails closed; other features retain their default fallback.
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

    config[field] = field === "naming" ? false : {};
    const error = result.error.issues.map((issue) => `${[field, ...issue.path].join(".")}: ${issue.message}`).join("; ");
    errors.push(field === "naming" ? i18n.t("naming.namingConfigFailed", { error }) : error);
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

/** Merge only known nested naming sections; never coerce invalid scalars or concatenate arrays. */
function mergeNaming(global: unknown, project: unknown): unknown {
  if (!isObject(global) || !isObject(project)) return project === undefined ? global : project;
  const merged = { ...global, ...project };
  for (const key of ["targets", "title"] as const) {
    if (isObject(global[key]) && isObject(project[key])) merged[key] = { ...global[key], ...project[key] };
  }
  return merged;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
