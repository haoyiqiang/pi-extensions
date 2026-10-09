import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notifyWithSource } from "pi-utils";
import { loadConfig } from "../../config/index.ts";
import { NOTICE_SOURCE } from "../../i18n.ts";
import { isResourcesEnabled } from "./config.ts";
import { i18n } from "./i18n.ts";
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
    const override = projectResourcesOverrides(ctx.cwd) ? ` ${i18n.t("resourcesProjectOverride")}` : "";
    notifyWithSource({
      ctx,
      source: NOTICE_SOURCE,
      level: "info",
      message: `${i18n.t(enabled ? "enabled" : "disabled")}${override}`,
    });
  } catch (error) {
    notifyWithSource({
      ctx,
      source: NOTICE_SOURCE,
      level: "error",
      message: i18n.t("configSaveFailed", {
        path: "spark.json",
        error: error instanceof Error ? error.message : String(error),
      }),
    });
  }
}

/** Registers the retired session-resources commands against spark.json. */
export function registerSessionResourcesCommand(pi: ExtensionAPI): void {
  const command = {
    description: i18n.t("commandDescription"),
    getArgumentCompletions: (prefix: string) => {
      const matches = ACTIONS.filter((action) => action.startsWith(prefix));
      return matches.length > 0 ? matches.map((action) => ({ value: action, label: action })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const action = args.trim().toLowerCase();
      if (!action) {
        notifyWithSource({
          ctx,
          source: NOTICE_SOURCE,
          level: "info",
          message: i18n.t(enabledFromConfig(ctx) ? "referenceHint" : "referenceDisabledHint"),
        });
        return;
      }
      if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("commandUsage") });
        return;
      }
      persist(ctx, action === "enable" || action === "show");
    },
  };
  for (const name of COMMANDS) pi.registerCommand(name, command);
}
