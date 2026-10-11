import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach, type TestContext } from "node:test";
import { InMemoryCredentialStore, type Api, type Credential, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callApiStream, getConfig, getProviderKind, isGoogleUrlContextModel } from "../src/api.ts";
import { getAuth, resolveAzureDeploymentName, resolveAzureResponsesUrl, type ResolvedAuth } from "../src/providers/auth.ts";
import { getWebSearchModel, isSupportedSearchModel } from "../src/utils.ts";
import { urlContext } from "../src/url_context.ts";
import { webSearch } from "../src/web_search.ts";
import type { WebSearchConfig } from "../src/config.ts";

// Every SDK registry uses memory credentials, no models.json, and no catalog refresh.
// The env/config sandbox also prevents compat/ADC/legacy config reads from using user secrets.
const envNames = [
  "HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "PI_WEB_SEARCH_CONFIG", "PI_OFFLINE",
  "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "COPILOT_GITHUB_TOKEN", "OPENCODE_API_KEY",
  "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
];

beforeEach(async (t: TestContext) => {
  const previous = new Map(envNames.map((name) => [name, process.env[name]]));
  const dir = await mkdtemp(join(tmpdir(), "pi-transport-auth-"));
  for (const name of envNames) delete process.env[name];
  process.env.HOME = join(dir, "home");
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  process.env.PI_WEB_SEARCH_CONFIG = join(dir, "web-search.json");
  process.env.PI_OFFLINE = "1";
  await writeFile(process.env.PI_WEB_SEARCH_CONFIG, "{}");
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in offline auth test"); });
  t.after(async () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
});

async function registry(credentials: Record<string, Credential> = {}) {
  const store = new InMemoryCredentialStore();
  for (const [provider, credential] of Object.entries(credentials)) {
    await store.modify(provider, async () => credential);
  }
  const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  return { registry: new ModelRegistry(runtime), runtime, store };
}

function modelFor(registry: ModelRegistry, provider: string, api?: Api): Model<Api> {
  const model = registry.getAll().find((model) => model.provider === provider && (!api || model.api === api));
  assert.ok(model, `SDK catalog must include ${provider}/${api ?? "any"}`);
  return model;
}

function context(registry: ModelRegistry, model?: Model<Api>, sessionId = "fixture-session"): ExtensionContext {
  return { model, modelRegistry: registry, sessionManager: { getSessionId: () => sessionId } } as ExtensionContext;
}

function sse(...events: Array<Record<string, unknown>>) {
  return new Response(events.map((event) => `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

const prompt = { contents: [{ role: "user", parts: [{ text: "fixture question" }] }] };
function googleResponse() {
  return sse({ candidates: [{ content: { role: "model", parts: [{ text: "fixture answer" }] }, finishReason: "STOP" }] });
}
function openaiResponse() {
  return sse(
    { type: "response.output_text.delta", delta: "fixture answer" },
    { type: "response.completed", response: { id: "fixture-response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  );
}
function anthropicResponse() {
  return sse(
    { type: "message_start", message: { id: "fixture-message", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "fixture answer" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  );
}

async function config(value: WebSearchConfig) {
  await writeFile(process.env.PI_WEB_SEARCH_CONFIG!, JSON.stringify(value));
}

function successful(auth: ResolvedAuth): Extract<ResolvedAuth, { ok: true }> {
  if (auth.ok === false) assert.fail(auth.error);
  return auth;
}

function mockFetch(t: TestContext, run: (url: string, headers: Headers, body: any) => Response | Promise<Response>) {
  return t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    return run(String(input), new Headers(init?.headers), JSON.parse(String(init?.body)));
  });
}

test("OpenCode Zen and Go auth adds session headers across all supported SDK APIs", async (t) => {
  const { registry: reg } = await registry({
    opencode: { type: "api_key", key: "fixture-zen-key" },
    "opencode-go": { type: "api_key", key: "fixture-go-key" },
  });
  for (const provider of ["opencode", "opencode-go"]) {
    for (const model of reg.getAll().filter((model) => model.provider === provider && isSupportedSearchModel(model))) {
      const raw = successful(await reg.getApiKeyAndHeaders(model));
      assert.equal(new Headers(raw.headers as Record<string, string>).has("x-opencode-session"), false);
      const auth = successful(await getAuth(context(reg, model), model));
      const headers = new Headers(auth.headers as Record<string, string>);
      assert.equal(headers.get("x-opencode-session"), "fixture-session");
      assert.equal(headers.get("x-opencode-client"), "pi");
      assert.equal(auth.apiKey, raw.apiKey);
    }
  }
  for (const api of ["anthropic-messages", "google-generative-ai", "openai-responses"] as const) {
    const model = modelFor(reg, "opencode", api);
    let calls = 0;
    mockFetch(t, (_url, headers) => {
      calls++;
      assert.equal(headers.get("x-opencode-session"), "fixture-session");
      return api === "anthropic-messages" ? anthropicResponse() : api === "google-generative-ai" ? googleResponse() : openaiResponse();
    });
    await callApiStream(context(reg, model), model, prompt);
    assert.equal(calls, 1);
  }
});

test("OpenCode headers preserve case-insensitive overrides and never fabricate a session", async () => {
  const { registry: reg } = await registry({ opencode: { type: "api_key", key: "fixture-key" } });
  const base = modelFor(reg, "opencode", "anthropic-messages");
  const model = { ...base, headers: { "X-OpenCode-Session": "explicit-session", "X-OpenCode-Client": "explicit-client" } };
  const auth = successful(await getAuth(context(reg, model), model));
  assert.deepEqual(auth.headers, model.headers);
  const without = successful(await getAuth(context(reg, base, ""), base));
  assert.equal(new Headers(without.headers as Record<string, string>).has("x-opencode-session"), false);
  assert.equal(new Headers(without.headers as Record<string, string>).has("x-opencode-client"), false);
  const alias = { ...base, provider: "custom-gateway" };
  assert.equal(successful(await getAuth(context(reg, alias), alias)).headers?.["x-opencode-session"], "fixture-session");
  const notOpenCode = { ...alias, baseUrl: "https://opencode.ai.example.com/v1" };
  assert.equal(successful(await getAuth(context(reg, notOpenCode), notOpenCode)).headers?.["x-opencode-session"], undefined);
});

test("Copilot Anthropic OAuth auth matches the SDK Bearer contract without x-api-key", async (t) => {
  const token = "tid=fixture;exp=9999999999;proxy-ep=proxy.business.githubcopilot.com;";
  const { registry: reg } = await registry({
    "github-copilot": { type: "oauth", access: token, refresh: "fixture-refresh", expires: Date.now() + 3_600_000 },
  });
  const model = modelFor(reg, "github-copilot", "anthropic-messages");
  const raw = successful(await reg.getApiKeyAndHeaders(model));
  assert.equal(raw.apiKey, token);
  assert.equal(raw.baseUrl, "https://api.business.githubcopilot.com");
  const auth = successful(await getAuth(context(reg, model), model));
  assert.equal(auth.apiKey, undefined);
  assert.equal(auth.headers?.Authorization, `Bearer ${token}`);
  assert.equal(auth.baseUrl, raw.baseUrl);
  let calls = 0;
  mockFetch(t, (url, headers) => {
    calls++;
    const endpoint = new URL(url);
    assert.equal(endpoint.origin + endpoint.pathname, "https://api.business.githubcopilot.com/v1/messages");
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.has("x-api-key"), false);
    return anthropicResponse();
  });
  await callApiStream(context(reg, model), model, prompt);
  // Compare with the actual provider client, not an invented registry fixture.
  const sdkResult = await reg.streamSimple(model, { messages: [{ role: "user", content: "fixture question", timestamp: 0 }] }).result();
  assert.equal(sdkResult.stopReason, "stop", sdkResult.errorMessage);
  assert.equal(calls, 2);
});

test("Copilot Anthropic API tokens and explicit Authorization remain header-owned", async (t) => {
  const { registry: reg } = await registry({ "github-copilot": { type: "api_key", key: "fixture-copilot-token" } });
  const base = modelFor(reg, "github-copilot", "anthropic-messages");
  for (const model of [base, { ...base, headers: { aUtHoRiZaTiOn: "Bearer explicit-token" } }]) {
    mockFetch(t, (_url, headers) => {
      assert.equal(headers.get("authorization"), model.headers?.aUtHoRiZaTiOn ?? "Bearer fixture-copilot-token");
      assert.equal(headers.has("x-api-key"), false);
      return anthropicResponse();
    });
    await callApiStream(context(reg, model), model, prompt);
    assert.equal(successful(await getAuth(context(reg, model), model)).apiKey, undefined);
  }
});

test("Copilot OpenAI preserves its token and credential-specific endpoint", async (t) => {
  const { registry: reg } = await registry({
    "github-copilot": { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000, enterpriseUrl: "fixture.ghe.com" },
  });
  const model = modelFor(reg, "github-copilot", "openai-responses");
  const auth = successful(await getAuth(context(reg, model), model));
  assert.equal(auth.apiKey, "fixture-access");
  assert.equal(auth.baseUrl, "https://copilot-api.fixture.ghe.com");
  mockFetch(t, (url, headers) => {
    assert.equal(url, "https://copilot-api.fixture.ghe.com/responses");
    assert.equal(headers.get("authorization"), "Bearer fixture-access");
    assert.equal(headers.has("x-api-key"), false);
    return openaiResponse();
  });
  await callApiStream(context(reg, model), model, prompt);
});

test("Azure native empty baseUrl uses env endpoint and api-key, matching Azure SDK requests", async (t) => {
  process.env.AZURE_OPENAI_API_KEY = "fixture-azure-env-key";
  process.env.AZURE_OPENAI_BASE_URL = "https://fixture-resource.ai.azure.com/";
  const { registry: reg } = await registry();
  const model = modelFor(reg, "azure-openai-responses");
  assert.equal(model.baseUrl, "");
  const raw = successful(await reg.getApiKeyAndHeaders(model));
  assert.equal(raw.baseUrl, undefined);
  const auth = successful(await getAuth(context(reg, model), model));
  assert.equal(auth.apiKey, undefined);
  assert.equal(auth.headers?.["api-key"], "fixture-azure-env-key");
  assert.equal(auth.baseUrl, "https://fixture-resource.ai.azure.com/openai/v1");
  let calls = 0;
  mockFetch(t, (url, headers, body) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://fixture-resource.ai.azure.com/openai/v1/responses");
    assert.equal(parsed.searchParams.get("api-version"), "v1");
    assert.equal(headers.get("api-key"), "fixture-azure-env-key");
    assert.equal(headers.has("authorization"), false);
    assert.equal(body.model, model.id);
    return openaiResponse();
  });
  await callApiStream(context(reg, model), model, prompt);
  const sdkResult = await reg.streamSimple(model, { messages: [{ role: "user", content: "fixture question", timestamp: 0 }] }).result();
  assert.equal(sdkResult.stopReason, "stop");
  assert.equal(calls, 2);
});

test("Azure resource name, scoped env, version and deployment map work end-to-end", async (t) => {
  process.env.AZURE_OPENAI_RESOURCE_NAME = "ambient-resource";
  process.env.AZURE_OPENAI_API_VERSION = "ambient-version";
  const { registry: reg } = await registry({
    "azure-openai-responses": { type: "api_key", key: "fixture-stored-key", env: {
      AZURE_OPENAI_RESOURCE_NAME: "scoped-resource",
      AZURE_OPENAI_API_VERSION: "2026-01-01-preview",
    } },
  });
  const model = modelFor(reg, "azure-openai-responses");
  process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = `ignored=x, ${model.id}=fixture-deployment, malformed`;
  mockFetch(t, (url, headers, body) => {
    assert.equal(url, "https://scoped-resource.openai.azure.com/openai/v1/responses?api-version=2026-01-01-preview");
    assert.equal(headers.get("api-key"), "fixture-stored-key");
    assert.equal(headers.has("authorization"), false);
    assert.equal(body.model, "fixture-deployment");
    return openaiResponse();
  });
  await callApiStream(context(reg, model), model, prompt);
});

test("Azure normalizes all SDK Azure hosts while explicit auth/model URLs beat env defaults", async () => {
  process.env.AZURE_OPENAI_BASE_URL = "https://ambient.openai.azure.com";
  const { registry: reg } = await registry({ "azure-openai-responses": { type: "api_key", key: "fixture-key" } });
  const base = modelFor(reg, "azure-openai-responses");
  for (const suffix of ["openai.azure.com", "cognitiveservices.azure.com", "ai.azure.com"]) {
    for (const path of ["/", "/openai/", "/openai/v1/responses"]) {
      const model = { ...base, baseUrl: `https://explicit.${suffix}${path}` };
      const auth = successful(await getAuth(context(reg, model), model));
      assert.equal(resolveAzureResponsesUrl(model, auth), `https://explicit.${suffix}/openai/v1/responses?api-version=v1`);
    }
  }
  const auth = { ok: true as const, baseUrl: "https://provider.example.com/custom/?tenant=fixture", env: {
    AZURE_OPENAI_BASE_URL: "https://scoped.openai.azure.com",
    AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${base.id}=scoped-deployment`,
  } };
  const model = { ...base, baseUrl: "https://model.example.com/v1" };
  assert.equal(resolveAzureResponsesUrl(model, auth), "https://provider.example.com/custom/responses?tenant=fixture&api-version=v1");
  assert.equal(resolveAzureDeploymentName(model, auth), "scoped-deployment");
});

test("Azure explicit api-key and Bearer headers are not overwritten or duplicated", async (t) => {
  process.env.AZURE_OPENAI_RESOURCE_NAME = "fixture-resource";
  const { registry: reg } = await registry({ "azure-openai-responses": { type: "api_key", key: "fixture-key" } });
  const base = modelFor(reg, "azure-openai-responses");
  for (const headers of [{ "API-Key": "explicit-key" }, { aUtHoRiZaTiOn: "Bearer explicit-token" }]) {
    const model = { ...base, headers };
    mockFetch(t, (_url, actual) => {
      if (headers["API-Key"]) {
        assert.equal(actual.get("api-key"), "explicit-key");
        assert.equal(actual.has("authorization"), false);
      } else {
        assert.equal(actual.get("authorization"), "Bearer explicit-token");
        assert.equal(actual.has("api-key"), false);
      }
      return openaiResponse();
    });
    await callApiStream(context(reg, model), model, prompt);
  }
});

test("Azure missing/invalid endpoint errors are explicit invalid requests before fetch", async () => {
  const { registry: reg } = await registry({ "azure-openai-responses": { type: "api_key", key: "fixture-key" } });
  const model = modelFor(reg, "azure-openai-responses");
  await assert.rejects(getAuth(context(reg, model), model), /Invalid request: Azure OpenAI base URL is required/);
  process.env.AZURE_OPENAI_BASE_URL = "not a URL";
  await assert.rejects(getAuth(context(reg, model), model), /Invalid request: Invalid Azure OpenAI base URL/);
});

test("Google, OpenAI and Anthropic ordinary API key auth keep their wire conventions", async (t) => {
  const { registry: reg } = await registry({
    google: { type: "api_key", key: "fixture-google-key" },
    openai: { type: "api_key", key: "fixture-openai-key" },
    anthropic: { type: "api_key", key: "fixture-anthropic-key" },
  });
  for (const provider of ["google", "openai", "anthropic"]) {
    const model = modelFor(reg, provider);
    assert.equal(successful(await getAuth(context(reg, model), model)).apiKey, `fixture-${provider}-key`);
    mockFetch(t, (_url, headers) => {
      assert.equal(headers.has("x-opencode-session"), false);
      if (provider === "google") {
        assert.equal(headers.get("x-goog-api-key"), "fixture-google-key");
        assert.equal(headers.has("authorization"), false);
        return googleResponse();
      }
      if (provider === "anthropic") {
        assert.equal(headers.get("x-api-key"), "fixture-anthropic-key");
        assert.equal(headers.has("authorization"), false);
        return anthropicResponse();
      }
      assert.equal(headers.get("authorization"), "Bearer fixture-openai-key");
      assert.equal(headers.has("x-api-key"), false);
      return openaiResponse();
    });
    await callApiStream(context(reg, model), model, prompt);
  }
});

test("registry credential failure never falls back to an env API key", async (t) => {
  process.env.OPENAI_API_KEY = "fixture-env-key";
  const { registry: reg, store } = await registry();
  t.mock.method(store, "read", async () => { throw new Error("fixture credential storage failure"); });
  const model = modelFor(reg, "openai");
  const raw = await reg.getApiKeyAndHeaders(model);
  assert.equal(raw.ok, false);
  assert.deepEqual(await getAuth(context(reg, model), model), raw);
});

test("header-only registry auth skips env fallback; compatibility empty success uses scoped env", async (t) => {
  process.env.AZURE_OPENAI_RESOURCE_NAME = "fixture-resource";
  process.env.AZURE_OPENAI_API_KEY = "fixture-ambient-key";
  const { registry: reg } = await registry();
  const model = modelFor(reg, "azure-openai-responses");
  // These are legal ResolvedRequestAuth shapes from the actual SDK facade.
  t.mock.method(reg, "getApiKeyAndHeaders", async (): Promise<ResolvedAuth> => ({ ok: true, headers: { "API-Key": "fixture-header-key" } }));
  assert.deepEqual(successful(await getAuth(context(reg, model), model)).headers, { "API-Key": "fixture-header-key" });
  t.mock.method(reg, "getApiKeyAndHeaders", async (): Promise<ResolvedAuth> => ({ ok: true, env: { AZURE_OPENAI_API_KEY: "fixture-scoped-key" } }));
  assert.equal(successful(await getAuth(context(reg, model), model)).headers?.["api-key"], "fixture-scoped-key");
});

test("Vertex models are supported only by explicit Express, with transport-aware selection", async () => {
  const { registry: reg } = await registry({ "google-vertex": { type: "api_key", key: "fixture-vertex-key" } });
  const vertex = modelFor(reg, "google-vertex");
  const google = modelFor(reg, "google");
  const anthropic = modelFor(reg, "anthropic");
  for (const transport of ["auto", "google-developer", "vertex-express"] as const) {
    const supported = transport === "vertex-express";
    assert.equal(isSupportedSearchModel(vertex, transport), supported);
    assert.equal(isGoogleUrlContextModel(vertex, transport), supported);
    assert.equal(getProviderKind(vertex, transport), supported ? "google" : "unsupported");
    assert.equal(await getWebSearchModel(context(reg, vertex), { llm: { transport } }), supported ? vertex : undefined);
    assert.equal(await getWebSearchModel(context(reg, anthropic), { llm: { provider: "google-vertex", model: vertex.id, transport } }), supported ? vertex : undefined);
    assert.equal(isGoogleUrlContextModel(google, transport), true);
    assert.equal(isSupportedSearchModel(anthropic, transport), true);
    assert.equal(isGoogleUrlContextModel(anthropic, transport), false);
  }
  assert.equal(getConfig(vertex).buildRequest, undefined);
  assert.ok(getConfig(vertex, "vertex-express").buildRequest);
});

test("Google Vertex API key Express web search and URL context use the raw Express endpoint", async (t) => {
  process.env.GOOGLE_CLOUD_API_KEY = "fixture-vertex-env-key";
  const { registry: reg } = await registry();
  const model = modelFor(reg, "google-vertex");
  await config({ mode: "llm", llm: { provider: model.provider, model: model.id, transport: "vertex-express" } });
  let calls = 0;
  mockFetch(t, (url, headers, body) => {
    calls++;
    assert.equal(url, `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`);
    assert.equal(headers.get("x-goog-api-key"), "fixture-vertex-env-key");
    assert.equal(headers.has("authorization"), false);
    if (calls === 1) assert.deepEqual(body.tools, [{ googleSearch: {} }]);
    else {
      assert.deepEqual(body.tools, [{ urlContext: {} }]);
      assert.deepEqual(body.contents[0].parts[0], { fileData: { fileUri: "https://youtu.be/dQw4w9WgXcQ", mimeType: "video/mp4" } });
    }
    return googleResponse();
  });
  const search = await webSearch("fixture", { query: "question", mode: "llm" }, new AbortController().signal, undefined, context(reg, model));
  assert.equal(search.details.error, undefined);
  assert.equal(search.details.modeUsed, "llm");
  const url = await urlContext("fixture", { query: "read video", urls: ["https://youtu.be/dQw4w9WgXcQ"] }, new AbortController().signal, undefined, context(reg, model));
  assert.equal(url.details.error, undefined);
  assert.equal(calls, 2);
});

test("Vertex stored API keys override env keys, but never auto-select Express", async (t) => {
  process.env.GOOGLE_CLOUD_API_KEY = "fixture-ambient-key";
  const { registry: reg } = await registry({ "google-vertex": { type: "api_key", key: "fixture-stored-key" } });
  const model = modelFor(reg, "google-vertex");
  assert.equal(successful(await getAuth(context(reg, model), model)).apiKey, "fixture-stored-key");
  await assert.rejects(callApiStream(context(reg, model), model, prompt), /does not support LLM web search/);
  let calls = 0;
  mockFetch(t, (_url, headers) => {
    calls++;
    assert.equal(headers.get("x-goog-api-key"), "fixture-stored-key");
    return googleResponse();
  });
  await callApiStream(context(reg, model), model, prompt, undefined, undefined, undefined, "vertex-express");
  assert.equal(calls, 1);
});

test("Vertex Express rejects SDK ADC auth and compat sentinels without probing real credential files", async (t) => {
  // The provider resolves ADC as auth:{}, never an OAuth bearer token. A local fake ADC
  // marker is enough for the SDK's fileExists check; no credential file contents are read.
  const adcFile = join(process.env.HOME!, "..", "adc.json");
  await writeFile(adcFile, "{}");
  const { registry: reg } = await registry({ "google-vertex": { type: "api_key", env: {
    GOOGLE_APPLICATION_CREDENTIALS: adcFile, GOOGLE_CLOUD_PROJECT: "fixture-project", GOOGLE_CLOUD_LOCATION: "global",
  } } });
  const model = modelFor(reg, "google-vertex");
  const raw = successful(await reg.getApiKeyAndHeaders(model));
  assert.equal(raw.apiKey, undefined);
  const auth = await getAuth(context(reg, model), model);
  assert.equal(auth.ok, false);
  if (!auth.ok) assert.match(auth.error, /Vertex Express requires a Google Cloud API key.*ADC/);
  await assert.rejects(callApiStream(context(reg, model), model, prompt, undefined, undefined, undefined, "vertex-express"), /Vertex Express requires/);
  t.mock.method(reg, "getApiKeyAndHeaders", async (): Promise<ResolvedAuth> => ({ ok: true, apiKey: "<authenticated>" }));
  assert.equal((await getAuth(context(reg, model), model)).ok, false);
});

test("Vertex Express permits an explicit x-goog-api-key without a registry apiKey", async (t) => {
  const { registry: reg } = await registry();
  const model = { ...modelFor(reg, "google-vertex"), headers: { "X-Goog-Api-Key": "fixture-header-key" } };
  mockFetch(t, (_url, headers) => {
    assert.equal(headers.get("x-goog-api-key"), "fixture-header-key");
    return googleResponse();
  });
  await callApiStream(context(reg, model), model, prompt, undefined, undefined, undefined, "vertex-express");
});

test("configured missing model errors are invalid-request and cannot silently fall back to API", async () => {
  const { registry: reg } = await registry({ google: { type: "api_key", key: "fixture-google-key" } });
  const current = modelFor(reg, "google");
  for (const id of ["missing-gemini", "unsupported-missing", "401-api-key-missing", "abort-missing"]) {
    const value: WebSearchConfig = { mode: "auto", fallbackOn: ["unsupported", "quota"],
      llm: { provider: "google", model: id }, api: { provider: "brave", apiKeys: { brave: "fixture-brave-key" } } };
    await assert.rejects(getWebSearchModel(context(reg, current), value), new RegExp(`Invalid request: Configured LLM model not found: google/${id}`));
    await config(value);
    const search = await webSearch("fixture", { query: "question" }, new AbortController().signal, undefined, context(reg, current));
    assert.equal(search.details.error.kind, "invalid-request");
    assert.equal(search.details.error.stage, "llm");
    assert.equal(search.details.modeUsed, undefined);
    const url = await urlContext("fixture", { query: "read", urls: ["https://example.com"] }, new AbortController().signal, undefined, context(reg, current));
    assert.equal(url.details.error, "invalid_request");
  }
});
