import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { LlmTransport } from "./config.ts";
import { getProviderKind } from "./providers/config.ts";
import { callGoogleStream, extractPromptFromGeminiBody } from "./providers/google.ts";
import { callOpenAIStream } from "./providers/openai.ts";
import { callAnthropicStream } from "./providers/anthropic.ts";
import type { StreamResult } from "./providers/types.ts";

export { getProviderKind, getConfig, isGoogleDeveloperModel } from "./providers/config.ts";
export { applyCitations } from "./providers/google.ts";
export type { Source, SearchResultDetail, LlmSearchCallDetail, StreamResult } from "./providers/types.ts";

export async function callApiStream(
    ctx: ExtensionContext,
    model: Model<Api>,
    body: any,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
    thinkingLevel?: ModelThinkingLevel,
    transport: LlmTransport = "auto",
): Promise<StreamResult> {
    const kind = getProviderKind(model, transport);
    if (kind === "google") {
        return callGoogleStream(ctx, model, body, onUpdate, signal, transport);
    }

    const prompt = extractPromptFromGeminiBody(body);
    if (!prompt) {
        throw new Error("No prompt text was found in the request body.");
    }

    if (kind === "openai" || kind === "xai") {
        return callOpenAIStream(ctx, model, prompt, onUpdate, signal, thinkingLevel);
    }
    if (kind === "anthropic") {
        return callAnthropicStream(ctx, model, prompt, onUpdate, signal);
    }

    throw new Error(`Provider does not support LLM web search: ${model.provider} (${model.api})`);
}
