export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	query: string;
	results: SearchResult[];
}

export interface FetchResponse {
	text: string;
	title?: string;
	contentType?: string;
	contentLength?: number;
}

// Role-split contracts. SearchProvider implementations expose `search()` only;
// FetchProvider implementations expose `fetch()` only; FullProvider is the
// intersection — both methods, for providers (Tavily, Exa, You.com, Jina,
// and Firecrawl) whose hosted fetch endpoints are used directly.
// The orchestrator narrows on `"fetch" in provider` to dispatch.
export interface SearchProvider {
	readonly name: string;
	readonly label: string;
	readonly envVar: string;
	search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse>;
}

export interface FetchProvider {
	readonly name: string;
	readonly label: string;
	readonly envVar: string;
	fetch(url: string, raw: boolean, signal?: AbortSignal): Promise<FetchResponse>;
}

export type FullProvider = SearchProvider & FetchProvider;

export type ProviderRole = "search" | "fetch";

export interface ProviderMeta {
	name: string;
	label: string;
	envVar?: string;
	baseUrlEnvVar?: string;
	defaultBaseUrl?: string;
	// Which role(s) the provider plays. Search-only providers (Brave, Serper,
	// Perplexity, SearXNG) carry ["search"]; full providers (Tavily, Exa,
	// You.com, Jina, Firecrawl, Ollama) carry ["search", "fetch"]. The orchestrator does not consult
	// `roles` at runtime — capability is checked structurally via
	// `"fetch" in provider` — but `roles` keeps the META honest and unblocks
	// future UX (e.g. a fetch-role picker).
	roles: ReadonlyArray<ProviderRole>;
}
