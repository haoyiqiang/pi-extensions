import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../../config/index.ts";
import { isResourcesEnabled } from "./config.ts";
import { ensureSessionResourceRuntime } from "./runtime.ts";
import { projectResourcesOverrides, saveResourcesConfig } from "./store.ts";

const COMMANDS = ["config:session-resources", "session-resources"] as const;
const ACTIONS = ["enable", "disable", "show", "hide"] as const;

function enabledFromConfig(ctx: ExtensionCommandContext): boolean {
  return isResourcesEnabled(loadConfig(ctx).resources);
}

function persist(ctx: ExtensionCommandContext, enabled: boolean): void {
  try {
    saveResourcesConfig(enabled);
    ensureSessionResourceRuntime().enabled = isResourcesEnabled(loadConfig(ctx).resources);
    const override = projectResourcesOverrides(ctx.cwd) ? ` ${"The project spark.json also sets resources and overrides this global configuration."}` : "";
    ctx.ui.notify(`${enabled ? "# session resource picker enabled" : "# session resource picker disabled"}${override}`, "info");
  } catch (error) {
    ctx.ui.notify(`Failed to save session resource configuration: ${"spark.json"} (${error instanceof Error ? error.message : String(error)}).`, "error");
  }
}

/** Registers the retired session-resources commands against spark.json. */
export function registerSessionResourcesCommand(pi: ExtensionAPI): void {
  const command = {
    description: "Manage the # session resource picker",
    getArgumentCompletions: (prefix: string) => {
      const matches = ACTIONS.filter((action) => action.startsWith(prefix));
      return matches.length > 0 ? matches.map((action) => ({ value: action, label: action })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const action = args.trim().toLowerCase();
      if (!action) {
        ctx.ui.notify(enabledFromConfig(ctx) ? "Type # in the editor and continue typing to filter session resources; Left/Right or Tab/Shift+Tab switch types, Up/Down selects, and Enter inserts the reference" : "The # session resource picker is disabled; use /config:session-resources enable to enable it", "info");
        return;
      }
      if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
        ctx.ui.notify("Usage: /config:session-resources [enable|disable]", "warning");
        return;
      }
      persist(ctx, action === "enable" || action === "show");
    },
  };
  for (const name of COMMANDS) pi.registerCommand(name, command);
}
