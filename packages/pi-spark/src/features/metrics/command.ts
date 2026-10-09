import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../../config/index.ts";
import { DEFAULT_METRICS_DISPLAY, type MetricsDisplay } from "./config.ts";
import { projectMetricsOverrides, saveMetricsConfig, type StoredMetricsConfig } from "./store.ts";

const COMMANDS = ["config:metrics", "metrics-config", "pi-metrics-config"] as const;
const DISPLAY_FLIP: Record<MetricsDisplay, MetricsDisplay> = {
  live: "on-stop",
  "on-stop": "live",
};

function currentStored(ctx: ExtensionCommandContext): StoredMetricsConfig {
  const metrics = loadConfig(ctx).metrics;
  return metrics === false ? false : { display: metrics.display ?? DEFAULT_METRICS_DISPLAY };
}

function persist(ctx: ExtensionCommandContext, value: StoredMetricsConfig): boolean {
  try {
    const path = saveMetricsConfig(value);
    const override = projectMetricsOverrides(ctx.cwd)
      ? ` ${"The project spark.json also sets metrics and overrides this global configuration."}`
      : "";
    ctx.ui.notify(`${`Metrics configuration saved to ${path}. It applies on the next run.`}${override}`, "info");
    return true;
  } catch (error) {
    ctx.ui.notify(`Invalid metrics configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
    return false;
  }
}

function patchFor(value: string, current: StoredMetricsConfig): StoredMetricsConfig | undefined {
  if (value === "reset") return { display: DEFAULT_METRICS_DISPLAY };
  if (value === "enable") return { display: current === false ? DEFAULT_METRICS_DISPLAY : current.display };
  if (value === "disable") return false;
  if (value === "live" || value === "on-stop") return { display: value };
  return undefined;
}

async function prompt(ctx: ExtensionCommandContext, current: StoredMetricsConfig): Promise<StoredMetricsConfig | null> {
  const enabled = current !== false;
  const display = current === false ? DEFAULT_METRICS_DISPLAY : current.display;
  const enabledChoice = `Metrics enabled: ${enabled ? "on" : "off"}`;
  const displayChoice = `Display: ${display === "on-stop" ? "one summary line when stopped" : "one line per turn"}`;
  const doneChoice = "Done";
  const selected = await ctx.ui.select("Metrics settings", [enabledChoice, displayChoice, doneChoice]);
  if (selected === undefined || selected === doneChoice) return null;
  if (selected === enabledChoice) return enabled ? false : { display };
  return { display: DISPLAY_FLIP[display] };
}

/** Registers the retired pi-metrics command names against spark.json. */
export function registerMetricsCommand(pi: ExtensionAPI): void {
  const command = {
    description: "Configure session metrics display",
    getArgumentCompletions: () => ["reset", "enable", "disable", "live", "on-stop"].map((value) => ({ value, label: value })),
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const value = args.trim();
      if (value) {
        const patch = patchFor(value, currentStored(ctx));
        if (patch === undefined) {
          ctx.ui.notify("Usage: /config:metrics (open settings), enable, disable, live, on-stop, or reset", "warning");
          return;
        }
        persist(ctx, patch);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Metrics configuration requires the TUI; run this command in an interactive Pi session.", "warning");
        return;
      }
      let current = currentStored(ctx);
      for (;;) {
        const next = await prompt(ctx, current);
        if (next === null) return;
        if (persist(ctx, next)) current = next;
      }
    },
  };
  for (const name of COMMANDS) pi.registerCommand(name, command);
}
