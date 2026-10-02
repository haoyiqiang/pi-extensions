import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { patchGlobalFeature, projectOverridesFeature } from "../../config/store.ts";

/** Writes the resources feature into the global spark.json without dropping other fields. */
export function saveResourcesConfig(enabled: boolean, agentDir = getAgentDir()): string {
  return patchGlobalFeature("resources", enabled ? {} : false, agentDir);
}

/** True when the project spark.json explicitly sets resources and therefore overrides the global file. */
export function projectResourcesOverrides(cwd: string): boolean {
  return projectOverridesFeature(cwd, "resources");
}
