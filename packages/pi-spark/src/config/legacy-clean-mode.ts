import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeConfig } from "../features/clean-mode/config.ts";
import type { CleanModeConfig } from "../features/clean-mode/types.ts";

const LEGACY_CONFIG = join("extensions", "pi-clean-mode", "config.json");

/** Reads the retired standalone clean-mode config without modifying it. */
export function readLegacyCleanModeConfig(agentDir = getAgentDir()): { value?: CleanModeConfig; error?: string } {
  const path = join(agentDir, LEGACY_CONFIG);
  try {
    return { value: normalizeConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
