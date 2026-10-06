import { resolve } from "node:path";
import type { ExtensionAPI, InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../types.js";
import { i18n } from "../../i18n.js";
import { extensionCanonicalNames, parseExtSelectors } from "../embedded.js";

/** Live child-process tool scope mirroring embedded.ts, including late extension tools. */
export function createStandardToolScope(options: {
  agent: AgentConfig;
  builtinTools: readonly string[];
  readmitToolNames: ReadonlySet<string>;
  /** Transport/provider registration must not grant the provider's tools. */
  providerOnlyPaths?: ReadonlySet<string>;
  getExtensions: () => LoadExtensionsResult;
}): InlineExtension {
  return {
    name: "pi-subagents-terminal-tool-scope",
    hidden: true,
    factory(pi: ExtensionAPI) {
      const denied = new Set(options.agent.disallowedTools ?? []);
      const { extNames, narrowing } = parseExtSelectors(options.agent.extSelectors ?? []);

      const inScope = (): Set<string> => {
        const keep = new Set(options.builtinTools.filter((name) => !denied.has(name)));
        const optIn = extNames.size > 0;
        for (const extension of options.getExtensions().extensions) {
          if (options.providerOnlyPaths?.has(resolve(extension.resolvedPath))) continue;
          const canons = extensionCanonicalNames(extension.path);
          if (optIn && !canons.some((name) => extNames.has(name))) continue;
          const narrowed = canons.map((name) => narrowing.get(name)).find(Boolean);
          for (const name of extension.tools.keys()) {
            if (narrowed && !narrowed.has(name)) continue;
            if (!denied.has(name)) keep.add(name);
          }
        }
        for (const name of options.readmitToolNames) keep.add(name);
        return keep;
      };

      const apply = (): Set<string> => {
        const allowed = inScope();
        const active = pi.getAllTools().map((tool) => tool.name).filter((name) => allowed.has(name));
        const current = pi.getActiveTools();
        if (active.length !== current.length || active.some((name, index) => name !== current[index])) {
          pi.setActiveTools(active);
        }
        return allowed;
      };

      pi.on("session_start", () => { apply(); });
      pi.on("before_agent_start", (event) => {
        const allowed = apply();
        event.systemPromptOptions.selectedTools = [...allowed];
      });
      pi.on("turn_end", () => { apply(); });
      pi.on("tool_call", (event) => {
        if (inScope().has(event.toolName)) return;
        return { block: true, reason: i18n.t("bridge.toolDenied", { name: event.toolName }) };
      });
    },
  };
}
