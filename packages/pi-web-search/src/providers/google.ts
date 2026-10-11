import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { TextEncoder, TextDecoder } from "util";
import type { LlmTransport } from "../config.ts";
import { getConfig } from "./config.ts";
import { getAuth } from "./auth.ts";
import { readSseEvents } from "./sse.ts";
import { isLikelyJunkSearchUrl, normalizeSearchUrl, pushUniqueSearchResult, pushUniqueSource, sanitizeSearchResults, titleFromUrl } from "./results.ts";
import type { SearchResultDetail, Source, StreamResult } from "./types.ts";

export function extractPromptFromGeminiBody(body: any): string {
    const parts: string[] = [];
    for (const content of body?.contents || []) {
        for (const part of content?.parts || []) {
            if (typeof part?.text === "string") {
                parts.push(part.text);
            } else if (part?.file_data?.file_uri) {
                parts.push(String(part.file_data.file_uri));
            }
        }
    }
    return parts.join("\n\n").trim();
}

function isGoogleGroundingRedirect(url: string | undefined): boolean {
    return !!url && /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//.test(url);
}

function groundingChunkSource(chunk: any): { title: string; url: string; type: string } | undefined {
    const type = ["web", "retrievedContext", "maps"].find((key) => chunk?.[key]);
    if (!type) return undefined;
    const content = chunk[type];
    if (typeof content.uri !== "string" || !content.uri) return undefined;
    return { title: content.title || titleFromUrl(content.uri), url: content.uri, type };
}

function groundingSources(groundingMetadata: any): { sources: Source[]; chunkIndices: Map<number, number> } {
    const sources: Source[] = [];
    const chunkIndices = new Map<number, number>();
    (groundingMetadata?.groundingChunks || []).forEach((chunk: any, index: number) => {
        const source = groundingChunkSource(chunk);
        if (!source) return;
        const url = normalizeSearchUrl(source.url);
        if (isLikelyJunkSearchUrl(url)) return;
        chunkIndices.set(index, pushUniqueSource(sources, { title: source.title, url }));
    });
    return { sources, chunkIndices };
}

async function resolveGoogleGroundingRedirectUrls(searchResults: SearchResultDetail[], citations: SearchResultDetail[], groundingMetadata: any, signal?: AbortSignal) {
    const redirectUrls = [...new Set([...searchResults, ...citations].map((item) => item.url).filter((url): url is string => isGoogleGroundingRedirect(url)))];
    if (redirectUrls.length === 0) return;

    const resolved = new Map<string, string>();
    await Promise.all(redirectUrls.slice(0, 20).map(async (url) => {
        try {
            const response = await fetch(url, { method: "HEAD", redirect: "manual", signal });
            const location = response.headers.get("location");
            if (location) resolved.set(url, new URL(location, url).toString());
        } catch (error) {
            if (signal?.aborted) signal.throwIfAborted();
            if (error instanceof Error && error.name === "AbortError") throw error;
            // Ignore ordinary redirect resolution failures and keep the original URL.
        }
    }));
    signal?.throwIfAborted();

    if (resolved.size === 0) return;
    // Citation insertion later reads groundingChunks. Keep those URLs in sync
    // with the canonical result URLs instead of maintaining two source orders.
    for (const chunk of groundingMetadata?.groundingChunks || []) {
        for (const key of ["web", "retrievedContext", "maps"]) {
            const content = chunk?.[key];
            const canonicalUrl = resolved.get(content?.uri);
            if (canonicalUrl) content.uri = canonicalUrl;
        }
    }
    for (const item of [...searchResults, ...citations]) {
        if (!item.url) continue;
        const canonicalUrl = resolved.get(item.url);
        if (!canonicalUrl) continue;
        item.url = canonicalUrl;
        if (!item.title || item.title === "Unknown") {
            item.title = titleFromUrl(canonicalUrl);
        }
    }
}

function extractGoogleSearchDetails(groundingMetadata: any): { searchQueries: string[]; searchResults: SearchResultDetail[]; citations: SearchResultDetail[] } {
    const searchQueries = groundingMetadata?.webSearchQueries || [];
    const chunks = groundingMetadata?.groundingChunks || [];
    const supports = groundingMetadata?.groundingSupports || [];
    const searchResults: SearchResultDetail[] = [];
    const citations: SearchResultDetail[] = [];

    chunks.forEach((chunk: any, index: number) => {
        const source = groundingChunkSource(chunk);
        if (!source) return;
        pushUniqueSearchResult(searchResults, {
            title: source.title,
            url: source.url,
            source: "google.groundingChunks",
            type: source.type,
            raw: { index, ...chunk[source.type] },
        });
    });

    supports.forEach((support: any) => {
        for (const index of support?.groundingChunkIndices || []) {
            const source = groundingChunkSource(chunks[index]);
            if (!source) continue;
            pushUniqueSearchResult(citations, {
                title: source.title,
                url: source.url,
                citedText: support?.segment?.text,
                source: "google.groundingSupports",
                type: "citation",
                raw: support,
            });
        }
    });

    return { searchQueries, searchResults, citations };
}

export async function callGoogleStream(
    ctx: ExtensionContext,
    model: Model<Api>,
    body: any,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
    transport: LlmTransport = "auto",
): Promise<StreamResult> {
    const config = getConfig(model, transport);
    if (!config.buildRequest) {
        throw new Error(`Unsupported Google provider: ${model.provider}`);
    }

    const auth = await getAuth(ctx, model);
    if (auth.ok === false) {
        throw new Error(auth.error || "Failed to get API key and authentication headers.");
    }

    const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    const req = config.buildRequest(requestModel, body, auth);

    const headerOverrides = new Map([
        ...Object.entries(model.headers || {}), ...Object.entries(auth.headers || {}),
    ].map(([name, value]) => [name.toLowerCase(), value] as const));
    const headers = new Headers(req.headers);
    for (const [name, value] of headerOverrides) {
        if (value === null) headers.delete(name);
        else headers.set(name, value);
    }
    if (auth.apiKey && model.provider !== "antigravity" && model.api !== "antigravity"
        && !headers.has("x-goog-api-key") && headerOverrides.get("x-goog-api-key") !== null) {
        headers.set("x-goog-api-key", auth.apiKey);
    }

    const response = await fetch(req.url, {
        method: "POST",
        headers: Object.fromEntries(headers.entries()),
        body: JSON.stringify(req.body),
        signal
    });

    if (!response.ok) {
        throw new Error(`${"Google"} API error (${response.status}): ${await response.text()}`);
    }

    let accumulatedText = "";
    let groundingMetadata: any;
    let urlContextMetadata: any;

    await readSseEvents(response, signal, ({ data: chunk }) => {
        if (chunk.error) {
            const errorMsg = chunk.error.message || JSON.stringify(chunk.error);
            throw new Error(`${"Google"} API error (${chunk.error.code || chunk.error.status || "unknown error"}): ${errorMsg}`);
        }

        // Unwrap response for internal APIs
        const data = chunk.response || chunk;
        const candidate = data.candidates?.[0];

        if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
                if (typeof part.text === "string") {
                    accumulatedText += part.text;
                    onUpdate?.({
                        content: [{ type: "text", text: accumulatedText }],
                        details: { streaming: true }
                    });
                }
            }
        }

        // Capture metadata from final chunk
        if (candidate?.groundingMetadata) {
            groundingMetadata = candidate.groundingMetadata;
        }
        // Handle both camelCase and snake_case
        if (candidate?.urlContextMetadata || candidate?.url_context_metadata) {
            urlContextMetadata = candidate.urlContextMetadata || candidate.url_context_metadata;
        }
    });

    const searchDetails = extractGoogleSearchDetails(groundingMetadata);
    await resolveGoogleGroundingRedirectUrls(searchDetails.searchResults, searchDetails.citations, groundingMetadata, signal);
    const searchResults = sanitizeSearchResults(searchDetails.searchResults);
    const citations = sanitizeSearchResults(searchDetails.citations);
    const urlMetadata = urlContextMetadata?.urlMetadata || urlContextMetadata?.url_metadata;
    if (!accumulatedText.trim() && searchResults.length === 0 && !urlMetadata?.length) {
        throw new Error("Invalid response: Google returned no answer or grounding results.");
    }
    return {
        text: accumulatedText || "No answer was returned.",
        sources: groundingSources(groundingMetadata).sources,
        providerKind: "google",
        llmSearchUsed: searchDetails.searchQueries.length > 0 || searchResults.length > 0,
        llmSearchEvents: searchDetails.searchQueries.length > 0 ? ["google.groundingMetadata.webSearchQueries"] : [],
        searchQueries: searchDetails.searchQueries,
        searchResults,
        citations,
        groundingMetadata,
        urlContextMetadata
    };
}

// --- Citation Processing (byte-safe) ---

export function applyCitations(text: string, groundingMetadata: any): { text: string; sources: Source[] } {
    const supports = groundingMetadata?.groundingSupports || [];

    const { sources, chunkIndices } = groundingSources(groundingMetadata);

    if (!supports.length || !sources.length) return { text, sources };

    // Map the original grounding chunk indexes to the displayed sources. This
    // keeps numbering stable through non-web chunks, deduplication and filtering.
    const insertions = supports
        .filter((s: any) => Number.isFinite(s.segment?.endIndex) && s.groundingChunkIndices?.length)
        .map((s: any) => ({
            index: Math.max(0, s.segment.endIndex),
            marker: [...new Set<number>(s.groundingChunkIndices
                .map((i: number) => chunkIndices.get(i))
                .filter((i: number | undefined) => i !== undefined))]
                .map((i) => `[${i + 1}]`).join("")
        }))
        .filter((insertion: { marker: string }) => insertion.marker)
        .sort((a: any, b: any) => b.index - a.index);

    // Byte-safe insertion
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bytes = encoder.encode(text);

    const parts: Uint8Array[] = [];
    let lastIndex = bytes.length;

    for (const ins of insertions) {
        const pos = Math.min(ins.index, lastIndex);
        if (pos < lastIndex) parts.unshift(bytes.subarray(pos, lastIndex));
        parts.unshift(encoder.encode(ins.marker));
        lastIndex = pos;
    }
    if (lastIndex > 0) parts.unshift(bytes.subarray(0, lastIndex));

    const total = parts.reduce((acc, p) => acc + p.length, 0);
    const final = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        final.set(part, offset);
        offset += part.length;
    }

    return { text: decoder.decode(final), sources };
}
