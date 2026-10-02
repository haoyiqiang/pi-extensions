import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { loadWebSearchConfig, resolveConfiguredLlm } from "./config.ts";
import { openWebSearchConfigPanel } from "./config-panel.ts";
import { getProviderKind, isGoogleDeveloperModel } from "./api.ts";
import { i18n } from "./i18n.ts";
import { urlContext, UrlContextSchema } from "./url_context.ts";
import { webFetch, WebFetchSchema } from "./web_fetch.ts";
import { webSearch, WebSearchSchema } from "./web_search.ts";

const WEB_SEARCH_TOOL = "web_search";
const URL_CONTEXT_TOOL = "url_context";
const WEB_FETCH_TOOL = "web_fetch";
const CONFIG_COMMAND = "config:web-search";

function supportsUrlContext(
  currentModel: Model<Api> | undefined,
  context?: Pick<ExtensionContext, "modelRegistry">,
): boolean {
  try {
    const configured = resolveConfiguredLlm(loadWebSearchConfig().config);
    const model = configured?.provider && configured.model && context
      ? context.modelRegistry.find(configured.provider, configured.model)
      : currentModel;
    if (!model) return false;
    const transport = configured?.transport ?? "auto";
    return isGoogleDeveloperModel(model) && getProviderKind(model, transport) === "google";
  } catch {
    return false;
  }
}

function setEquals<T>(a: Set<T>, b: Set<T>) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function createModelScopedToolManager(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">) {
  let preferredActiveTools: Set<string> | undefined;
  let lastAppliedActiveTools: Set<string> | undefined;
  let suppressedTools = new Set<string>();

  const sync = (
    model: Model<Api> | undefined,
    context?: Pick<ExtensionContext, "modelRegistry">,
  ) => {
    const current = new Set(pi.getActiveTools());
    if (!preferredActiveTools) {
      preferredActiveTools = new Set(current);
    } else if (lastAppliedActiveTools) {
      for (const tool of current) if (!lastAppliedActiveTools.has(tool)) preferredActiveTools.add(tool);
      for (const tool of lastAppliedActiveTools) {
        if (!current.has(tool) && !suppressedTools.has(tool)) preferredActiveTools.delete(tool);
      }
    }

    const desired = new Set(preferredActiveTools);
    suppressedTools = new Set();
    if (!supportsUrlContext(model, context)) {
      desired.delete(URL_CONTEXT_TOOL);
      if (preferredActiveTools.has(URL_CONTEXT_TOOL)) suppressedTools.add(URL_CONTEXT_TOOL);
    }
    if (!setEquals(current, desired)) pi.setActiveTools([...desired]);
    lastAppliedActiveTools = new Set(desired);
  };
  return { sync };
}

function renderResult(result: AgentToolResult<any>, expanded: boolean, theme: any) {
  const output = result.content
    .filter((part) => part.type === "text")
    .map((part: any) => part.text)
    .join("\n");
  const isError = Boolean(result.details?.error);
  if (!expanded && !isError) return new Text("", 0, 0);
  return new Text(theme.fg(isError ? "error" : "toolOutput", output), 0, 0);
}

export default function registerPiWebSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: WEB_SEARCH_TOOL,
    label: i18n.t("webSearch.label"),
    description: i18n.t("webSearch.description"),
    parameters: WebSearchSchema,
    execute: (id, params, signal = new AbortController().signal, onUpdate, ctx) =>
      webSearch(id, params, signal, onUpdate, ctx, pi.getThinkingLevel()),
    renderCall(args, theme) {
      const suffix = args.mode ? theme.fg("muted", ` [${args.mode}]`) : "";
      return new Text(`${theme.fg("toolTitle", theme.bold(WEB_SEARCH_TOOL))} ${theme.fg("accent", args.query || "…")}${suffix}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      return renderResult(result, expanded, theme);
    },
  });

  pi.registerTool({
    name: URL_CONTEXT_TOOL,
    label: i18n.t("urlContext.label"),
    description: i18n.t("urlContext.description"),
    parameters: UrlContextSchema,
    execute: urlContext,
  });

  pi.registerTool({
    name: WEB_FETCH_TOOL,
    label: i18n.t("webFetch.label"),
    description: i18n.t("webFetch.description"),
    parameters: WebFetchSchema,
    execute: webFetch,
  });

  const manager = createModelScopedToolManager(pi);
  pi.registerCommand(CONFIG_COMMAND, {
    description: i18n.t("configPanel.commandDescription"),
    handler: (_args, ctx) => openWebSearchConfigPanel(ctx, {
      onSaved: () => manager.sync(ctx.model, ctx),
    }),
  });

  pi.on("session_start", (_event, ctx) => manager.sync(ctx.model, ctx));
  pi.on("session_tree", (_event, ctx) => manager.sync(ctx.model, ctx));
  pi.on("model_select", (event, ctx) => manager.sync(event.model, ctx));
}
