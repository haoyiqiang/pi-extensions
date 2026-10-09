import { invalidBaseProtocol, invalidBaseUrl, missingBaseUrl, providerApiError } from "./provider-errors.ts";
import { type ProviderMeta, type SearchProvider, type SearchResponse, type SearchResult } from "./types.ts";

export const SEARXNG_API_KEY_ENV_VAR = "SEARXNG_API_KEY";
export const SEARXNG_URL_ENV_VAR = "SEARXNG_URL";
export const SEARXNG_DEFAULT_URL = "http://localhost:8080";

// SearXNG search API knobs (per https://docs.searxng.org/dev/search_api.html).
const SEARXNG_SEARCH_PATH = "/search";
const SEARXNG_FORMAT_JSON = "json";
const SEARXNG_SAFESEARCH_OFF = "0"; // 0/1/2 = none/moderate/strict

export const SEARXNG_PROVIDER_META: ProviderMeta = {
	name: "searxng",
	label: "SearXNG",
	envVar: SEARXNG_API_KEY_ENV_VAR,
	baseUrlEnvVar: SEARXNG_URL_ENV_VAR,
	defaultBaseUrl: SEARXNG_DEFAULT_URL,
	roles: ["search"],
};

interface SearxngRawResult {
	title?: string;
	url?: string;
	content?: string;
}

interface SearxngRawResponse {
	results?: SearxngRawResult[];
}

function normalizeSearxngResults(raw: SearxngRawResponse, maxResults: number): SearchResult[] {
	return (raw.results ?? []).slice(0, maxResults).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.content ?? "",
	}));
}

function stripTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

// Reject anything that isn't an http(s) URL — a user-supplied SEARXNG_URL
// must not be allowed to silently become `file://`, `javascript:`, `data:`
// or any other scheme that `new URL()` accepts but we'd misuse downstream.
function assertHttpUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw invalidBaseUrl(SEARXNG_URL_ENV_VAR, url);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw invalidBaseProtocol(SEARXNG_URL_ENV_VAR, parsed.protocol.replace(":", ""));
	}
}

// 401 ≈ reverse-proxy auth rejected the Bearer token. 403 from a default
// SearXNG install almost always means JSON output is disabled — the docs
// explicitly warn that "Requesting an unset format will return a 403
// Forbidden error". Surface the actionable fix for each.
function hintForSearchStatus(status: number): string {
	if (status === 401) {
		return " (the SearXNG reverse proxy rejected the Bearer token; check SEARXNG_API_KEY or api.apiKeys.searxng)";
	}
	if (status === 403) {
		return " (the SearXNG instance may have JSON output disabled; enable json under search.formats in settings.yml)";
	}
	return "";
}

interface SearxngProviderOptions {
	apiKey?: string;
	baseUrl: string;
}

export class SearxngProvider implements SearchProvider {
	readonly name = "searxng";
	readonly label = "SearXNG";
	readonly envVar = SEARXNG_API_KEY_ENV_VAR;

	private readonly apiKey?: string;
	private readonly baseUrl: string;

	constructor(options: SearxngProviderOptions) {
		this.apiKey = options.apiKey?.trim() || undefined;
		const trimmed = stripTrailingSlashes(options.baseUrl?.trim() ?? "");
		if (trimmed) assertHttpUrl(trimmed);
		this.baseUrl = trimmed;
	}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		this.requireBaseUrl();
		const res = await fetch(this.buildSearchUrl(query), {
			method: "GET",
			headers: this.buildAuthHeaders(),
			signal,
		});
		if (!res.ok) throw await this.searchApiError(res);
		const raw = (await res.json()) as SearxngRawResponse;
		return { query, results: normalizeSearxngResults(raw, maxResults) };
	}

	private requireBaseUrl(): void {
		if (!this.baseUrl) {
			throw missingBaseUrl(SEARXNG_URL_ENV_VAR);
		}
	}

	// The SearXNG API exposes only `pageno` for pagination, not `count`/`limit`
	// (https://docs.searxng.org/dev/search_api.html), so we ask for a single
	// page and slice to maxResults client-side.
	private buildSearchUrl(query: string): string {
		const url = new URL(`${this.baseUrl}${SEARXNG_SEARCH_PATH}`);
		url.searchParams.set("q", query);
		url.searchParams.set("format", SEARXNG_FORMAT_JSON);
		url.searchParams.set("safesearch", SEARXNG_SAFESEARCH_OFF);
		return url.toString();
	}

	// SearXNG itself has no built-in auth; the optional Bearer key is for
	// instances fronted by a reverse-proxy that gates on Authorization.
	private buildAuthHeaders(): Record<string, string> {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
		return headers;
	}

	private async searchApiError(res: Response): Promise<Error> {
		const body = await res.text();
		return providerApiError(this.label, "search", res.status, body, hintForSearchStatus(res.status));
	}
}
