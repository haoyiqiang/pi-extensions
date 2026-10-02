import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { i18n } from "../i18n.ts";
import { getAuth } from "./auth.ts";
import { readSseEvents } from "./sse.ts";
import {
    applyTextCitations,
    deriveSources,
    mergeSearchResultMetadata,
    normalizeCitedSources,
    pushLlmSearchEvent,
    pushUniqueSearchResult,
    sanitizeSearchResults,
    titleFromUrl,
} from "./results.ts";
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
        throw new Error(auth.error || i18n.t("llm.authFailed"));
    }

    const isOAuth = !!auth.apiKey && auth.apiKey.includes("sk-ant-oat");
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "anthropic-version": "2023-06-01",
        ...(model.headers || {}),
        ...(auth.headers || {}),
    };

    if (auth.apiKey) {
        if (isOAuth) {
            if (!headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${auth.apiKey}`;
            headers["anthropic-beta"] = headers["anthropic-beta"]
                ? `${headers["anthropic-beta"]},claude-code-20250219,oauth-2025-04-20`
                : "claude-code-20250219,oauth-2025-04-20";
            // Anthropic rejects OAuth requests from anything older than 2.1.251.
            headers["user-agent"] = headers["user-agent"] || "claude-cli/2.1.251";
            headers["x-app"] = headers["x-app"] || "cli";
        } else if (!headers["x-api-key"] && !headers["X-Api-Key"]) {
            headers["x-api-key"] = auth.apiKey;
        }
    }

    const maxTokens = Math.min(Math.max(1024, Math.floor(model.maxTokens / 3) || 4096), 8192);
    const requestBody = {
        model: model.id,
        max_tokens: maxTokens,
        // Anthropic rejects oauth-2025-04-20 requests that omit the Claude Code
        // system prompt, reporting it as an opaque 429 rate_limit_error.
        ...(isOAuth ? { system: [{ type: "text", text: i18n.t("llm.claudeCodeSystem") }] } : {}),
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
        stream: true,
    };

    const baseUrl = auth.baseUrl ?? model.baseUrl;
    const response = await fetch(resolveAnthropicMessagesUrl(baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal
    });

    if (!response.ok) {
        throw new Error(i18n.t("llm.apiError", {
            provider: "Anthropic",
            status: response.status,
            message: await response.text(),
        }));
    }

    let accumulatedText = "";
    const citations: Array<{ citedText?: string; title: string; url: string }> = [];
    const llmSearchEvents: string[] = [];
    const llmSearchCalls: LlmSearchCallDetail[] = [];
    const searchResults: SearchResultDetail[] = [];

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
            if (block?.type === "text" && block.text) {
                accumulatedText += block.text;
                onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: { streaming: true } });
            } else if (block?.type === "server_tool_use" && block.name === "web_search") {
                pushLlmSearchEvent(llmSearchEvents, "anthropic.content_block_start.server_tool_use.web_search");
                llmSearchCalls.push({
                    id: block.id,
                    provider: "anthropic",
                    status: "in_progress",
                    actionType: block.name,
                    queries: typeof block.input?.query === "string" ? [block.input.query] : undefined,
                    raw: block,
                });
                onUpdate?.({
                    content: [{ type: "text", text: accumulatedText || i18n.t("llm.searchingProvider", { provider: "Anthropic" }) }],
                    details: { streaming: true, searching: true }
                });
            } else if (block?.type === "web_search_tool_result") {
                pushLlmSearchEvent(llmSearchEvents, "anthropic.content_block_start.web_search_tool_result");
                const call = llmSearchCalls.find((item) => item.id === block.tool_use_id);
                if (call) call.status = "completed";
                else llmSearchCalls.push({ id: block.tool_use_id, provider: "anthropic", status: "completed", actionType: "web_search", raw: block });
                if (Array.isArray(block.content)) {
                    for (const result of block.content) collectSource(result, block.tool_use_id);
                } else if (block.content?.type === "web_search_tool_result_error") {
                    pushUniqueSearchResult(searchResults, {
                        status: block.content.error_code,
                        source: "anthropic.web_search_tool_result_error",
                        type: block.content.type,
                        raw: block,
                    });
                }
            }
        } else if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta?.type === "text_delta") {
                accumulatedText += delta.text || "";
                onUpdate?.({
                    content: [{ type: "text", text: accumulatedText }],
                    details: { streaming: true }
                });
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
        } else if (event.type === "error") {
            throw new Error(event.error?.message || JSON.stringify(event.error || event));
        }
    });

    const cited = applyTextCitations(accumulatedText || i18n.t("llm.noAnswer"), citations);
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
