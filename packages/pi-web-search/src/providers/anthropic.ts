import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAuth } from "./auth.ts";
import { readSseEvents } from "./sse.ts";
import { applyTextCitations, deriveSources, mergeSearchResultMetadata, normalizeCitedSources, pushLlmSearchEvent, pushUniqueSearchResult, sanitizeSearchResults, titleFromUrl } from "./results.ts";
import type { LlmSearchCallDetail, SearchResultDetail, StreamResult } from "./types.ts";

function resolveAnthropicMessagesUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/+$/, "");
    return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

export async function callAnthropicStream(
    ctx: ExtensionContext,
    model: Model<Api>,
    prompt: string,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal
): Promise<StreamResult> {
    const auth = await getAuth(ctx, model);
    if (auth.ok === false) {
        throw new Error(auth.error || "Failed to get API key and authentication headers.");
    }

    const isOAuth = !!auth.apiKey && auth.apiKey.includes("sk-ant-oat");
    const headerOverrides = new Map([
        ...Object.entries(model.headers || {}), ...Object.entries(auth.headers || {}),
    ].map(([name, value]) => [name.toLowerCase(), value] as const));
    const headers = new Headers();
    for (const [name, value] of headerOverrides) {
        if (value !== null) headers.set(name, value);
    }
    const setDefaultHeader = (name: string, value: string) => {
        if (!headers.has(name) && headerOverrides.get(name.toLowerCase()) !== null) headers.set(name, value);
    };
    setDefaultHeader("Content-Type", "application/json");
    setDefaultHeader("Accept", "text/event-stream");
    setDefaultHeader("anthropic-version", "2023-06-01");

    if (auth.apiKey) {
        if (isOAuth) {
            setDefaultHeader("Authorization", `Bearer ${auth.apiKey}`);
            const beta = headers.get("anthropic-beta");
            if (headerOverrides.get("anthropic-beta") !== null) {
                headers.set("anthropic-beta", [beta, "claude-code-20250219", "oauth-2025-04-20"].filter(Boolean).join(","));
            }
            // Anthropic rejects OAuth requests from anything older than 2.1.251.
            setDefaultHeader("user-agent", "claude-cli/2.1.251");
            setDefaultHeader("x-app", "cli");
        } else if (!headers.has("Authorization")) {
            setDefaultHeader("x-api-key", auth.apiKey);
        }
    }

    const maxTokens = Math.min(Math.max(1024, Math.floor(model.maxTokens / 3) || 4096), 8192);
    const requestBody = {
        model: model.id,
        max_tokens: maxTokens,
        // Anthropic rejects oauth-2025-04-20 requests that omit the Claude Code
        // system prompt, reporting it as an opaque 429 rate_limit_error.
        ...(isOAuth ? { system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }] } : {}),
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
        stream: true,
    };

    const baseUrl = auth.baseUrl ?? model.baseUrl;
    const response = await fetch(resolveAnthropicMessagesUrl(baseUrl), {
        method: "POST",
        headers: Object.fromEntries(headers.entries()),
        body: JSON.stringify(requestBody),
        signal
    });

    if (!response.ok) {
        throw new Error(`${"Anthropic"} API error (${response.status}): ${await response.text()}`);
    }

    let accumulatedText = "";
    const citations: Array<{ citedText?: string; title: string; url: string }> = [];
    const llmSearchEvents: string[] = [];
    const llmSearchCalls: LlmSearchCallDetail[] = [];
    const searchResults: SearchResultDetail[] = [];
    const toolInputs = new Map<number, { call: LlmSearchCallDetail; json: string }>();

    const finishToolInput = (index: number) => {
        const input = toolInputs.get(index);
        if (!input) return;
        toolInputs.delete(index);
        if (!input.json) return;
        let parsed: any;
        try {
            parsed = JSON.parse(input.json);
        } catch {
            throw new Error("Invalid response: malformed Anthropic web search input JSON.");
        }
        if (typeof parsed?.query === "string") input.call.queries = [parsed.query];
        input.call.raw = { ...input.call.raw, input: parsed };
    };

    const collectSource = (source: any, toolUseId?: string) => {
        if (!source?.url) return;
        const title = source.title || titleFromUrl(source.url);
        citations.push({ title, url: source.url });
        pushUniqueSearchResult(searchResults, {
            title,
            url: source.url,
            pageAge: source.page_age ?? source.pageAge,
            source: "anthropic.web_search_tool_result",
            type: source.type || "web_search_result",
            raw: { toolUseId, ...source },
        });
    };

    await readSseEvents(response, signal, ({ data: event }) => {
        if (event.type === "content_block_start") {
            const block = event.content_block;
            if (block?.type === "text" && typeof block.text === "string") {
                accumulatedText += block.text;
                onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: { streaming: true } });
            } else if (block?.type === "server_tool_use" && block.name === "web_search") {
                pushLlmSearchEvent(llmSearchEvents, "anthropic.content_block_start.server_tool_use.web_search");
                const call: LlmSearchCallDetail = {
                    id: block.id,
                    provider: "anthropic",
                    status: "in_progress",
                    actionType: block.name,
                    queries: typeof block.input?.query === "string" ? [block.input.query] : undefined,
                    raw: block,
                };
                llmSearchCalls.push(call);
                toolInputs.set(event.index ?? 0, { call, json: "" });
                onUpdate?.({
                    content: [{ type: "text", text: accumulatedText || `Searching the web with ${"Anthropic"}...` }],
                    details: { streaming: true, searching: true }
                });
            } else if (block?.type === "web_search_tool_result") {
                pushLlmSearchEvent(llmSearchEvents, "anthropic.content_block_start.web_search_tool_result");
                const call = llmSearchCalls.find((item) => item.id === block.tool_use_id);
                const toolError = Array.isArray(block.content)
                    ? block.content.find((item: any) => item?.type === "web_search_tool_result_error")
                    : block.content?.type === "web_search_tool_result_error" ? block.content : undefined;
                if (toolError) {
                    if (call) call.status = "failed";
                    const code = toolError.error_code || "unknown";
                    const description = code === "too_many_requests" ? "rate limit: too many requests"
                        : code === "max_uses_exceeded" ? "per-request web search use limit reached"
                        : code === "invalid_input" ? "invalid request: web search input rejected"
                        : "web search tool failed";
                    throw new Error(`Anthropic web search failed (${code}): ${description}.`);
                }
                if (call) call.status = "completed";
                else llmSearchCalls.push({ id: block.tool_use_id, provider: "anthropic", status: "completed", actionType: "web_search", raw: block });
                if (Array.isArray(block.content)) {
                    for (const result of block.content) collectSource(result, block.tool_use_id);
                }
            }
        } else if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
                accumulatedText += delta.text || "";
                onUpdate?.({
                    content: [{ type: "text", text: accumulatedText }],
                    details: { streaming: true }
                });
            } else if (delta?.type === "input_json_delta") {
                const input = toolInputs.get(event.index ?? 0);
                if (input && typeof delta.partial_json === "string") input.json += delta.partial_json;
            } else if (delta?.type === "citations_delta") {
                const citation = delta.citation;
                if (citation?.type === "web_search_result_location" && citation.url) {
                    const detail = {
                        citedText: citation.cited_text,
                        title: citation.title || titleFromUrl(citation.url),
                        url: citation.url,
                        source: "anthropic.citations_delta",
                        type: citation.type,
                        raw: citation,
                    };
                    citations.push({ citedText: detail.citedText, title: detail.title, url: detail.url });
                    pushUniqueSearchResult(searchResults, detail);
                }
            }
        } else if (event.type === "content_block_stop") {
            finishToolInput(event.index ?? 0);
        } else if (event.type === "error") {
            throw new Error(event.error?.message || JSON.stringify(event.error || event));
        }
    });
    // Some compatible endpoints omit block_stop; a complete delta input at EOF
    // is still useful, and does not require a particular terminal event.
    for (const index of toolInputs.keys()) finishToolInput(index);
    const cited = applyTextCitations(accumulatedText || "No answer was returned.", citations);
    const citationDetails = citations.map((citation) => ({
        title: citation.title || titleFromUrl(citation.url),
        url: citation.url,
        citedText: citation.citedText,
        source: "anthropic.citation",
        type: "citation",
        raw: citation,
    }));
    mergeSearchResultMetadata(searchResults, citationDetails);
    const sanitizedSearchResults = sanitizeSearchResults(searchResults);
    const sanitizedCitations = sanitizeSearchResults(citationDetails);
    mergeSearchResultMetadata(sanitizedSearchResults, sanitizedCitations);
    const derivedSources = deriveSources(sanitizedSearchResults, sanitizedCitations);
    if (!accumulatedText.trim() && sanitizedSearchResults.length === 0 && sanitizedCitations.length === 0) {
        throw new Error("Invalid response: Anthropic returned no answer or web search results.");
    }

    return {
        text: cited.text,
        sources: cited.sources.length ? normalizeCitedSources(cited.sources) : derivedSources,
        providerKind: "anthropic",
        llmSearchUsed: llmSearchEvents.length > 0 || llmSearchCalls.length > 0 || sanitizedSearchResults.length > 0,
        llmSearchEvents,
        llmSearchCalls,
        searchQueries: llmSearchCalls.flatMap((call) => call.queries || []),
        searchResults: sanitizedSearchResults,
        citations: sanitizedCitations,
    };
}
