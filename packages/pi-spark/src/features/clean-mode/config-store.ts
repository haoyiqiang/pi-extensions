import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { patchConfigFeature, sparkConfigPath } from "../../config/store.ts";
import { loadConfig as loadSparkConfig } from "../../config/index.ts";
import { normalizeConfig } from "./config.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeConfig, type ConfigLoadResult, type ConfigSaveResult } from "./types.ts";

/** New clean-mode settings live under cleanMode in global spark.json. */
export function configPath(agentDir = getAgentDir()): string {
  return sparkConfigPath(agentDir);
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
    patchConfigFeature(path, "cleanMode", config);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export { normalizeConfig } from "./config.ts";
