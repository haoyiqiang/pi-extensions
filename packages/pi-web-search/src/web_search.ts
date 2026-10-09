import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { runApiSearch } from "./api_search.ts";
import { loadWebSearchConfig, resolveApiProviderName } from "./config.ts";
import { runLlmSearch, UnsupportedLlmSearchError } from "./llm_search.ts";
import type {
  FallbackReason,
  SearchFailureKind,
  WebSearchErrorDetails,
  WebSearchFallback,
  WebSearchMode,
} from "./types.ts";

const ApiProviderSchema = Type.Union([
  Type.Literal("brave"),
  Type.Literal("tavily"),
  Type.Literal("serper"),
  Type.Literal("exa"),
  Type.Literal("youcom"),
  Type.Literal("jina"),
  Type.Literal("firecrawl"),
  Type.Literal("perplexity"),
  Type.Literal("searxng"),
  Type.Literal("ollama"),
]);

export const WebSearchSchema = Type.Object({
  query: Type.String({ description: "The search query or question to answer" }),
  mode: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("llm"),
    Type.Literal("api"),
  ], { description: "Search mode: auto, llm, or api" })),
  provider: Type.Optional(Type.Union(ApiProviderSchema.anyOf, { description: "API search provider; used as the fallback provider in auto mode" })),
  max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Number of API search results, from 1 to 10" })),
  urls: Type.Optional(Type.Array(Type.String(), {
    description: "Additional URLs to analyze with model search, up to 20",
    maxItems: 20,
  })),
});
export type WebSearchInput = Static<typeof WebSearchSchema>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifySearchFailure(error: unknown, signal?: AbortSignal): SearchFailureKind {
  if (signal?.aborted) return "aborted";
  if (error instanceof UnsupportedLlmSearchError) return "unsupported";
  const message = messageOf(error).toLowerCase();
  if (message.includes("abort")) return "aborted";
  if (message.includes("unsupported") || message.includes("does not support") || message.includes("not support native")) return "unsupported";
  if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests")) return "rate-limit";
  if (message.includes("402") || message.includes("quota") || message.includes("credit") || message.includes("billing")) return "quota";
  if (message.includes("timed out") || message.includes("timeout")) return "timeout";
  if (message.includes("401") || message.includes("403") || message.includes("api key") || message.includes("authentication") || message.includes("unauthorized")) return "auth";
  if (message.includes("invalid request") || message.includes("bad request") || message.includes("400")) return "invalid-request";
  if (message.includes("fetch failed") || message.includes("network") || message.includes("enotfound") || message.includes("econnreset") || message.includes("econnrefused")) return "network";
  if (message.includes("invalid response") || message.includes("malformed") || message.includes("empty response")) return "invalid-response";
  return "unknown";
}

function errorResult(
  query: string,
  modeRequested: WebSearchMode,
  stage: WebSearchErrorDetails["error"]["stage"],
  kind: SearchFailureKind,
  error: unknown,
  attempts?: WebSearchErrorDetails["attempts"],
): AgentToolResult<WebSearchErrorDetails> {
  const message = messageOf(error);
  return {
    content: [{ type: "text", text: `Search failed: ${message}` }],
    details: {
      query,
      modeRequested,
      error: { stage, kind, message },
      ...(attempts ? { attempts } : {}),
    },
  };
}

function canFallback(kind: SearchFailureKind, fallbackOn: readonly FallbackReason[]): kind is FallbackReason {
  return fallbackOn.includes(kind as FallbackReason);
}

export async function webSearch(
  _id: string,
  params: WebSearchInput,
  signal: AbortSignal,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext,
  thinkingLevel?: ModelThinkingLevel,
): Promise<AgentToolResult<any>> {
  let loaded;
  try {
    loaded = loadWebSearchConfig();
  } catch (error) {
    return errorResult(params.query, params.mode ?? "auto", "configuration", "invalid-request", error);
  }
  const config = loaded.config;
  const modeRequested = (params.mode ?? config.mode ?? "auto") as WebSearchMode;
  const urls = params.urls?.filter(Boolean) ?? [];

  if (modeRequested === "api") {
    if (urls.length > 0) {
      return errorResult(params.query, modeRequested, "api", "invalid-request", new Error("API search does not support urls. Use llm mode, url_context, or web_fetch."));
    }
    try {
      return await runApiSearch(params, signal, onUpdate, config, modeRequested);
    } catch (error) {
      return errorResult(params.query, modeRequested, "api", classifySearchFailure(error, signal), error);
    }
  }

  if (modeRequested === "llm") {
    try {
      return await runLlmSearch(params, signal, onUpdate, ctx, config, modeRequested, thinkingLevel);
    } catch (error) {
      return errorResult(params.query, modeRequested, "llm", classifySearchFailure(error, signal), error);
    }
  }

  try {
    return await runLlmSearch(params, signal, onUpdate, ctx, config, modeRequested, thinkingLevel);
  } catch (llmError) {
    const llmKind = classifySearchFailure(llmError, signal);
    const fallbackOn = config.fallbackOn ?? ["unsupported"];
    if (urls.length > 0 || !canFallback(llmKind, fallbackOn)) {
      return errorResult(params.query, modeRequested, "llm", llmKind, llmError, [
        { mode: "llm", kind: llmKind, message: messageOf(llmError) },
      ]);
    }

    const fallback: WebSearchFallback = {
      from: "llm",
      to: "api",
      reason: llmKind,
      message: messageOf(llmError),
    };
    let fallbackProvider: string | undefined;
    try {
      fallbackProvider = resolveApiProviderName(config, params.provider);
      return await runApiSearch(params, signal, onUpdate, config, modeRequested, fallback);
    } catch (apiError) {
      const apiKind = classifySearchFailure(apiError, signal);
      const combinedError = new Error(`LLM search failed: ${messageOf(llmError)}; API fallback (${fallbackProvider ?? params.provider ?? "api"}) failed: ${messageOf(apiError)}`);
      return errorResult(params.query, modeRequested, "fallback", apiKind, combinedError, [
        { mode: "llm", kind: llmKind, message: messageOf(llmError) },
        { mode: "api", backend: fallbackProvider ?? params.provider, kind: apiKind, message: messageOf(apiError) },
      ]);
    }
  }
}
