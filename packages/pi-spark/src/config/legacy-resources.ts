import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LEGACY_CONFIG = join("extensions", "pi-session-resources", "config.json");

/** Reads the retired session-resources config. Only an explicit disable is migrated. */
export function readLegacySessionResourcesConfig(agentDir = getAgentDir()): { value?: false; error?: string } {
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
  for (const key of Object.keys(raw)) {
    if (key !== "enabled") return { error: `${path}: unknown configuration field: ${key}` };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    return { error: `${path}: enabled must be a boolean` };
  }
  return raw.enabled === false ? { value: false } : {};
}
