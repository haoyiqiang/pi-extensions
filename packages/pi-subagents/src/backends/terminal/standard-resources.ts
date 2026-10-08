import { resolve } from "node:path";
import type { InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { isOrdinaryChildProduct } from "../../child-resource-policy.js";
import { ordinaryExtensionsDisabled, resolveSavedExtensions } from "../../extension-defaults.js";
import { extensionCanonicalNames, parseExtensionsSpec } from "../embedded.js";
import type { StandardTerminalChildConfig } from "./bridge-protocol.js";
import type { StandardTerminalPolicy } from "./standard-policy.js";
import { initializeSubagentsRuntime } from "../../runtime.js";

/** Child bootstrap must not re-read a changed default after admission or restore. */
export function initializeStandardTerminalRuntime(policy: StandardTerminalPolicy) {
  return initializeSubagentsRuntime(policy.configCwd, {
    projectTrusted: policy.projectTrusted,
    settings: policy.runtimePolicy?.settings ?? {},
  });
}

const PRIVATE_INLINE_PREFIX = "<inline:pi-subagents-terminal-";

/** Ordinary plugins are independent of the private bridge and provider-only entries. */
export function standardResourceOptions(config: StandardTerminalChildConfig, privateFactories: InlineExtension[]) {
  const { policy } = config;
  const extensions = resolveSavedExtensions(policy);
  const excludes = new Set((policy.agent.excludeExtensions ?? []).map((name) => name.toLowerCase()));
  const spec = Array.isArray(extensions) ? parseExtensionsSpec(extensions, policy.configCwd) : undefined;
  const keep = spec?.names ?? new Set<string>();
  const loadAll = extensions === true || spec?.wildcard === true;
  const noExtensions = ordinaryExtensionsDisabled(extensions);
  const additionalExtensionPaths = [...(spec?.paths ?? []), ...config.providerExtensions];
  const providerPaths = new Set(config.providerExtensions.map((path) => resolve(path)));

  const extensionsOverride = (base: LoadExtensionsResult): LoadExtensionsResult => ({
    ...base,
    extensions: base.extensions.filter((extension) => {
      if (extension.path.startsWith(PRIVATE_INLINE_PREFIX)) return true;
      if (providerPaths.has(resolve(extension.resolvedPath))) return true;
      if (noExtensions || isOrdinaryChildProduct(extension)) return false;
      const canons = extensionCanonicalNames(extension.path);
      if (canons.some((name) => excludes.has(name))) return false;
      return loadAll || canons.some((name) => keep.has(name));
    }).map((extension) => providerPaths.has(resolve(extension.resolvedPath))
      ? { ...extension, tools: new Map() }
      : extension),
  });

  return {
    noExtensions,
    additionalExtensionPaths: additionalExtensionPaths.length ? additionalExtensionPaths : undefined,
    extensionsOverride,
    extensionFactories: privateFactories,
    noSkills: policy.isolated || policy.agent.skills === false || Array.isArray(policy.agent.skills),
    noPromptTemplates: true,
    noThemes: policy.isolated,
    noContextFiles: true,
    systemPromptOverride: () => policy.systemPrompt,
    appendSystemPromptOverride: () => [],
  };
}
