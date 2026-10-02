import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { callApiStream, getConfig, isGoogleDeveloperModel } from "./api.ts";
import { loadWebSearchConfig, resolveConfiguredLlm } from "./config.ts";
import { formatResult, formatUrlContextResult } from "./format.ts";
import { i18n } from "./i18n.ts";
import { describeModel, getUrlContextModel } from "./utils.ts";

export const UrlContextSchema = Type.Object({
  query: Type.String({ description: i18n.t("urlContext.query") }),
  urls: Type.Array(Type.String(), {
    description: i18n.t("urlContext.urls"),
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
    return formatResult(i18n.t("webSearch.error", { message: error instanceof Error ? error.message : String(error) }), {
      error: "invalid_config",
    });
  }

  const model = await getUrlContextModel(ctx, config);
  const transport = resolveConfiguredLlm(config)?.transport ?? "auto";
  const providerConfig = model ? getConfig(model, transport) : undefined;
  const isVertexExpress = transport === "vertex-express";

  if (!model || !isGoogleDeveloperModel(model) || providerConfig?.kind !== "google") {
    const current = ctx.model ? describeModel(ctx.model) : i18n.t("llm.noModel");
    return formatResult(i18n.t("urlContext.unsupported", { model: current }), {
      error: "unsupported_provider",
      model: current,
      supportedTransports: ["google-developer", "vertex-express"],
      grounded: false,
    });
  }

  onUpdate?.({
    content: [{ type: "text", text: i18n.t("urlContext.analyzing", { count: params.urls.length }) }],
    details: {},
  });

  try {
    const youtubeUrls = params.urls.filter(isYouTubeUrl);
    const otherUrls = params.urls.filter((url) => !isYouTubeUrl(url));
    if (youtubeUrls.length > 1) {
      return formatResult(i18n.t("urlContext.singleYouTube"), {
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
    if (otherUrls.length > 0) prompt += `\n\n${i18n.t("llm.urlsHeading")}\n${otherUrls.join("\n")}`;
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
    return formatResult(i18n.t("webSearch.error", { message: error instanceof Error ? error.message : String(error) }), {
      error: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
