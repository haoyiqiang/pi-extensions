import { missingCredential, providerApiError } from "./provider-errors.ts";
import type { SearchProvider, SearchResponse, SearchResult } from "./types.ts";

const SERPER_API_URL = "https://google.serper.dev/search";
export const SERPER_API_KEY_ENV_VAR = "SERPER_API_KEY";
export const SERPER_PROVIDER_META = {
	name: "serper",
	label: "Serper",
	envVar: SERPER_API_KEY_ENV_VAR,
	roles: ["search"] as const,
} as const;

interface SerperOrganicResult {
	title?: string;
	link?: string;
	snippet?: string;
}

interface SerperRawResponse {
	organic?: SerperOrganicResult[];
	message?: string;
}

function normalizeSerperResults(results: SerperOrganicResult[]): SearchResult[] {
	return results.map((r) => ({
		title: r.title ?? "",
		url: r.link ?? "",
		snippet: r.snippet ?? "",
	}));
}

export class SerperProvider implements SearchProvider {
	readonly name = SERPER_PROVIDER_META.name;
	readonly label = SERPER_PROVIDER_META.label;
	readonly envVar = SERPER_PROVIDER_META.envVar;

	constructor(private readonly apiKey: string) {}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) throw missingCredential(this.envVar, this.name);

		const res = await fetch(SERPER_API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-KEY": this.apiKey,
			},
			body: JSON.stringify({
				q: query,
				num: maxResults,
			}),
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw providerApiError(this.label, "search", res.status, text);
		}

		const raw = (await res.json()) as SerperRawResponse;
		return { query, results: normalizeSerperResults(raw.organic ?? []) };
	}
}
