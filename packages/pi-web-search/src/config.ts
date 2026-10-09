import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ApiSearchProviderName, FallbackReason, WebSearchMode } from "./types.ts";
import { FALLBACK_REASONS, WEB_SEARCH_MODES } from "./types.ts";

export type LlmTransport = "auto" | "google-developer" | "vertex-express";

export interface LlmSearchConfig {
  provider?: string;
  model?: string;
  transport?: LlmTransport;
}

export interface ApiSearchConfig {
  provider?: ApiSearchProviderName;
  apiKeys?: Partial<Record<ApiSearchProviderName, string>>;
  baseUrls?: Partial<Record<ApiSearchProviderName, string>>;
}

export interface GitHubInterceptorConfig {
  enabled?: boolean;
  maxRepoSizeMB?: number;
  cloneTimeoutSeconds?: number;
  clonePath?: string;
}

export interface InterceptorsConfig {
  github?: boolean | GitHubInterceptorConfig;
}

export interface WebSearchConfig {
  mode?: WebSearchMode;
  fallbackOn?: FallbackReason[];
  llm?: LlmSearchConfig;
  api?: ApiSearchConfig;
  interceptors?: InterceptorsConfig;
}

export interface LoadedWebSearchConfig {
  path: string;
  config: WebSearchConfig;
}

export interface SaveWebSearchConfigResult {
  ok: boolean;
  path: string;
  error?: string;
}

export class WebSearchConfigError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.name = "WebSearchConfigError";
    this.path = path;
  }
}

const API_PROVIDERS = new Set<ApiSearchProviderName>([
  "brave",
  "tavily",
  "serper",
  "exa",
  "youcom",
  "jina",
  "firecrawl",
  "perplexity",
  "searxng",
  "ollama",
]);
const LLM_TRANSPORTS = new Set<LlmTransport>(["auto", "google-developer", "vertex-express"]);

export function getWebSearchConfigPath(): string {
  const explicit = process.env.PI_WEB_SEARCH_CONFIG?.trim();
  return explicit || join(getAgentDir(), "web-search.json");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function getLegacyRpivConfigPaths(): string[] {
  const fallback = join(homedir(), ".config", "rpiv-web-tools", "config.json");
  const configured = process.env.XDG_CONFIG_HOME?.trim();
  if (!configured) return [fallback];
  const expanded = expandHome(configured);
  if (!isAbsolute(expanded)) return [fallback];
  const preferred = join(expanded, "rpiv-web-tools", "config.json");
  return preferred === fallback ? [fallback] : [preferred, fallback];
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalPositiveNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a number greater than 0.`);
  }
  return value;
}

function parseGitHubInterceptor(value: unknown, label: string): boolean | GitHubInterceptorConfig {
  if (typeof value === "boolean") return value;
  const github = expectObject(value, label);
  if (github.enabled !== undefined && typeof github.enabled !== "boolean") {
    throw new Error(`${`${label}.enabled`} must be a boolean.`);
  }
  return {
    enabled: github.enabled as boolean | undefined,
    maxRepoSizeMB: optionalPositiveNumber(github.maxRepoSizeMB, `${label}.maxRepoSizeMB`),
    cloneTimeoutSeconds: optionalPositiveNumber(github.cloneTimeoutSeconds, `${label}.cloneTimeoutSeconds`),
    clonePath: optionalString(github.clonePath, `${label}.clonePath`),
  };
}

function parseLlmConfig(value: unknown, label: string): LlmSearchConfig {
  const llm = expectObject(value, label);
  const transport = optionalString(llm.transport, `${label}.transport`) as LlmTransport | undefined;
  if (transport && !LLM_TRANSPORTS.has(transport)) {
    throw new Error("llm.transport must be auto, google-developer, or vertex-express.");
  }
  return {
    provider: optionalString(llm.provider, `${label}.provider`),
    model: optionalString(llm.model, `${label}.model`),
    transport,
  };
}

function parseConfig(raw: unknown): WebSearchConfig {
  const root = expectObject(raw, "config");
  const config: WebSearchConfig = {};

  if (root.mode !== undefined) {
    if (typeof root.mode !== "string" || !WEB_SEARCH_MODES.includes(root.mode as WebSearchMode)) {
      throw new Error("mode must be auto, llm, or api.");
    }
    config.mode = root.mode as WebSearchMode;
  }

  if (root.fallbackOn !== undefined) {
    if (!Array.isArray(root.fallbackOn)) throw new Error("fallbackOn must be an array.");
    const values = root.fallbackOn.map((value) => {
      if (typeof value !== "string" || !FALLBACK_REASONS.includes(value as FallbackReason)) {
        throw new Error(`Unsupported fallbackOn value: ${String(value)}`);
      }
      return value as FallbackReason;
    });
    config.fallbackOn = [...new Set(values)];
  }

  // `native` and top-level provider/model are read-only compatibility aliases.
  // Every loaded and saved config exposes the modern `llm` shape.
  if (root.llm !== undefined) {
    config.llm = parseLlmConfig(root.llm, "llm");
  } else if (root.native !== undefined) {
    config.llm = parseLlmConfig(root.native, "native");
  } else {
    const provider = optionalString(root.provider, "provider");
    const model = optionalString(root.model, "model");
    if (provider || model) config.llm = { provider, model, transport: "auto" };
  }

  if (root.api !== undefined) {
    const api = expectObject(root.api, "api");
    const provider = optionalString(api.provider, "api.provider") as ApiSearchProviderName | undefined;
    if (provider && !API_PROVIDERS.has(provider)) {
      throw new Error(`Unknown api.provider: ${provider}`);
    }
    const apiKeys = parseStringMap(api.apiKeys, "api.apiKeys");
    const baseUrls = parseStringMap(api.baseUrls, "api.baseUrls");
    config.api = { provider, apiKeys, baseUrls };
  }

  if (root.interceptors !== undefined) {
    const interceptors = expectObject(root.interceptors, "interceptors");
    config.interceptors = {
      github: interceptors.github === undefined
        ? undefined
        : parseGitHubInterceptor(interceptors.github, "interceptors.github"),
    };
  }

  return config;
}

function parseStringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const object = expectObject(value, label);
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry !== "string") {
      throw new Error(`${`${label}.${key}`} must be a string.`);
    }
    const trimmed = entry.trim();
    if (trimmed) output[key] = trimmed;
  }
  return output;
}

function parseLegacyStringMap(value: unknown): Partial<Record<ApiSearchProviderName, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Partial<Record<ApiSearchProviderName, string>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!API_PROVIDERS.has(key as ApiSearchProviderName) || typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed) output[key as ApiSearchProviderName] = trimmed;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

interface LegacyRpivConfig {
  api?: ApiSearchConfig;
  interceptors?: InterceptorsConfig;
}

function parseLegacyGitHubInterceptor(value: unknown): boolean | GitHubInterceptorConfig | undefined {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const output: GitHubInterceptorConfig = {};
  if (typeof root.enabled === "boolean") output.enabled = root.enabled;
  if (typeof root.maxRepoSizeMB === "number" && Number.isFinite(root.maxRepoSizeMB) && root.maxRepoSizeMB > 0) {
    output.maxRepoSizeMB = root.maxRepoSizeMB;
  }
  if (typeof root.cloneTimeoutSeconds === "number" && Number.isFinite(root.cloneTimeoutSeconds) && root.cloneTimeoutSeconds > 0) {
    output.cloneTimeoutSeconds = root.cloneTimeoutSeconds;
  }
  if (typeof root.clonePath === "string" && root.clonePath.trim()) output.clonePath = root.clonePath.trim();
  // As in rpiv-web-tools, object form itself opts in even when it only relies
  // on defaults.
  return output;
}

function loadLegacyRpivConfig(): LegacyRpivConfig | undefined {
  for (const path of getLegacyRpivConfigPaths()) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const root = parsed as Record<string, unknown>;
      const provider = typeof root.provider === "string" && API_PROVIDERS.has(root.provider as ApiSearchProviderName)
        ? root.provider as ApiSearchProviderName
        : undefined;
      const apiKeys = parseLegacyStringMap(root.apiKeys) ?? {};
      if (!apiKeys.brave && typeof root.apiKey === "string" && root.apiKey.trim()) {
        apiKeys.brave = root.apiKey.trim();
      }
      const baseUrls = parseLegacyStringMap(root.baseUrls);
      const api = provider || Object.keys(apiKeys).length > 0 || baseUrls
        ? {
            provider,
            apiKeys: Object.keys(apiKeys).length > 0 ? apiKeys : undefined,
            baseUrls,
          }
        : undefined;
      const legacyInterceptors = root.interceptors && typeof root.interceptors === "object" && !Array.isArray(root.interceptors)
        ? root.interceptors as Record<string, unknown>
        : undefined;
      const github = parseLegacyGitHubInterceptor(legacyInterceptors?.github);
      const interceptors = github === undefined ? undefined : { github };
      if (!api && !interceptors) return undefined;
      return { api, interceptors };
    } catch {
      // The original rpiv loader was fail-soft. Skip a stale malformed file so
      // a lower-priority legacy path can still provide a valid configuration.
      continue;
    }
  }
  return undefined;
}

function mergeApiConfig(legacy: ApiSearchConfig | undefined, current: ApiSearchConfig | undefined): ApiSearchConfig | undefined {
  if (!legacy) return current;
  if (!current) return legacy;
  return {
    provider: current.provider ?? legacy.provider,
    apiKeys: { ...(legacy.apiKeys ?? {}), ...(current.apiKeys ?? {}) },
    baseUrls: { ...(legacy.baseUrls ?? {}), ...(current.baseUrls ?? {}) },
  };
}

function mergeInterceptorsConfig(
  legacy: InterceptorsConfig | undefined,
  current: InterceptorsConfig | undefined,
): InterceptorsConfig | undefined {
  const github = current?.github ?? legacy?.github;
  return github === undefined ? undefined : { github };
}

export function loadWebSearchConfig(): LoadedWebSearchConfig {
  const path = getWebSearchConfigPath();
  const legacy = loadLegacyRpivConfig();
  if (!existsSync(path)) {
    return {
      path,
      config: {
        mode: "auto",
        fallbackOn: ["unsupported"],
        ...(legacy?.api ? { api: legacy.api } : {}),
        ...(legacy?.interceptors ? { interceptors: legacy.interceptors } : {}),
      },
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const config = parseConfig(parsed);
    return {
      path,
      config: {
        ...config,
        mode: config.mode ?? "auto",
        fallbackOn: config.fallbackOn ?? ["unsupported"],
        api: mergeApiConfig(legacy?.api, config.api),
        interceptors: mergeInterceptorsConfig(legacy?.interceptors, config.interceptors),
      },
    };
  } catch (error) {
    throw new WebSearchConfigError(path, error instanceof Error ? error.message : String(error));
  }
}

function compactStringMap(
  value: Partial<Record<ApiSearchProviderName, string>> | undefined,
): Partial<Record<ApiSearchProviderName, string>> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [ApiSearchProviderName, string] => (
    API_PROVIDERS.has(entry[0] as ApiSearchProviderName)
    && typeof entry[1] === "string"
    && entry[1].trim().length > 0
  ));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function serializableConfig(config: WebSearchConfig): WebSearchConfig {
  const apiKeys = compactStringMap(config.api?.apiKeys);
  const baseUrls = compactStringMap(config.api?.baseUrls);
  const llm = config.llm && (config.llm.provider || config.llm.model || config.llm.transport)
    ? {
        ...(config.llm.provider ? { provider: config.llm.provider } : {}),
        ...(config.llm.model ? { model: config.llm.model } : {}),
        ...(config.llm.transport ? { transport: config.llm.transport } : {}),
      }
    : undefined;
  const api = config.api && (config.api.provider || apiKeys || baseUrls)
    ? {
        ...(config.api.provider ? { provider: config.api.provider } : {}),
        ...(apiKeys ? { apiKeys } : {}),
        ...(baseUrls ? { baseUrls } : {}),
      }
    : undefined;
  const github = config.interceptors?.github;
  const interceptors = github === undefined ? undefined : { github };
  return {
    mode: config.mode ?? "auto",
    fallbackOn: [...new Set<FallbackReason>(config.fallbackOn ?? ["unsupported"])],
    ...(llm ? { llm } : {}),
    ...(api ? { api } : {}),
    ...(interceptors ? { interceptors } : {}),
  };
}

export function saveWebSearchConfig(config: WebSearchConfig): SaveWebSearchConfigResult {
  const path = getWebSearchConfigPath();
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(serializableConfig(config), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
    return { ok: true, path };
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Keep the original write failure.
    }
    return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
  }
}

export function resolveConfiguredLlm(config: WebSearchConfig): LlmSearchConfig | undefined {
  return config.llm;
}

export function resolveApiProviderName(config: WebSearchConfig, override?: string): ApiSearchProviderName {
  const raw = override?.trim()
    || process.env.PI_WEB_SEARCH_API_PROVIDER?.trim()
    || process.env.WEB_SEARCH_PROVIDER?.trim()
    || config.api?.provider
    || "brave";
  if (!API_PROVIDERS.has(raw as ApiSearchProviderName)) {
    throw new Error(`Unknown API search provider: ${raw}`);
  }
  return raw as ApiSearchProviderName;
}

export function getKnownApiProviders(): ApiSearchProviderName[] {
  return [...API_PROVIDERS];
}
