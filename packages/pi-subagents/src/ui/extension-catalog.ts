import { realpathSync } from "node:fs";
import { DefaultPackageManager, SettingsManager, type Extension } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "pi-extensions-config";
import { extensionCanonicalNames } from "../backends/embedded.js";
import { isOrdinaryChildProduct } from "../child-resource-policy.js";
import { i18n } from "../i18n.js";
import type { ExtensionOption } from "./extensions-picker.js";

/** Native resolve performs manifest/path discovery, never module or factory loading.
 * It also expands directory resources into their manifest/index entrypoints.
 * Missing remote sources are deliberately skipped, not installed or refreshed.
 */
export async function discoverExtensionCatalog(
  cwd: string,
  options: { projectTrusted: boolean; agentDir?: string },
): Promise<ExtensionOption[]> {
  const agentDir = options.agentDir ?? resolveAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: options.projectTrusted });
  const resources = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve(async () => "skip");
  const groups = new Map<string, { aliases: Set<string>; paths: Set<string>; descriptions: Set<string> }>();
  for (const resource of resources.extensions) {
    if (!resource.enabled) continue;
    let resolvedPath = resource.path;
    try { resolvedPath = realpathSync(resource.path); } catch { /* Native discovery may race removal. */ }
    // The existing predicate reads identity/manifest metadata only. No factory exists here.
    const identity = {
      path: resource.path,
      resolvedPath,
      sourceInfo: { source: resource.metadata.source },
    } as Extension;
    if (isOrdinaryChildProduct(identity)) continue;
    const aliases = extensionCanonicalNames(resource.path);
    const value = aliases.at(-1)!; // Package short name is preferred over a src/index alias.
    const group = groups.get(value) ?? { aliases: new Set<string>(), paths: new Set<string>(), descriptions: new Set<string>() };
    aliases.forEach(alias => group.aliases.add(alias));
    group.paths.add(resource.path);
    group.paths.add(resolvedPath);
    group.descriptions.add(i18n.t("extensionDefaults.catalogSource", {
      scope: i18n.t(resource.metadata.scope === "project" ? "extensionDefaults.project" : "extensionDefaults.global"),
      source: resource.metadata.source,
      path: resource.path,
    }));
    groups.set(value, group);
  }
  return [...groups].map(([value, group]) => ({
    value, available: true, aliases: [...group.aliases], paths: [...group.paths],
    description: [...group.descriptions].sort().join(" · "),
  })).sort((a, b) => a.value.localeCompare(b.value));
}
