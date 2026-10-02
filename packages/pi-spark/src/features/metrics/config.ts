import * as z from "zod";

export const METRICS_DISPLAYS = ["live", "on-stop"] as const;

export type MetricsDisplay = (typeof METRICS_DISPLAYS)[number];

export const metricsConfigSchema = z.object({
  display: z.enum(METRICS_DISPLAYS).default("on-stop"),
});

export type MetricsConfig = z.infer<typeof metricsConfigSchema>;

export const DEFAULT_METRICS_DISPLAY: MetricsDisplay = "on-stop";
