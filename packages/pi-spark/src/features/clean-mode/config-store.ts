import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearConfigCache, loadConfig as loadSparkConfig } from "../../config/index.ts";
import { normalizeConfig } from "./config.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeConfig, type ConfigLoadResult, type ConfigSaveResult } from "./types.ts";

const CONFIG_FILE = "spark.json";

/** New clean-mode settings live under cleanMode in global spark.json. */
export function configPath(agentDir = getAgentDir()): string {
  return join(agentDir, CONFIG_FILE);
}

/** Resolves the effective spark feature config for this project. */
export function loadConfig(ctx: ExtensionContext): ConfigLoadResult {
  const value = loadSparkConfig(ctx).cleanMode;
  if (value === false) {
    return { config: { ...DEFAULT_CLEAN_MODE_CONFIG, enabled: false } };
  }
  return { config: normalizeConfig(value) };
}

/** Writes cleanMode into global spark.json without dropping other spark features. */
export function saveConfig(config: CleanModeConfig, path = configPath()): ConfigSaveResult {
  try {
    const raw = readObject(path) ?? {};
    raw.cleanMode = config;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    clearConfigCache();
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readObject(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("configuration must be an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export { normalizeConfig } from "./config.ts";
