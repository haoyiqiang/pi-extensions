import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { loadWebSearchConfig, resolveConfiguredLlm } from "./config.ts";
import { openWebSearchConfigPanel } from "./config-panel.ts";
import { getProviderKind, isGoogleUrlContextModel } from "./api.ts";
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
    return isGoogleUrlContextModel(model, transport) && getProviderKind(model, transport) === "google";
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

// Pi marks a tool invocation as failed only when execute() throws. Keep the
// internal result envelopes for routing/tests, but surface errors at this boundary.
function throwOnToolFailure<T extends AgentToolResult<any>>(result: T): T {
  if ((result.details as { error?: unknown } | undefined)?.error) {
    const message = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    throw new Error(message || "Web tool failed.");
  }
  return result;
}

function renderResult(result: AgentToolResult<any>, expanded: boolean, theme: any, executionError = false) {
  const output = result.content
    .filter((part) => part.type === "text")
    .map((part: any) => part.text)
    .join("\n");
  const isError = executionError || Boolean(result.details?.error);
  if (!expanded && !isError) return new Text("", 0, 0);
  return new Text(theme.fg(isError ? "error" : "toolOutput", output), 0, 0);
}

export default function registerPiWebSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: WEB_SEARCH_TOOL,
    label: "Web Search",
    description: "Search the web with an LLM provider's built-in web search or a configured Search API. Auto mode prefers LLM search and falls back to API search as configured.",
    parameters: WebSearchSchema,
    execute: async (id, params, signal = new AbortController().signal, onUpdate, ctx) =>
      throwOnToolFailure(await webSearch(id, params, signal, onUpdate, ctx, pi.getThinkingLevel())),
    renderCall(args, theme) {
      const suffix = args.mode ? theme.fg("muted", ` [${args.mode}]`) : "";
      return new Text(`${theme.fg("toolTitle", theme.bold(WEB_SEARCH_TOOL))} ${theme.fg("accent", args.query || "…")}${suffix}`, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      return renderResult(result, expanded, theme, context.isError);
    },
  });

  pi.registerTool({
    name: URL_CONTEXT_TOOL,
    label: "URL Context",
    description: "Analyze up to 20 public URLs with built-in URL Context from Google Gemini Developer API or Vertex Express; public YouTube URLs are handled as video input.",
    parameters: UrlContextSchema,
    execute: async (id, params, signal = new AbortController().signal, onUpdate, ctx) =>
      throwOnToolFailure(await urlContext(id, params, signal, onUpdate, ctx)),
  });

  pi.registerTool({
    name: WEB_FETCH_TOOL,
    label: "Web Fetch",
    description: "Read one HTTP(S) URL and return its content through a hosted fetch provider or built-in HTML-to-text extraction.",
    parameters: WebFetchSchema,
    execute: async (id, params, signal = new AbortController().signal, onUpdate, ctx) =>
      throwOnToolFailure(await webFetch(id, params, signal, onUpdate, ctx)),
  });

  const manager = createModelScopedToolManager(pi);
  pi.registerCommand(CONFIG_COMMAND, {
    description: "Open the web search configuration panel",
    handler: (_args, ctx) => openWebSearchConfigPanel(ctx, {
      onSaved: () => manager.sync(ctx.model, ctx),
    }),
  });

  pi.on("session_start", (_event, ctx) => manager.sync(ctx.model, ctx));
  pi.on("session_tree", (_event, ctx) => manager.sync(ctx.model, ctx));
  pi.on("model_select", (event, ctx) => manager.sync(event.model, ctx));
}
