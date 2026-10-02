import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getProviderKind } from "./api.ts";
import type { WebSearchConfig } from "./config.ts";
import { resolveConfiguredLlm } from "./config.ts";

export function isSupportedSearchModel(model: Model<Api> | undefined): model is Model<Api> {
  if (!model) return false;
  return getProviderKind(model) !== "unsupported";
}

export function describeModel(model: Model<Api>): string {
  return `${model.id} (${model.provider}/${model.api})`;
}

export async function getModel(ctx: ExtensionContext): Promise<Model<Api> | undefined> {
  return isSupportedSearchModel(ctx.model) ? ctx.model : undefined;
}

export async function getWebSearchModel(
  ctx: ExtensionContext,
  config: WebSearchConfig,
): Promise<Model<Api> | undefined> {
  const configured = resolveConfiguredLlm(config);
  if (configured?.provider && configured.model) {
    const model = ctx.modelRegistry.find(configured.provider, configured.model);
    return isSupportedSearchModel(model) ? model : undefined;
  }
  return getModel(ctx);
}

export async function getUrlContextModel(
  ctx: ExtensionContext,
  config: WebSearchConfig,
): Promise<Model<Api> | undefined> {
  return getWebSearchModel(ctx, config);
}

