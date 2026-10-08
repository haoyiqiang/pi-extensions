import { i18n } from "./i18n.js";
import type { AgentConfig, ExtensionRule, ResolvedExtensionRule } from "./types.js";
import type { SubagentsConfig } from "./settings.js";

/** Captured defaults without imposing a full runtime policy on legacy callers. */
export interface ExtensionDefaultsSnapshot {
  readonly configCwd: string;
  readonly projectTrusted: boolean;
  readonly settings: Readonly<SubagentsConfig>;
}

const ownedDefaults = new WeakSet<object>();

export function isExtensionDefaultsSnapshot(value: unknown): value is ExtensionDefaultsSnapshot {
  return value !== null && typeof value === "object" && ownedDefaults.has(value);
}

export function snapshotExtensionDefaults(
  configCwd: string,
  projectTrusted: boolean,
  settings: Readonly<SubagentsConfig>,
): ExtensionDefaultsSnapshot {
  const defaultExtensions = parseExtensionRule(settings.defaultExtensions, configCwd);
  const snapshot = Object.freeze({
    configCwd,
    projectTrusted,
    settings: Object.freeze({
      ...settings,
      ...(defaultExtensions !== undefined ? {
        defaultExtensions: snapshotExtensionRule(defaultExtensions) as ExtensionRule,
      } : {}),
    }),
  });
  ownedDefaults.add(snapshot);
  return snapshot;
}

/** Policy errors must escape warn-and-skip and saved-record recovery boundaries. */
export class ExtensionPolicyError extends Error {
  constructor(key: "extensionDefaults.invalidRule" | "extensionDefaults.legacyField", path: string) {
    const message = i18n.t(key, { path });
    super(message.includes(path) ? message : `${message}: ${path}`);
    this.name = "ExtensionPolicyError";
  }
}

/** Reject the retired spelling even when extensions is also present. */
export function assertNoLegacyExtensions(value: unknown, path: string): void {
  if (value && typeof value === "object" && Object.hasOwn(value, "inherit_extensions")) {
    throw new ExtensionPolicyError("extensionDefaults.legacyField", path);
  }
}

/** JSON/host rules are strict; only agent frontmatter accepts the historical CSV spelling. */
export function parseExtensionRule(
  value: unknown,
  path: string,
  options: { allowCsv?: boolean } = {},
): ExtensionRule | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return [...value];
  }
  if (options.allowCsv && typeof value === "string") {
    const text = value.trim();
    if (!text || text === "none") return false;
    const entries = text.split(",").map((entry) => entry.trim());
    if (entries.every(Boolean)) return entries;
  }
  throw new ExtensionPolicyError("extensionDefaults.invalidRule", path);
}

export function snapshotExtensionRule(value: ResolvedExtensionRule): ResolvedExtensionRule {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}

export function assertAgentExtensionPolicy(agent: AgentConfig | undefined, path?: string): void {
  if (!agent) return;
  const origin = path ?? agent.sourcePath ?? `agent:${agent.name}`;
  assertNoLegacyExtensions(agent, origin);
  parseExtensionRule(agent.extensions, origin);
}

/** No I/O: callers supply the already trusted, invocation-owned default. */
export function resolveExtensions(options: {
  agent?: AgentConfig;
  defaultExtensions?: ResolvedExtensionRule;
  resolvedExtensions?: ResolvedExtensionRule;
  isolated?: boolean;
}): ResolvedExtensionRule {
  assertAgentExtensionPolicy(options.agent);
  const path = options.agent?.sourcePath ?? `agent:${options.agent?.name ?? "unknown"}`;
  // Validate before isolation, so malformed policy never disappears behind a veto.
  const resolved = parseExtensionRule(options.resolvedExtensions, path);
  const defaults = parseExtensionRule(options.defaultExtensions, path);
  if (options.isolated || options.agent?.enabled === false) return false;
  // Definitions remain authoritative even for a direct caller that forges the
  // internal selection field. Admission overwrites that field unconditionally.
  return snapshotExtensionRule(options.agent?.extensions ?? resolved ?? defaults ?? true);
}

/** Old saved sessions use their saved definition, never a current settings default. */
export function resolveSavedExtensions(policy: {
  agent: AgentConfig;
  resolvedExtensions?: ResolvedExtensionRule;
  isolated: boolean;
}): ResolvedExtensionRule {
  assertAgentExtensionPolicy(policy.agent);
  const resolved = parseExtensionRule(policy.resolvedExtensions, policy.agent.sourcePath ?? `agent:${policy.agent.name}`);
  if (policy.isolated || policy.agent.enabled === false) return false;
  return snapshotExtensionRule(resolved ?? policy.agent.extensions ?? true);
}

export function ordinaryExtensionsDisabled(rule: ResolvedExtensionRule): boolean {
  return rule === false || (Array.isArray(rule) && rule.length === 0);
}

/** Snapshot only policy-bearing arrays; never freeze or mutate a host's definition. */
export function snapshotAgentExtensionPolicy(agent: AgentConfig): AgentConfig {
  assertAgentExtensionPolicy(agent);
  const copy = { ...agent };
  if (Array.isArray(agent.extensions)) copy.extensions = Object.freeze([...agent.extensions]) as unknown as string[];
  if (agent.excludeExtensions) copy.excludeExtensions = Object.freeze([...agent.excludeExtensions]) as unknown as string[];
  if (agent.extSelectors) copy.extSelectors = Object.freeze([...agent.extSelectors]) as unknown as string[];
  return Object.freeze(copy);
}

export { type ExtensionRule, type ResolvedExtensionRule } from "./types.js";
