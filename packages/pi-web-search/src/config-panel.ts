import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  NOTICE_TAG_COLOR,
  notifyWithSource,
  type NoticeSource,
} from "pi-extensions-i18n";
import { PROVIDERS } from "./api-providers/index.ts";
import type { ProviderMeta } from "./api-providers/types.ts";
import {
  loadWebSearchConfig,
  saveWebSearchConfig,
  type LlmTransport,
  type WebSearchConfig,
} from "./config.ts";
import { i18n } from "./i18n.ts";
import { FALLBACK_REASONS, type ApiSearchProviderName, type FallbackReason, type WebSearchMode } from "./types.ts";
import { isSupportedSearchModel } from "./utils.ts";

const NOTICE_SOURCE: NoticeSource = { tag: "web", color: NOTICE_TAG_COLOR };
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
  notifyWithSource({ ctx, source: NOTICE_SOURCE, level, message });
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
  if (!value) return i18n.t("configPanel.notConfigured");
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function modeLabel(mode: WebSearchMode): string {
  return i18n.t(`configPanel.mode.${mode}`);
}

function transportLabel(transport: LlmTransport): string {
  return i18n.t(`configPanel.transport.${transport}`);
}

function fallbackLabel(reason: FallbackReason): string {
  return i18n.t(`configPanel.fallback.${reason}`);
}

function modelLabel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function configuredModelLabel(config: WebSearchConfig, ctx: ExtensionCommandContext): string {
  if (config.llm?.provider && config.llm.model) return `${config.llm.provider}/${config.llm.model}`;
  return ctx.model
    ? i18n.t("configPanel.currentModelValue", { model: modelLabel(ctx.model) })
    : i18n.t("configPanel.noCurrentModel");
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
  if (envValue) return i18n.t("configPanel.fromEnvironment", { name: meta.envVar ?? "" });
  return maskSecret(config.api?.apiKeys?.[meta.name as ApiSearchProviderName]);
}

function baseUrlSummary(meta: ProviderMeta, config: WebSearchConfig): string {
  const envValue = meta.baseUrlEnvVar ? process.env[meta.baseUrlEnvVar]?.trim() : undefined;
  if (envValue) return i18n.t("configPanel.fromEnvironment", { name: meta.baseUrlEnvVar ?? "" });
  return config.api?.baseUrls?.[meta.name as ApiSearchProviderName]
    ?? meta.defaultBaseUrl
    ?? i18n.t("configPanel.notConfigured");
}

function fallbackSummary(config: WebSearchConfig): string {
  const values = config.fallbackOn ?? ["unsupported"];
  return values.length > 0
    ? values.map(fallbackLabel).join(", ")
    : i18n.t("configPanel.none");
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
    notify(ctx, "error", i18n.t("configPanel.saveFailed", { path: result.path, error: result.error ?? "" }));
    return false;
  }
  handlers.onSaved?.();
  return true;
}

async function configureMode(ctx: ExtensionCommandContext, config: WebSearchConfig): Promise<WebSearchConfig> {
  const modes: WebSearchMode[] = ["auto", "llm", "api"];
  const selected = await selectChoice(ctx, i18n.t("configPanel.modeTitle"), modes.map((mode) => ({
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
    label: `${!config.llm?.provider || !config.llm.model ? "✓ " : ""}${i18n.t("configPanel.useCurrentModel")}`,
  }];
  for (const model of models) {
    const id = modelLabel(model);
    const active = config.llm?.provider === model.provider && config.llm.model === model.id;
    choices.push({ id, label: `${active ? "✓ " : ""}${id}` });
  }
  const selected = await selectChoice(ctx, i18n.t("configPanel.llmModelTitle"), choices);
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
  const selected = await selectChoice(ctx, i18n.t("configPanel.transportTitle"), transports.map((transport) => ({
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
    label: `${meta.name === current ? "✓ " : ""}${meta.label}${providerConfigured(meta, config) ? ` ${i18n.t("configPanel.configured")}` : ""}`,
  }));
  const selected = await selectChoice(ctx, i18n.t("configPanel.apiProviderTitle"), choices);
  return selected
    ? { ...config, api: { ...config.api, provider: selected } }
    : config;
}

async function configureApiCredential(ctx: ExtensionCommandContext, config: WebSearchConfig): Promise<WebSearchConfig> {
  const provider = selectedProvider(config);
  const meta = providerMeta(provider);
  const existing = config.api?.apiKeys?.[provider];
  const value = await ctx.ui.input(
    i18n.t("configPanel.apiKeyTitle", { provider: meta.label }),
    existing
      ? i18n.t("configPanel.secretKeepOrClear", { masked: maskSecret(existing), clear: CLEAR_VALUE })
      : i18n.t("configPanel.secretEnterOrSkip", { clear: CLEAR_VALUE }),
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
    i18n.t("configPanel.baseUrlTitle", { provider: meta.label }),
    existing
      ? i18n.t("configPanel.valueKeepOrClear", { value: existing, clear: CLEAR_VALUE })
      : i18n.t("configPanel.baseUrlDefault", { value: meta.defaultBaseUrl ?? "", clear: CLEAR_VALUE }),
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
    const choice = await selectChoice(ctx, i18n.t("configPanel.fallbackTitle"), [
      ...FALLBACK_REASONS.map((reason) => ({
        id: reason,
        label: `${selected.has(reason) ? "✓ " : "  "}${fallbackLabel(reason)}`,
      })),
      { id: doneId, label: i18n.t("configPanel.done") },
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
    notify(ctx, "error", i18n.t("configPanel.requiresUi"));
    return;
  }

  const providerOverride = process.env.PI_WEB_SEARCH_API_PROVIDER?.trim()
    || process.env.WEB_SEARCH_PROVIDER?.trim();
  if (providerOverride) {
    notify(ctx, "warning", i18n.t("configPanel.providerEnvOverride", { provider: providerOverride }));
  }

  let changed = false;
  while (true) {
    let loaded;
    try {
      loaded = loadWebSearchConfig();
    } catch (error) {
      notify(ctx, "error", i18n.t("configPanel.loadFailed", {
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    const config = loaded.config;
    const provider = selectedProvider(config);
    const meta = providerMeta(provider);
    const choices: Array<MenuChoice> = [
      { id: "mode", label: i18n.t("configPanel.row", { label: i18n.t("configPanel.modeLabel"), value: modeLabel(config.mode ?? "auto") }) },
      { id: "llmModel", label: i18n.t("configPanel.row", { label: i18n.t("configPanel.llmModelLabel"), value: configuredModelLabel(config, ctx) }) },
      { id: "transport", label: i18n.t("configPanel.row", { label: i18n.t("configPanel.transportLabel"), value: transportLabel(config.llm?.transport ?? "auto") }) },
      { id: "apiProvider", label: i18n.t("configPanel.row", { label: i18n.t("configPanel.apiProviderLabel"), value: meta.label }) },
      { id: "apiKey", label: i18n.t("configPanel.row", { label: i18n.t("configPanel.apiKeyLabel"), value: credentialSummary(meta, config) }) },
      ...(meta.baseUrlEnvVar || meta.defaultBaseUrl ? [{
        id: "baseUrl",
        label: i18n.t("configPanel.row", { label: i18n.t("configPanel.baseUrlLabel"), value: baseUrlSummary(meta, config) }),
      }] : []),
      {
        id: "githubInterceptor",
        label: i18n.t("configPanel.row", {
          label: i18n.t("configPanel.githubInterceptorLabel"),
          value: i18n.t(githubInterceptorEnabled(config) ? "configPanel.enabled" : "configPanel.disabled"),
        }),
      },
      { id: "fallback", label: i18n.t("configPanel.row", { label: i18n.t("configPanel.fallbackLabel"), value: fallbackSummary(config) }) },
      { id: "done", label: i18n.t("configPanel.done") },
    ];

    const action = await selectChoice(ctx, i18n.t("configPanel.title", { path: loaded.path }), choices);
    if (!action || action === "done") {
      if (changed) notify(ctx, "info", i18n.t("configPanel.saved", { path: loaded.path }));
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
