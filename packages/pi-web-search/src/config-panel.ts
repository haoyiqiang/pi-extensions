import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { PROVIDERS } from "./api-providers/index.ts";
import type { ProviderMeta } from "./api-providers/types.ts";
import { loadWebSearchConfig, saveWebSearchConfig, type LlmTransport, type WebSearchConfig } from "./config.ts";
import { FALLBACK_REASONS, type ApiSearchProviderName, type FallbackReason, type WebSearchMode } from "./types.ts";
import { isSupportedSearchModel } from "./utils.ts";
const CLEAR_VALUE = "-";

interface MenuChoice<T extends string = string> {
  id: T;
  label: string;
}

export interface WebSearchConfigPanelHandlers {
  onSaved?(): void;
}

function notify(
  ctx: ExtensionCommandContext,
  level: "info" | "warning" | "error",
  message: string,
): void {
  ctx.ui.notify(message, level);
}

async function selectChoice<T extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  choices: Array<MenuChoice<T>>,
): Promise<T | undefined> {
  const selected = await ctx.ui.select(title, choices.map((choice) => choice.label));
  return choices.find((choice) => choice.label === selected)?.id;
}

function maskSecret(value: string | undefined): string {
  if (!value) return "Not configured";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function modeLabel(mode: WebSearchMode): string {
  return {
    auto: "Auto: LLM first, then configured API fallback",
    llm: "LLM: model built-in web search only",
    api: "API: Search API only",
  }[mode];
}

function transportLabel(transport: LlmTransport): string {
  return {
    auto: "Auto",
    "google-developer": "Google Developer API",
    "vertex-express": "Vertex Express",
  }[transport];
}

function fallbackLabel(reason: FallbackReason): string {
  return {
    unsupported: "Unsupported",
    quota: "Quota",
    "rate-limit": "Rate limit",
    network: "Network",
    timeout: "Timeout",
    "invalid-response": "Invalid response",
  }[reason];
}

function modelLabel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function configuredModelLabel(config: WebSearchConfig, ctx: ExtensionCommandContext): string {
  if (config.llm?.provider && config.llm.model) return `${config.llm.provider}/${config.llm.model}`;
  return ctx.model
    ? `Current session model (${modelLabel(ctx.model)})`
    : "No current model";
}

function selectedProvider(config: WebSearchConfig): ApiSearchProviderName {
  return config.api?.provider ?? "brave";
}

function providerMeta(name: ApiSearchProviderName): ProviderMeta {
  return PROVIDERS.find((candidate) => candidate.name === name)!;
}

function providerConfigured(meta: ProviderMeta, config: WebSearchConfig): boolean {
  const key = meta.envVar ? process.env[meta.envVar]?.trim() : undefined;
  const configuredKey = config.api?.apiKeys?.[meta.name as ApiSearchProviderName]?.trim();
  const url = meta.baseUrlEnvVar ? process.env[meta.baseUrlEnvVar]?.trim() : undefined;
  const configuredUrl = config.api?.baseUrls?.[meta.name as ApiSearchProviderName]?.trim();
  return Boolean(key || configuredKey || url || configuredUrl);
}

function credentialSummary(meta: ProviderMeta, config: WebSearchConfig): string {
  const envValue = meta.envVar ? process.env[meta.envVar]?.trim() : undefined;
  if (envValue) return `From environment variable ${meta.envVar ?? ""}`;
  return maskSecret(config.api?.apiKeys?.[meta.name as ApiSearchProviderName]);
}

function baseUrlSummary(meta: ProviderMeta, config: WebSearchConfig): string {
  const envValue = meta.baseUrlEnvVar ? process.env[meta.baseUrlEnvVar]?.trim() : undefined;
  if (envValue) return `From environment variable ${meta.baseUrlEnvVar ?? ""}`;
  return config.api?.baseUrls?.[meta.name as ApiSearchProviderName]
    ?? meta.defaultBaseUrl
    ?? "Not configured";
}

function fallbackSummary(config: WebSearchConfig): string {
  const values = config.fallbackOn ?? ["unsupported"];
  return values.length > 0
    ? values.map(fallbackLabel).join(", ")
    : "None";
}

function githubInterceptorEnabled(config: WebSearchConfig): boolean {
  const value = config.interceptors?.github;
  if (typeof value === "boolean") return value;
  return value?.enabled ?? Boolean(value);
}

function persist(
  ctx: ExtensionCommandContext,
  config: WebSearchConfig,
  handlers: WebSearchConfigPanelHandlers,
): boolean {
  const result = saveWebSearchConfig(config);
  if (!result.ok) {
    notify(ctx, "error", `Failed to save configuration to ${result.path}: ${result.error ?? ""}`);
    return false;
  }
  handlers.onSaved?.();
  return true;
}

async function configureMode(ctx: ExtensionCommandContext, config: WebSearchConfig): Promise<WebSearchConfig> {
  const modes: WebSearchMode[] = ["auto", "llm", "api"];
  const selected = await selectChoice(ctx, "Select search mode", modes.map((mode) => ({
    id: mode,
    label: `${mode === (config.mode ?? "auto") ? "✓ " : ""}${modeLabel(mode)}`,
  })));
  return selected ? { ...config, mode: selected } : config;
}

async function configureLlmModel(ctx: ExtensionCommandContext, config: WebSearchConfig): Promise<WebSearchConfig> {
  let models: Model<Api>[] = [];
  try {
    models = ctx.modelRegistry.getAvailable().filter(isSupportedSearchModel);
  } catch {
    models = [];
  }
  const currentId = "__current__";
  const choices: Array<MenuChoice> = [{
    id: currentId,
    label: `${!config.llm?.provider || !config.llm.model ? "✓ " : ""}${"Follow the current session model"}`,
  }];
  for (const model of models) {
    const id = modelLabel(model);
    const active = config.llm?.provider === model.provider && config.llm.model === model.id;
    choices.push({ id, label: `${active ? "✓ " : ""}${id}` });
  }
  const selected = await selectChoice(ctx, "Select the LLM search model", choices);
  if (!selected) return config;
  if (selected === currentId) {
    return {
      ...config,
      llm: { transport: config.llm?.transport ?? "auto" },
    };
  }
  const split = selected.indexOf("/");
  return {
    ...config,
    llm: {
      ...config.llm,
      provider: selected.slice(0, split),
      model: selected.slice(split + 1),
      transport: config.llm?.transport ?? "auto",
    },
  };
}

async function configureTransport(ctx: ExtensionCommandContext, config: WebSearchConfig): Promise<WebSearchConfig> {
  const transports: LlmTransport[] = ["auto", "google-developer", "vertex-express"];
  const current = config.llm?.transport ?? "auto";
  const selected = await selectChoice(ctx, "Select LLM transport", transports.map((transport) => ({
    id: transport,
    label: `${transport === current ? "✓ " : ""}${transportLabel(transport)}`,
  })));
  return selected
    ? { ...config, llm: { ...config.llm, transport: selected } }
    : config;
}

async function configureApiProvider(ctx: ExtensionCommandContext, config: WebSearchConfig): Promise<WebSearchConfig> {
  const current = selectedProvider(config);
  const choices = PROVIDERS.map((meta) => ({
    id: meta.name as ApiSearchProviderName,
    label: `${meta.name === current ? "✓ " : ""}${meta.label}${providerConfigured(meta, config) ? ` ${"(configured)"}` : ""}`,
  }));
  const selected = await selectChoice(ctx, "Select Search API provider", choices);
  return selected
    ? { ...config, api: { ...config.api, provider: selected } }
    : config;
}

async function configureApiCredential(ctx: ExtensionCommandContext, config: WebSearchConfig): Promise<WebSearchConfig> {
  const provider = selectedProvider(config);
  const meta = providerMeta(provider);
  const existing = config.api?.apiKeys?.[provider];
  const value = await ctx.ui.input(
    `${meta.label} API key`,
    existing
      ? `Enter a new value; leave empty to keep ${maskSecret(existing)}; enter ${CLEAR_VALUE} to clear`
      : `Enter an API key; leave empty unchanged; enter ${CLEAR_VALUE} to clear`,
  );
  if (value === undefined || value === null) return config;
  const trimmed = value.trim();
  if (!trimmed) return config;
  const apiKeys = { ...(config.api?.apiKeys ?? {}) };
  if (trimmed === CLEAR_VALUE) delete apiKeys[provider];
  else apiKeys[provider] = trimmed;
  return { ...config, api: { ...config.api, provider, apiKeys } };
}

async function configureApiBaseUrl(ctx: ExtensionCommandContext, config: WebSearchConfig): Promise<WebSearchConfig> {
  const provider = selectedProvider(config);
  const meta = providerMeta(provider);
  if (!meta.baseUrlEnvVar && !meta.defaultBaseUrl) return config;
  const existing = config.api?.baseUrls?.[provider];
  const value = await ctx.ui.input(
    `${meta.label} API base URL`,
    existing
      ? `Enter a new URL; leave empty to keep ${existing}; enter ${CLEAR_VALUE} to clear`
      : `Enter a URL; leave empty unchanged; default ${meta.defaultBaseUrl ?? ""}; enter ${CLEAR_VALUE} to clear`,
  );
  if (value === undefined || value === null) return config;
  const trimmed = value.trim();
  if (!trimmed) return config;
  const baseUrls = { ...(config.api?.baseUrls ?? {}) };
  if (trimmed === CLEAR_VALUE) delete baseUrls[provider];
  else baseUrls[provider] = trimmed;
  return { ...config, api: { ...config.api, provider, baseUrls } };
}

function configureGitHubInterceptor(config: WebSearchConfig): WebSearchConfig {
  const current = config.interceptors?.github;
  const enabled = !githubInterceptorEnabled(config);
  const github = current && typeof current === "object"
    ? { ...current, enabled }
    : enabled;
  return {
    ...config,
    interceptors: { ...config.interceptors, github },
  };
}

async function configureFallback(ctx: ExtensionCommandContext, config: WebSearchConfig): Promise<WebSearchConfig> {
  const selected = new Set<FallbackReason>(config.fallbackOn ?? ["unsupported"]);
  while (true) {
    const doneId = "__done__";
    const choice = await selectChoice(ctx, "Select errors that may fall back in auto mode, then choose Done", [
      ...FALLBACK_REASONS.map((reason) => ({
        id: reason,
        label: `${selected.has(reason) ? "✓ " : "  "}${fallbackLabel(reason)}`,
      })),
      { id: doneId, label: "Done" },
    ]);
    if (!choice || choice === doneId) break;
    const reason = choice as FallbackReason;
    if (selected.has(reason)) selected.delete(reason);
    else selected.add(reason);
  }
  return { ...config, fallbackOn: FALLBACK_REASONS.filter((reason) => selected.has(reason)) };
}

export async function openWebSearchConfigPanel(
  ctx: ExtensionCommandContext,
  handlers: WebSearchConfigPanelHandlers = {},
): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "error", "/config:web-search requires interactive mode.");
    return;
  }

  const providerOverride = process.env.PI_WEB_SEARCH_API_PROVIDER?.trim()
    || process.env.WEB_SEARCH_PROVIDER?.trim();
  if (providerOverride) {
    notify(ctx, "warning", `An environment variable currently overrides the API provider with ${providerOverride}; the panel selection takes effect after that variable is removed.`);
  }

  let changed = false;
  while (true) {
    let loaded;
    try {
      loaded = loadWebSearchConfig();
    } catch (error) {
      notify(ctx, "error", `Failed to load web search configuration: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const config = loaded.config;
    const provider = selectedProvider(config);
    const meta = providerMeta(provider);
    const choices: Array<MenuChoice> = [
      { id: "mode", label: `${"Search mode"}: ${modeLabel(config.mode ?? "auto")}` },
      { id: "llmModel", label: `${"LLM model"}: ${configuredModelLabel(config, ctx)}` },
      { id: "transport", label: `${"LLM transport"}: ${transportLabel(config.llm?.transport ?? "auto")}` },
      { id: "apiProvider", label: `${"API provider"}: ${meta.label}` },
      { id: "apiKey", label: `${"API credential"}: ${credentialSummary(meta, config)}` },
      ...(meta.baseUrlEnvVar || meta.defaultBaseUrl ? [{
        id: "baseUrl",
        label: `${"API base URL"}: ${baseUrlSummary(meta, config)}`,
      }] : []),
      {
        id: "githubInterceptor",
        label: `${"GitHub repository extraction"}: ${githubInterceptorEnabled(config) ? "Enabled" : "Disabled"}`,
      },
      { id: "fallback", label: `${"Automatic fallback"}: ${fallbackSummary(config)}` },
      { id: "done", label: "Done" },
    ];

    const action = await selectChoice(ctx, `Web Search Configuration · ${loaded.path}`, choices);
    if (!action || action === "done") {
      if (changed) notify(ctx, "info", `Web search configuration saved to ${loaded.path}.`);
      return;
    }

    let next = config;
    if (action === "mode") next = await configureMode(ctx, config);
    else if (action === "llmModel") next = await configureLlmModel(ctx, config);
    else if (action === "transport") next = await configureTransport(ctx, config);
    else if (action === "apiProvider") next = await configureApiProvider(ctx, config);
    else if (action === "apiKey") next = await configureApiCredential(ctx, config);
    else if (action === "baseUrl") next = await configureApiBaseUrl(ctx, config);
    else if (action === "githubInterceptor") next = configureGitHubInterceptor(config);
    else if (action === "fallback") next = await configureFallback(ctx, config);

    if (next !== config && persist(ctx, next, handlers)) changed = true;
  }
}
