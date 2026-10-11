import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getProviderKind } from "./api.ts";
import type { LlmTransport, WebSearchConfig } from "./config.ts";
import { resolveConfiguredLlm } from "./config.ts";

export function isSupportedSearchModel(model: Model<Api> | undefined, transport: LlmTransport = "auto"): model is Model<Api> {
  if (!model) return false;
  return getProviderKind(model, transport) !== "unsupported";
}

export function describeModel(model: Model<Api>): string {
  return `${model.id} (${model.provider}/${model.api})`;
}

export async function getModel(ctx: ExtensionContext, transport: LlmTransport = "auto"): Promise<Model<Api> | undefined> {
  return isSupportedSearchModel(ctx.model, transport) ? ctx.model : undefined;
}

export async function getWebSearchModel(
  ctx: ExtensionContext,
  config: WebSearchConfig,
): Promise<Model<Api> | undefined> {
  const configured = resolveConfiguredLlm(config);
  const transport = configured?.transport ?? "auto";
  if (configured?.provider && configured.model) {
    const model = ctx.modelRegistry.find(configured.provider, configured.model);
    if (!model) {
      throw new Error(`Invalid request: Configured LLM model not found: ${configured.provider}/${configured.model}. Check llm.provider and llm.model.`);
    }
    return isSupportedSearchModel(model, transport) ? model : undefined;
  }
  return getModel(ctx, transport);
}

export async function getUrlContextModel(
  ctx: ExtensionContext,
  config: WebSearchConfig,
): Promise<Model<Api> | undefined> {
  return getWebSearchModel(ctx, config);
}

