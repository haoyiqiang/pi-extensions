import * as z from "zod";

import { cleanModeConfigSchema } from "../features/clean-mode/config";
import { creditsConfigSchema } from "../features/credits/config";
import { editorConfigSchema } from "../features/editor/config";
import { footerConfigSchema } from "../features/footer/config";
import { metricsConfigSchema } from "../features/metrics/config";
import { presetsConfigSchema } from "../features/presets/config";
import { recapConfigSchema } from "../features/recap/config";
import { resourcesConfigSchema } from "../features/session-resources/config";

/**
 * Raw option shape for each feature. The enable/disable/default policy lives in `loadConfig`:
 * an omitted field falls back to `{}` (enabled with defaults), `false` disables the feature, and
 * any other value is validated against the feature schema.
 */
export const featureSchemas = {
  cleanMode: cleanModeConfigSchema,
  credits: creditsConfigSchema,
  editor: editorConfigSchema,
  footer: footerConfigSchema,
  metrics: metricsConfigSchema,
  presets: presetsConfigSchema,
  recap: recapConfigSchema,
  resources: resourcesConfigSchema,
} as const;

/** Raw values accepted in spark.json; schema defaults have not been applied yet. */
export type SparkConfigInput = {
  [K in keyof typeof featureSchemas]: z.input<(typeof featureSchemas)[K]> | false;
};

/** Resolved config for every feature; `false` means the feature is disabled. */
export type SparkConfig = {
  [K in keyof typeof featureSchemas]: z.infer<(typeof featureSchemas)[K]> | false;
};
