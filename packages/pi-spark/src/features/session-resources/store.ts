import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearConfigCache } from "../../config/index.ts";

const CONFIG_FILE = "spark.json";

/** Writes the resources feature into the global spark.json without dropping other fields. */
export function saveResourcesConfig(enabled: boolean, agentDir = getAgentDir()): string {
  const path = join(agentDir, CONFIG_FILE);
  const raw = readObject(path) ?? {};
  raw.resources = enabled ? {} : false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  clearConfigCache();
  return path;
}

/** True when the project spark.json explicitly sets resources and therefore overrides the global file. */
export function projectResourcesOverrides(cwd: string): boolean {
  const parsed = readObject(join(cwd, CONFIG_DIR_NAME, CONFIG_FILE));
  return parsed !== undefined && "resources" in parsed;
}

function readObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("configuration must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
