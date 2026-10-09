import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { callApiStream, getConfig, isGoogleDeveloperModel } from "./api.ts";
import { loadWebSearchConfig, resolveConfiguredLlm } from "./config.ts";
import { formatResult, formatUrlContextResult } from "./format.ts";
import { describeModel, getUrlContextModel } from "./utils.ts";

export const UrlContextSchema = Type.Object({
  query: Type.String({ description: "Question or task to perform on the URLs" }),
  urls: Type.Array(Type.String(), {
    description: "Public URLs to analyze, from 1 to 20",
    minItems: 1,
    maxItems: 20,
  }),
});
export type UrlContextInput = Static<typeof UrlContextSchema>;

function isYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return /^\/[A-Za-z0-9_-]{11}(?:\/|$)/.test(url.pathname);
    if (host !== "youtube.com" && host !== "m.youtube.com") return false;
    if (url.pathname === "/watch") return /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") ?? "");
    return /^\/(?:embed|shorts|live|v)\/[A-Za-z0-9_-]{11}(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

export async function urlContext(
  _id: string,
  params: UrlContextInput,
  signal: AbortSignal,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext,
) {
  let config;
  try {
    config = loadWebSearchConfig().config;
  } catch (error) {
    return formatResult(`Search failed: ${error instanceof Error ? error.message : String(error)}`, {
      error: "invalid_config",
    });
  }

  const model = await getUrlContextModel(ctx, config);
  const transport = resolveConfiguredLlm(config)?.transport ?? "auto";
  const providerConfig = model ? getConfig(model, transport) : undefined;
  const isVertexExpress = transport === "vertex-express";

  if (!model || !isGoogleDeveloperModel(model) || providerConfig?.kind !== "google") {
    const current = ctx.model ? describeModel(ctx.model) : "none";
    return formatResult(`url_context requires a Google Gemini Developer API or Vertex Express model. Current model: ${current}.`, {
      error: "unsupported_provider",
      model: current,
      supportedTransports: ["google-developer", "vertex-express"],
      grounded: false,
    });
  }

  onUpdate?.({
    content: [{ type: "text", text: `Analyzing ${params.urls.length} URL(s)…` }],
    details: {},
  });

  try {
    const youtubeUrls = params.urls.filter(isYouTubeUrl);
    const otherUrls = params.urls.filter((url) => !isYouTubeUrl(url));
    if (youtubeUrls.length > 1) {
      return formatResult("Gemini supports only one public YouTube URL per request. Call url_context separately for each video.", {
        error: "invalid_request",
        model: model.id,
        youtubeUrlCount: youtubeUrls.length,
      });
    }
    const parts: any[] = [];
    for (const url of youtubeUrls) {
      parts.push(isVertexExpress
        ? { fileData: { fileUri: url, mimeType: "video/mp4" } }
        : { file_data: { file_uri: url, mime_type: "video/mp4" } });
    }

    let prompt = params.query;
    if (otherUrls.length > 0) prompt += `\n\n${"URLs:"}\n${otherUrls.join("\n")}`;
    parts.push({ text: prompt });

    const tools = [{ [providerConfig.urlContextTool!]: {} }];
    const result = await callApiStream(
      ctx,
      model,
      { contents: [{ role: "user", parts }], tools },
      onUpdate,
      signal,
      undefined,
      transport,
    );
    return formatUrlContextResult(result, { modelId: model.id });
  } catch (error) {
    return formatResult(`Search failed: ${error instanceof Error ? error.message : String(error)}`, {
      error: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
