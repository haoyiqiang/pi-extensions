import { extensionConfigPath, readJsonObjectResult } from "pi-utils";

export interface ActionFusionConfig {
  enabled: boolean;
}

export function loadActionFusionConfig(path = extensionConfigPath("pi-action-fusion")): {
  config: ActionFusionConfig;
  path: string;
  warning?: string;
} {
  const result = readJsonObjectResult(path);
  if (result.status === "missing") return { config: { enabled: false }, path };
  const invalid = (reason: string) => ({
    config: { enabled: false },
    path,
    warning: `Invalid Action Fusion configuration; the feature stays disabled. Repair the file before changing this setting.
${path}
${reason}`,
  });
  if (result.status === "invalid") return invalid(result.error.message);
  if (
    Object.keys(result.value).some((key) => key !== "enabled") ||
    (result.value.enabled !== undefined && typeof result.value.enabled !== "boolean")
  ) return invalid("Only the optional boolean field enabled is supported.");
  return { config: { enabled: result.value.enabled === true }, path };
}
