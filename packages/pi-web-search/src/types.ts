import type { SearchResultDetail, Source } from "./providers/types.ts";

export const WEB_SEARCH_MODES = ["auto", "llm", "api"] as const;
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];

export const FALLBACK_REASONS = [
  "unsupported",
  "quota",
  "rate-limit",
  "network",
  "timeout",
  "invalid-response",
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export type SearchFailureKind =
  | FallbackReason
  | "auth"
  | "invalid-request"
  | "aborted"
  | "unknown";

export interface WebSearchFallback {
  from: "llm";
  to: "api";
  reason: FallbackReason;
  message: string;
}

export interface CommonWebSearchDetails {
  query: string;
  modeRequested: WebSearchMode;
  modeUsed: "llm" | "api";
  resultCount: number;
  sources: Source[];
  fallback?: WebSearchFallback;
}

export interface LlmSearchCallDetail {
  id?: string;
  provider: "google" | "openai" | "xai" | "anthropic";
  status?: string;
  actionType?: string;
  queries?: string[];
  urls?: string[];
}

export interface LlmWebSearchDetails extends CommonWebSearchDetails {
  modeUsed: "llm";
  model: string;
  providerKind: "google" | "openai" | "xai" | "anthropic";
  grounded: boolean;
  searchQueries?: string[];
  searchResults?: SearchResultDetail[];
  citations?: SearchResultDetail[];
  llmSearchUsed?: boolean;
  llmSearchEvents?: string[];
  llmSearchCalls?: LlmSearchCallDetail[];
  retrieved?: string[];
  failed?: Array<{ url: string; status: string }>;
  fallback?: never;
}

export interface ApiSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type ApiSearchProviderName =
  | "brave"
  | "tavily"
  | "serper"
  | "exa"
  | "youcom"
  | "jina"
  | "firecrawl"
  | "perplexity"
  | "searxng"
  | "ollama";

export interface ApiWebSearchDetails extends CommonWebSearchDetails {
  modeUsed: "api";
  backend: ApiSearchProviderName;
  results?: ApiSearchResult[];
  fallback?: WebSearchFallback;
}

export type WebSearchDetails = LlmWebSearchDetails | ApiWebSearchDetails;

export interface WebSearchErrorDetails {
  query: string;
  modeRequested: WebSearchMode;
  error: {
    stage: "llm" | "api" | "fallback" | "configuration";
    kind: SearchFailureKind;
    message: string;
  };
  attempts?: Array<{
    mode: "llm" | "api";
    backend?: string;
    kind: SearchFailureKind;
    message: string;
  }>;
}
