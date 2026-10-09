import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notifyWithSource } from "pi-utils";
import { loadConfig } from "../../config/index.ts";
import { i18n, NOTICE_SOURCE } from "../../i18n.ts";
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
      ? ` ${i18n.t("metricsProjectOverride")}`
      : "";
    notifyWithSource({
      ctx,
      source: NOTICE_SOURCE,
      level: "info",
      message: `${i18n.t("metricsConfigSaved", { path })}${override}`,
    });
    return true;
  } catch (error) {
    notifyWithSource({
      ctx,
      source: NOTICE_SOURCE,
      level: "error",
      message: i18n.t("metricsConfigInvalid", {
        error: error instanceof Error ? error.message : String(error),
      }),
    });
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
  const enabledChoice = i18n.t("metricsConfigEnabled", { value: i18n.t(enabled ? "metricsConfigOn" : "metricsConfigOff") });
  const displayChoice = i18n.t("metricsConfigDisplay", {
    value: i18n.t(display === "on-stop" ? "metricsConfigDisplayOnStop" : "metricsConfigDisplayLive"),
  });
  const doneChoice = i18n.t("metricsConfigDone");
  const selected = await ctx.ui.select(i18n.t("metricsConfigMenuTitle"), [enabledChoice, displayChoice, doneChoice]);
  if (selected === undefined || selected === doneChoice) return null;
  if (selected === enabledChoice) return enabled ? false : { display };
  return { display: DISPLAY_FLIP[display] };
}

/** Registers the retired pi-metrics command names against spark.json. */
export function registerMetricsCommand(pi: ExtensionAPI): void {
  const command = {
    description: i18n.t("metricsConfigCommandDescription"),
    getArgumentCompletions: () => ["reset", "enable", "disable", "live", "on-stop"].map((value) => ({ value, label: value })),
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const value = args.trim();
      if (value) {
        const patch = patchFor(value, currentStored(ctx));
        if (patch === undefined) {
          notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("metricsConfigUsage") });
          return;
        }
        persist(ctx, patch);
        return;
      }
      if (!ctx.hasUI) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("metricsConfigInteractiveOnly") });
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
