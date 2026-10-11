import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";

export type ResolvedAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
type RequestAuth = Extract<ResolvedAuth, { ok: true }>;

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name.toLowerCase());
}

function hasAuthHeader(headers?: ProviderHeaders): boolean {
  return Object.entries(headers ?? {}).some(([name, value]) => value && [
    "authorization", "api-key", "x-api-key", "x-goog-api-key",
  ].includes(name.toLowerCase()));
}

function providerEnv(auth: RequestAuth, name: string): string | undefined {
  return auth.env?.[name] || process.env[name] || undefined;
}

function isOpenCodeModel(model: Model<Api>): boolean {
  if (model.provider === "opencode" || model.provider === "opencode-go") return true;
  try {
    return new URL(model.baseUrl).hostname === "opencode.ai";
  } catch {
    return false;
  }
}

function resolveAzureBaseUrl(model: Model<Api>, auth: RequestAuth): string {
  const resource = providerEnv(auth, "AZURE_OPENAI_RESOURCE_NAME");
  // Explicit auth/model endpoints take precedence over ambient Azure defaults.
  const baseUrl = auth.baseUrl?.trim() || model.baseUrl?.trim()
    || providerEnv(auth, "AZURE_OPENAI_BASE_URL")?.trim()
    || (resource ? `https://${resource}.openai.azure.com/openai/v1` : undefined);
  if (!baseUrl) {
    throw new Error("Invalid request: Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or configure model.baseUrl.");
  }
  let url: URL;
  try {
    url = new URL(baseUrl.replace(/\/+$/, ""));
  } catch {
    throw new Error(`Invalid request: Invalid Azure OpenAI base URL: ${baseUrl}`);
  }
  const isAzureHost = [".openai.azure.com", ".cognitiveservices.azure.com", ".ai.azure.com"]
    .some((suffix) => url.hostname.endsWith(suffix));
  const path = url.pathname.replace(/\/+$/, "");
  if (isAzureHost && ["", "/openai", "/openai/v1/responses"].includes(path)) {
    url.pathname = "/openai/v1";
    url.search = "";
  }
  return url.toString().replace(/\/+$/, "");
}

/** Raw Responses requests bypass AzureOpenAI's endpoint/query preparation. */
export function resolveAzureResponsesUrl(model: Model<Api>, auth: RequestAuth): string {
  const url = new URL(resolveAzureBaseUrl(model, auth));
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
  url.searchParams.set("api-version", providerEnv(auth, "AZURE_OPENAI_API_VERSION") || "v1");
  return url.toString();
}

export function resolveAzureDeploymentName(model: Model<Api>, auth: RequestAuth): string {
  const entries = providerEnv(auth, "AZURE_OPENAI_DEPLOYMENT_NAME_MAP")?.split(",") ?? [];
  const names = new Map(entries.flatMap((entry) => {
    const [id, name] = entry.trim().split("=", 2);
    return id && name ? [[id.trim(), name.trim()] as const] : [];
  }));
  return names.get(model.id) || model.id;
}

/** Resolve registry auth, then supply provider defaults normally added by Pi's SDK stream layer. */
export async function getAuth(ctx: ExtensionContext, model: Model<Api>): Promise<ResolvedAuth> {
  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!resolved.ok) return resolved; // Never hide a credential/refresh failure with an env key.
  let auth = resolved;
  if (!auth.apiKey && !hasAuthHeader(auth.headers)) {
    // Compat getEnvApiKey returns an ADC sentinel for Vertex and probes credential files.
    // Express accepts only a real API key; do not invoke that ambient-auth fallback.
    const apiKey = model.provider === "google-vertex"
      ? providerEnv(auth, "GOOGLE_CLOUD_API_KEY")
      : getEnvApiKey(model.provider, auth.env);
    if (apiKey) auth = { ...auth, apiKey };
  }
  const headers = { ...auth.headers };
  if (isOpenCodeModel(model)) {
    const sessionId = ctx.sessionManager?.getSessionId();
    if (sessionId) {
      if (!hasHeader(headers, "x-opencode-session")) headers["x-opencode-session"] = sessionId;
      if (!hasHeader(headers, "x-opencode-client")) headers["x-opencode-client"] = "pi";
    }
  }
  if (model.provider === "github-copilot" && model.api === "anthropic-messages") {
    if (auth.apiKey && !hasHeader(headers, "authorization")) headers.Authorization = `Bearer ${auth.apiKey}`;
    // Anthropic's generic API-key path must not also send this Copilot token as x-api-key.
    return { ...auth, apiKey: undefined, headers };
  }
  if (model.api === "azure-openai-responses") {
    if (auth.apiKey && !hasAuthHeader(headers) && !hasHeader(headers, "api-key")) headers["api-key"] = auth.apiKey;
    return { ...auth, apiKey: undefined, headers, baseUrl: resolveAzureBaseUrl(model, auth) };
  }
  if (model.api === "google-vertex" || model.provider === "google-vertex") {
    const headerKey = Object.entries(headers).some(([name, value]) => name.toLowerCase() === "x-goog-api-key" && !!value);
    if ((!auth.apiKey || auth.apiKey === "<authenticated>") && !headerKey) {
      return { ok: false, error: "Vertex Express requires a Google Cloud API key. Application Default Credentials (ADC) are not supported by this raw transport." };
    }
    if (auth.apiKey === "<authenticated>") auth = { ...auth, apiKey: undefined };
  }
  return { ...auth, ...(Object.keys(headers).length ? { headers } : {}) };
}
