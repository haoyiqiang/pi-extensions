import { extensionConfigPath, readJsonObjectResult } from "pi-extensions-config";
import { i18n } from "./i18n.ts";

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
    warning: i18n.t("configInvalid", { path, reason }),
  });
  if (result.status === "invalid") return invalid(result.error.message);
  if (
    Object.keys(result.value).some((key) => key !== "enabled") ||
    (result.value.enabled !== undefined && typeof result.value.enabled !== "boolean")
  ) return invalid(i18n.t("configShape"));
  return { config: { enabled: result.value.enabled === true }, path };
}
