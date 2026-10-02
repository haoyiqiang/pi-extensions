import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { createSearchProvider } from "./api-providers/factory.ts";
import { PROVIDERS } from "./api-providers/index.ts";
import type { SearchResult } from "./api-providers/types.ts";
import type { WebSearchConfig } from "./config.ts";
import { resolveApiProviderName } from "./config.ts";
import { i18n } from "./i18n.ts";
import type {
  ApiSearchProviderName,
  ApiWebSearchDetails,
  WebSearchFallback,
  WebSearchMode,
} from "./types.ts";

const DEFAULT_RESULTS = 5;
const MIN_RESULTS = 1;
const MAX_RESULTS = 10;

export interface ApiSearchInput {
  query: string;
  provider?: string;
  max_results?: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function resolveProviderCredentials(config: WebSearchConfig, provider: ApiSearchProviderName) {
  const meta = PROVIDERS.find((candidate) => candidate.name === provider);
  if (!meta) throw new Error(i18n.t("error.unknownApiProvider", { provider }));
  const apiKey = nonEmpty(meta.envVar ? process.env[meta.envVar] : undefined)
    ?? nonEmpty(config.api?.apiKeys?.[provider]);
  const baseUrl = nonEmpty(meta.baseUrlEnvVar ? process.env[meta.baseUrlEnvVar] : undefined)
    ?? nonEmpty(config.api?.baseUrls?.[provider])
    ?? meta.defaultBaseUrl;
  return { apiKey, baseUrl };
}

function clampResultCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(MIN_RESULTS, Math.floor(value!)));
}

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return i18n.t("webSearch.noResults", { query });
  const body = results.map((result, index) =>
    `${index + 1}. **${result.title}**\n   ${result.url}\n   ${result.snippet}`,
  ).join("\n\n");
  return `**${i18n.t("webSearch.resultsHeading", { query })}**\n\n${body}`;
}

export async function runApiSearch(
  params: ApiSearchInput,
  signal: AbortSignal,
  onUpdate: AgentToolUpdateCallback | undefined,
  config: WebSearchConfig,
  modeRequested: WebSearchMode,
  fallback?: WebSearchFallback,
): Promise<AgentToolResult<ApiWebSearchDetails>> {
  const providerName = resolveApiProviderName(config, params.provider);
  const credentials = resolveProviderCredentials(config, providerName);
  const provider = createSearchProvider(providerName, credentials);
  const maxResults = clampResultCount(params.max_results);

  onUpdate?.({
    content: [{
      type: "text",
      text: i18n.t("webSearch.apiSearching", { provider: provider.label, query: params.query }),
    }],
    details: { query: params.query, modeRequested, modeUsed: "api", backend: providerName, resultCount: 0 },
  });

  const response = await provider.search(params.query, maxResults, signal);
  const results = response.results.slice(0, maxResults);
  return {
    content: [{ type: "text", text: formatResults(params.query, results) }],
    details: {
      query: params.query,
      modeRequested,
      modeUsed: "api",
      backend: providerName,
      resultCount: results.length,
      ...(results.length > 0 ? { results } : {}),
      sources: results.map(({ title, url }) => ({ title, url })),
      ...(fallback ? { fallback } : {}),
    },
  };
}
