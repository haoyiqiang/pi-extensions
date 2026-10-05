import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../features/naming/config.ts";
import type { NamingConfig } from "../features/naming/config.ts";
import { loadConfig } from "./index.ts";
import { patchConfigFeature, projectOverridesFeature, projectSparkConfigPath, sparkConfigPath } from "./store.ts";

/** A project's explicit naming value (including false) owns menu edits and resets. */
export function namingConfigPath(ctx: ExtensionContext): string {
  return projectOverridesFeature(ctx.cwd, "naming") ? projectSparkConfigPath(ctx.cwd) : sparkConfigPath();
}

export function loadNamingConfig(ctx: ExtensionContext): NamingConfig | false {
  return loadConfig(ctx).naming;
}

/** Persist validated settings through Spark's preserving store, never through the legacy file. */
export function saveNamingConfig(config: NamingConfig, ctx: ExtensionContext): string {
  const validated = parseConfig(config);
  return patchConfigFeature(namingConfigPath(ctx), "naming", validated);
}
