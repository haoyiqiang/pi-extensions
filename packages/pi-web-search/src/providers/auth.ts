import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";

export type ResolvedAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;

function hasAuthHeader(headers?: Record<string, string>): boolean {
  if (!headers) return false;
  return Object.entries(headers).some(([name, value]) => {
    if (!value) return false;
    const normalized = name.toLowerCase();
    return normalized === "authorization" || normalized === "x-api-key" || normalized === "x-goog-api-key";
  });
}

/** Resolve auth from Pi's model registry, then mirror pi-ai's env-key fallback for raw fetch calls. */
export async function getAuth(ctx: ExtensionContext, model: Model<Api>): Promise<ResolvedAuth> {
  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!resolved.ok) return resolved;
  if (resolved.apiKey || hasAuthHeader(resolved.headers)) return resolved;
  const apiKey = getEnvApiKey(model.provider);
  return apiKey ? { ...resolved, apiKey } : resolved;
}
