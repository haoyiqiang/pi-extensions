import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { callApiStream, getConfig } from "./api.ts";
import type { WebSearchConfig } from "./config.ts";
import { resolveConfiguredLlm } from "./config.ts";
import { formatWebSearchResult } from "./format.ts";
import type { LlmWebSearchDetails, WebSearchMode } from "./types.ts";
import { getWebSearchModel } from "./utils.ts";

export interface LlmSearchInput {
  query: string;
  urls?: string[];
}

export class UnsupportedLlmSearchError extends Error {
  readonly kind = "unsupported" as const;
  constructor(message = "The current or configured model does not support LLM web search.") {
    super(message);
    this.name = "UnsupportedLlmSearchError";
  }
}

export async function runLlmSearch(
  params: LlmSearchInput,
  signal: AbortSignal,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext,
  config: WebSearchConfig,
  modeRequested: WebSearchMode,
  thinkingLevel?: ModelThinkingLevel,
): Promise<AgentToolResult<LlmWebSearchDetails>> {
  const model = await getWebSearchModel(ctx, config);
  if (!model) throw new UnsupportedLlmSearchError();

  const urls = params.urls?.filter(Boolean) ?? [];
  onUpdate?.({
    content: [{
      type: "text",
      text: urls.length > 0
        ? `Searching and analyzing ${urls.length} URL(s)…`
        : `Searching for “${params.query}”…`,
    }],
    details: {},
  });

  const transport = resolveConfiguredLlm(config)?.transport ?? "auto";
  const providerConfig = getConfig(model, transport);
  if (providerConfig.kind === "unsupported") throw new UnsupportedLlmSearchError();

  const prompt = urls.length > 0
    ? `${params.query}\n\n${"Also analyze these URLs:"}\n${urls.join("\n")}`
    : params.query;
  const tools = providerConfig.kind === "google"
    ? (urls.length > 0
      ? [{ [providerConfig.searchTool!]: {} }, { [providerConfig.urlContextTool!]: {} }]
      : [{ [providerConfig.searchTool!]: {} }])
    : undefined;

  const result = await callApiStream(
    ctx,
    model,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(tools ? { tools } : {}),
    },
    onUpdate,
    signal,
    thinkingLevel,
    transport,
  );
  const formatted = formatWebSearchResult(result, { modelId: model.id });
  return {
    ...formatted,
    details: {
      query: params.query,
      modeRequested,
      modeUsed: "llm",
      model: model.id,
      providerKind: result.providerKind as LlmWebSearchDetails["providerKind"],
      grounded: Boolean(formatted.details?.grounded),
      resultCount: Number(formatted.details?.resultCount ?? 0),
      sources: formatted.details?.sources ?? [],
      searchQueries: formatted.details?.searchQueries,
      searchResults: formatted.details?.searchResults,
      citations: formatted.details?.citations,
      llmSearchUsed: formatted.details?.llmSearchUsed,
      llmSearchEvents: formatted.details?.llmSearchEvents,
      llmSearchCalls: formatted.details?.llmSearchCalls,
      retrieved: formatted.details?.retrieved,
      failed: formatted.details?.failed,
    },
  };
}
