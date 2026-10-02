import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LEGACY_CONFIG = join("extensions", "pi-metrics", "config.json");

export interface LegacyMetricsConfig {
  enabled: boolean;
  display: "live" | "on-stop";
}

/** Reads the retired pi-metrics config. Missing file returns undefined. */
export function readLegacyMetricsConfig(agentDir = getAgentDir()): { value?: false | { display: "live" | "on-stop" }; error?: string } {
  const path = join(agentDir, LEGACY_CONFIG);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${path}: configuration must be an object` };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    return { error: `${path}: enabled must be a boolean` };
  }
  if (raw.display !== undefined && raw.display !== "live" && raw.display !== "on-stop") {
    return { error: `${path}: display must be live or on-stop` };
  }
  if (raw.enabled === false) return { value: false };
  return { value: { display: raw.display === "live" ? "live" : "on-stop" } };
}
