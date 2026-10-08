import { updateJsonObjectAtomic } from "pi-extensions-config";
import { i18n } from "../i18n.js";
import { getSubagentsConfigPaths, loadDefaultExtensions } from "../settings.js";
import type { AgentConfig } from "../types.js";

export type ExtensionRule = boolean | string[];
export interface DefaultExtensionPolicy {
  value: ExtensionRule;
  source: "project" | "global" | "fallback";
  path?: string;
}

/** Effective policy and field provenance, not the extensions loaded by a session. */
export function readDefaultExtensionPolicy(cwd: string, projectTrusted: boolean): DefaultExtensionPolicy {
  const selection = loadDefaultExtensions(cwd, { projectTrusted });
  return {
    value: selection.value ?? true,
    source: selection.source === "unset" ? "fallback" : selection.source,
    ...(selection.path ? { path: selection.path } : {}),
  };
}

export function describeExtensionRule(value: ExtensionRule): string {
  return value === true ? i18n.t("extensionDefaults.all")
    : value === false || value.length === 0 ? i18n.t("extensionDefaults.none")
    : i18n.t("extensionDefaults.specifiedValue", { count: value.length, names: value.join(", ") });
}

export function describeExtensionSource(policy: DefaultExtensionPolicy): string {
  return policy.source === "fallback" ? i18n.t("extensionDefaults.fallback")
    : i18n.t("extensionDefaults.source", {
      scope: i18n.t(policy.source === "project" ? "extensionDefaults.project" : "extensionDefaults.global"),
      path: policy.path!,
    });
}

export function describeAgentExtensionPolicy(cfg: AgentConfig, defaults: DefaultExtensionPolicy): string {
  const value = cfg.isolated === true ? false : cfg.extensions ?? defaults.value;
  const source = cfg.isolated === true ? i18n.t("extensionDefaults.isolated")
    : cfg.extensions !== undefined ? i18n.t("extensionDefaults.agentOverride", {
      path: cfg.sourcePath ?? i18n.t("extensionDefaults.programmatic"),
    }) : describeExtensionSource(defaults);
  const exclusions = cfg.excludeExtensions?.length
    ? i18n.t("extensionDefaults.exclusions", { names: cfg.excludeExtensions.join(", ") }) : "";
  return i18n.t("extensionDefaults.detail", { policy: describeExtensionRule(value), source, exclusions });
}

/** Only the project key is owned here. Reset reveals global policy without pinning it.
 * The trust callback must be evaluated immediately before the atomic mutation.
 * On rejection/failure there is no in-memory change or settings broadcast.
 */
export function saveProjectExtensionPolicy(
  cwd: string,
  value: ExtensionRule | undefined,
  canWriteProject: () => boolean,
): boolean {
  if (!canWriteProject()) return false;
  updateJsonObjectAtomic(getSubagentsConfigPaths(cwd).project, current => {
    const next = { ...current };
    if (value === undefined) delete next.defaultExtensions;
    else next.defaultExtensions = value;
    return next;
  });
  return true;
}
