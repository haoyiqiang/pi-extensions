import * as z from "zod";

/** `false` remains the normal spark switch; enabled also accepts the retired config shape. */
export const resourcesConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

export type ResourcesConfig = z.infer<typeof resourcesConfigSchema>;

export function isResourcesEnabled(config: ResourcesConfig | { enabled?: boolean } | false): boolean {
  return config !== false && config.enabled !== false;
}
