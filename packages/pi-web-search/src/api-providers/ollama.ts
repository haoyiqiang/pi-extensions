import { i18n } from "../i18n.ts";
import { connectionRefused, emptyFetch, invalidBaseProtocol, invalidBaseUrl, missingBaseUrl, providerApiError } from "./provider-errors.ts";
import {
	type FetchResponse,
	type FullProvider,
	type ProviderMeta,
	type SearchResponse,
	type SearchResult,
} from "./types.ts";

export const OLLAMA_API_KEY_ENV_VAR = "OLLAMA_API_KEY";
export const OLLAMA_HOST_ENV_VAR = "OLLAMA_HOST";
export const OLLAMA_DEFAULT_URL = "http://localhost:11434";

// Ollama API paths — cloud (ollama.com) uses stable /api/... paths,
// local instances use /api/experimental/... (at least through v0.24).
const CLOUD_SEARCH_PATH = "/api/web_search";
const CLOUD_FETCH_PATH = "/api/web_fetch";
const LOCAL_SEARCH_PATH = "/api/experimental/web_search";
const LOCAL_FETCH_PATH = "/api/experimental/web_fetch";

function isLocalHost(baseUrl: string): boolean {
	try {
		const hostname = new URL(baseUrl).hostname;
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "[::1]";
	} catch {
		return true; // default to local paths if URL is somehow invalid
	}
}

export const OLLAMA_PROVIDER_META: ProviderMeta = {
	name: "ollama",
	label: "Ollama",
	envVar: OLLAMA_API_KEY_ENV_VAR,
	baseUrlEnvVar: OLLAMA_HOST_ENV_VAR,
	defaultBaseUrl: OLLAMA_DEFAULT_URL,
	roles: ["search", "fetch"],
};

// ---------------------------------------------------------------------------
// Vendor response types (file-private)
// ---------------------------------------------------------------------------

interface OllamaRawSearchResult {
	title?: string;
	url?: string;
	content?: string;
}

interface OllamaSearchResponse {
	results?: OllamaRawSearchResult[];
}

interface OllamaFetchResponse {
	title?: string;
	content?: string;
	links?: string[];
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeOllamaResults(raw: OllamaSearchResponse): SearchResult[] {
	return (raw.results ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.content ?? "",
	}));
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function stripTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

function assertHttpUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw invalidBaseUrl(OLLAMA_HOST_ENV_VAR, url);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw invalidBaseProtocol(OLLAMA_HOST_ENV_VAR, parsed.protocol.replace(":", ""));
	}
}

// ---------------------------------------------------------------------------
// Network error handling
// ---------------------------------------------------------------------------

// Node's fetch wraps ECONNREFUSED in a TypeError. Detect the cause chain
// and re-throw with an actionable hint.
function isConnectionRefused(error: unknown): boolean {
	if (error instanceof TypeError) {
		const cause = (error as unknown as { cause?: { code?: string } }).cause;
		return cause?.code === "ECONNREFUSED";
	}
	return false;
}

function connectionRefusedError(host: string): Error {
	return connectionRefused("Ollama", host);
}

// ---------------------------------------------------------------------------
// Provider class
// ---------------------------------------------------------------------------

interface OllamaProviderOptions {
	apiKey?: string;
	baseUrl: string;
}

export class OllamaProvider implements FullProvider {
	readonly name = "ollama";
	readonly label = "Ollama";
	readonly envVar = OLLAMA_API_KEY_ENV_VAR;

	private readonly apiKey?: string;
	private readonly baseUrl: string;
	private readonly local: boolean;

	constructor(options: OllamaProviderOptions) {
		this.apiKey = options.apiKey?.trim() || undefined;
		const trimmed = stripTrailingSlashes(options.baseUrl?.trim() ?? "");
		if (trimmed) assertHttpUrl(trimmed);
		this.baseUrl = trimmed;
		this.local = isLocalHost(trimmed);
	}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		this.requireBaseUrl();
		const path = this.local ? LOCAL_SEARCH_PATH : CLOUD_SEARCH_PATH;
		try {
			const res = await fetch(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: this.buildHeaders(),
				body: JSON.stringify({ query, max_results: maxResults }),
				signal,
			});
			if (!res.ok) throw await this.formatError("search", res);
			const raw = (await res.json()) as OllamaSearchResponse;
			return { query, results: normalizeOllamaResults(raw) };
		} catch (error) {
			if (isConnectionRefused(error)) throw connectionRefusedError(this.baseUrl);
			throw error;
		}
	}

	async fetch(url: string, _raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
		this.requireBaseUrl();
		const path = this.local ? LOCAL_FETCH_PATH : CLOUD_FETCH_PATH;
		try {
			const res = await fetch(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: this.buildHeaders(),
				body: JSON.stringify({ url }),
				signal,
			});
			if (!res.ok) throw await this.formatError("fetch", res);
			const data = (await res.json()) as OllamaFetchResponse;
			if (!data.content) throw emptyFetch(this.label, url);
			return {
				text: data.content,
				title: data.title || undefined,
				contentType: "text/plain",
			};
		} catch (error) {
			if (isConnectionRefused(error)) throw connectionRefusedError(this.baseUrl);
			throw error;
		}
	}

	private requireBaseUrl(): void {
		if (!this.baseUrl) {
			throw missingBaseUrl(OLLAMA_HOST_ENV_VAR);
		}
	}

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
		return headers;
	}

	private async formatError(operation: "search" | "fetch", res: Response): Promise<Error> {
		const body = await res.text();
		const hint = hintForStatus(res.status);
		return providerApiError(this.label, operation, res.status, body, hint);
	}
}

// ---------------------------------------------------------------------------
// Status hints
// ---------------------------------------------------------------------------

function hintForStatus(status: number): string {
	if (status === 401) {
		return i18n.t("provider.hint.ollamaAuth");
	}
	if (status === 404) {
		return i18n.t("provider.hint.ollamaUnsupported");
	}
	return "";
}
