import { emptyFetch, missingCredential, providerApiError } from "./provider-errors.ts";
import type { FetchResponse, FullProvider, SearchResponse, SearchResult } from "./types.ts";

const YOUCOM_SEARCH_URL = "https://ydc-index.io/v1/search";
const YOUCOM_CONTENTS_URL = "https://ydc-index.io/v1/contents";
export const YOUCOM_API_KEY_ENV_VAR = "YOUCOM_API_KEY";
export const YOUCOM_PROVIDER_META = {
	name: "youcom",
	label: "You.com",
	envVar: YOUCOM_API_KEY_ENV_VAR,
	roles: ["search", "fetch"] as const,
} as const;

interface YouComWebResult {
	url?: string;
	title?: string;
	description?: string;
	snippets?: string[];
}

interface YouComSearchResponse {
	results?: {
		web?: YouComWebResult[];
	};
}

interface YouComContentsResponseItem {
	url: string;
	title?: string;
	markdown?: string | null;
}

function normalizeYouComResults(results: YouComWebResult[]): SearchResult[] {
	return results.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.snippets?.[0] ?? r.description ?? "",
	}));
}

export class YouComProvider implements FullProvider {
	readonly name = YOUCOM_PROVIDER_META.name;
	readonly label = YOUCOM_PROVIDER_META.label;
	readonly envVar = YOUCOM_API_KEY_ENV_VAR;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) throw missingCredential(this.envVar, this.name);

		const res = await fetch(YOUCOM_SEARCH_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": this.apiKey,
			},
			body: JSON.stringify({
				query,
				count: maxResults,
			}),
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw providerApiError(this.label, "search", res.status, text);
		}

		const raw = (await res.json()) as YouComSearchResponse;
		return { query, results: normalizeYouComResults(raw.results?.web ?? []) };
	}

	async fetch(url: string, _raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
		if (!this.apiKey) throw missingCredential(this.envVar, this.name);

		const res = await fetch(YOUCOM_CONTENTS_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": this.apiKey,
			},
			body: JSON.stringify({
				urls: [url],
				formats: ["markdown"],
			}),
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw providerApiError(this.label, "fetch", res.status, text);
		}

		const raw = (await res.json()) as YouComContentsResponseItem[];
		const item = raw[0];

		if (!item?.markdown) {
			throw emptyFetch(this.label, url);
		}

		return {
			text: item.markdown,
			title: item.title || undefined,
			contentType: "text/markdown",
		};
	}
}
