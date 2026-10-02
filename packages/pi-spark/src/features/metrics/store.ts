import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { patchGlobalFeature, projectOverridesFeature } from "../../config/store.ts";
import type { MetricsDisplay } from "./config.ts";

export type StoredMetricsConfig = false | { display: MetricsDisplay };

/** Writes the metrics feature into the global spark.json without dropping other fields. */
export function saveMetricsConfig(value: StoredMetricsConfig, agentDir = getAgentDir()): string {
  return patchGlobalFeature("metrics", value, agentDir);
}

/** True when the project spark.json explicitly sets metrics and therefore overrides the global file. */
export function projectMetricsOverrides(cwd: string): boolean {
  return projectOverridesFeature(cwd, "metrics");
}
