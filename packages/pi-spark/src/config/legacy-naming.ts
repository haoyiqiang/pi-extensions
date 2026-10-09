import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { extensionConfigPath, readJsonObject } from "pi-utils";
import { parseConfig } from "../features/naming/config.ts";
import type { NamingConfig } from "../features/naming/config.ts";

/** Read-only migration; canonical naming settings always take precedence. */
export function readLegacyNamingConfig(agentDir = getAgentDir()): { value?: NamingConfig; error?: string } {
  const path = extensionConfigPath("pi-naming", "config.json", agentDir);
  try {
    const raw = readJsonObject(path);
    return raw === undefined ? {} : { value: parseConfig(raw) };
  } catch (error) {
    return { error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
