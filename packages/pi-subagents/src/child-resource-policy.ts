import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Extension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAgentConfigIn, isDefaultsDisabled } from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { assertAgentExtensionPolicy } from "./extension-defaults.js";
import { loadSettings, type SubagentsConfig } from "./settings.js";
import type { AgentConfig, SubagentType } from "./types.js";

const AMBIENT_OBSERVER_MANIFEST_FLAG = "ambientObserver";
const manifestFlagCache = new Map<string, boolean>();

function extensionIdentity(extension: Extension): string {
  return [extension.path, extension.resolvedPath, extension.sourceInfo?.source]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .replaceAll("\\", "/")
    .toLowerCase();
}

function findPackageJson(startPath: string): string | undefined {
  let directory = dirname(startPath);
  for (let depth = 0; depth < 32; depth++) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

function readsPiManifestFlag(path: string | undefined, flag: string): boolean {
  if (!path || path.startsWith("<")) return false;
  const key = `${path}::${flag}`;
  const cached = manifestFlagCache.get(key);
  if (cached !== undefined) return cached;
  let enabled = false;
  try {
    const packageJson = findPackageJson(path);
    if (packageJson) {
      const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { pi?: Record<string, unknown> };
      enabled = manifest.pi?.[flag] === true;
    }
  } catch {
    enabled = false;
  }
  manifestFlagCache.set(key, enabled);
  return enabled;
}

/**
 * Root orchestration/UI products and declared ambient observers must not bind to
 * an ordinary child session. Tool/provider extensions remain eligible and are
 * narrowed separately by the agent definition.
 */
export function isOrdinaryChildProduct(extension: Extension): boolean {
  if (readsPiManifestFlag(extension.resolvedPath ?? extension.path, AMBIENT_OBSERVER_MANIFEST_FLAG)) return true;

  const identity = extensionIdentity(extension);
  if (identity.includes("rpiv-warp")) return true;
  if (identity.includes("/pi-subagents/workflow-executor.")) return true;
  if (/\/pi-subagents\/(?:src\/)?index\.[cm]?[jt]s(?:$|\n)/u.test(identity)) return true;
  if (/\/pi-interactive-subagents\/(?:src\/)?index\.[cm]?[jt]s(?:$|\n)/u.test(identity)) return true;
  if (/\/pi-workflow\/(?:src\/)?extension\.[cm]?[jt]s(?:$|\n)/u.test(identity)) return true;
  if (/\/pi-spark\/(?:src\/)?index\.[cm]?[jt]s(?:$|\n)/u.test(identity)) return true;
  if (/\/(?:extensions\/)?rpiv-core\/index\.[cm]?[jt]s(?:$|\n)/u.test(identity)) return true;
  return false;
}

export function withoutOrdinaryChildProducts(base: LoadExtensionsResult): LoadExtensionsResult {
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !isOrdinaryChildProduct(extension)),
  };
}

function defaultAgent(type: SubagentType): AgentConfig | undefined {
  const lower = type.toLowerCase();
  for (const [name, agent] of DEFAULT_AGENTS) {
    if (name.toLowerCase() === lower && agent.enabled !== false) return agent;
  }
  return undefined;
}

/**
 * Resolve an agent definition under the same trust decision as its child SDK
 * resources. In global-only mode a captured project/workspace definition is
 * discarded and the global definition (or enabled built-in) is selected.
 * Programmatic definitions without a filesystem source remain explicit host
 * input and are allowed.
 */
export function resolveChildAgentConfig(
  type: SubagentType,
  captured: AgentConfig | undefined,
  options: { configCwd: string; projectTrusted: boolean; disableDefaultAgents?: boolean; settings?: Readonly<SubagentsConfig> },
): AgentConfig | undefined {
  assertAgentExtensionPolicy(captured);
  if (options.projectTrusted) {
    if (captured) return captured.enabled === false ? undefined : captured;
    const registered = getAgentConfig(type);
    assertAgentExtensionPolicy(registered);
    if (registered) return registered.enabled === false ? undefined : registered;
    const settings = options.settings ?? (options.disableDefaultAgents === undefined
      ? loadSettings(options.configCwd, { projectTrusted: true }) : {});
    const defaultsDisabled = options.disableDefaultAgents
      ?? settings.disableDefaultAgents
      ?? isDefaultsDisabled();
    if (defaultsDisabled) return undefined;
    return defaultAgent(type);
  }
  if (captured?.enabled === false) return undefined;
  if (captured && captured.source !== "project" && captured.isDefault !== true) return captured;
  if (captured?.source === "global") return captured;
  // Registry-only definitions are explicit host input too. They are not a
  // filesystem project layer, even when the SDK caller omitted a captured copy.
  if (!captured) {
    const registered = getAgentConfig(type);
    assertAgentExtensionPolicy(registered);
    if (registered && registered.source === undefined && registered.isDefault !== true) {
      return registered.enabled === false ? undefined : registered;
    }
  }

  const globalAgents = loadCustomAgents(options.configCwd, false, { projectTrusted: false });
  const global = getAgentConfigIn(globalAgents, type);
  if (global) return global.enabled === false ? undefined : global;

  const settings = options.settings ?? (options.disableDefaultAgents === undefined
    ? loadSettings(options.configCwd, { projectTrusted: false }) : {});
  if ((options.disableDefaultAgents ?? settings.disableDefaultAgents) === true) return undefined;
  return defaultAgent(type);
}
