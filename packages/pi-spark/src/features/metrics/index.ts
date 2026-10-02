import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/index.ts";
import { createElapsedTracker } from "./turn-elapsed.ts";
import { registerMetricsCommand } from "./command.ts";
import type { MetricsDisplay } from "./config.ts";
import turnElapsed from "./turn-elapsed.ts";
import tps from "./tps.ts";

function resolveDisplay(ctx: ExtensionContext): MetricsDisplay | false {
  const metrics = loadConfig(ctx).metrics;
  if (metrics === false) return false;
  return metrics.display ?? "on-stop";
}

/** Registers session elapsed time and TPS telemetry as a spark feature. */
export function registerMetrics(pi: ExtensionAPI): void {
  registerMetricsCommand(pi);
  const tracker = createElapsedTracker();
  const display = (ctx: ExtensionContext) => resolveDisplay(ctx);
  turnElapsed(pi, { tracker, display });
  tps(pi, { tracker, display });
}
