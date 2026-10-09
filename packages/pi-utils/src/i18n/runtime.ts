import { extensionConfigPath, readJsonObjectResult, resolveAgentDir, writeJsonAtomic } from "../config.ts";

export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type LocalePreference = Locale | "auto";
export type MessageParams = Record<string, string | number>;
export type TranslationMap = Readonly<Record<string, string>>;
export type LocaleStrings = Readonly<Partial<Record<Locale, TranslationMap>>>;

export const DEFAULT_LOCALE_PREFERENCE: LocalePreference = "zh-CN";
export const LOCALE_ENV = "PI_EXTENSIONS_LOCALE";
export const LOCALE_CONFIG_FILE = "config.json";
export const LOCALE_CONFIG_PACKAGE = "pi-utils";
/** Read-only fallback for the retired pi-extensions-i18n config directory. */
export const LEGACY_LOCALE_CONFIG_PACKAGE = "pi-extensions-i18n";
export const I18N_STATE_KEY = Symbol.for("pi-utils.i18n");
const I18N_RUNTIME_KEY = Symbol.for("pi-utils.i18n.runtime.v1");

export interface LocaleConfig {
  locale: LocalePreference;
}

export interface I18nState {
  readonly locale: Locale;
  readonly namespaces: Readonly<Record<string, TranslationMap>>;
}

export interface LocaleOverrideOwner {
  /** 仅用于类型区分；owner 的身份由对象引用本身决定。 */
  readonly localeOverrideOwner?: never;
}

interface OwnedLocaleOverride {
  owner: LocaleOverrideOwner;
  preference: LocalePreference;
}

interface I18nRuntime {
  registry: Map<string, Map<Locale, TranslationMap>>;
  overrideSet: boolean;
  overridePreference?: LocalePreference;
  ownerOverrides: OwnedLocaleOverride[];
}

function runtime(): I18nRuntime {
  const global = globalThis as unknown as { [I18N_RUNTIME_KEY]?: I18nRuntime };
  if (!global[I18N_RUNTIME_KEY]) {
    global[I18N_RUNTIME_KEY] = {
      registry: new Map(),
      overrideSet: false,
      ownerOverrides: [],
    };
  }
  const state = global[I18N_RUNTIME_KEY];
  // 兼容同进程里先加载的旧版本 runtime；新增 owner 栈不应要求所有包同时升级。
  if (!Array.isArray(state.ownerOverrides)) state.ownerOverrides = [];
  return state;
}

export function parseLocalePreference(value: string): LocalePreference | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized === "zh" || normalized === "zh-cn") return "zh-CN";
  if (normalized === "en" || normalized === "en-us") return "en-US";
  return undefined;
}

export function getLocaleConfigPath(agentDir = resolveAgentDir()): string {
  return extensionConfigPath(LOCALE_CONFIG_PACKAGE, LOCALE_CONFIG_FILE, agentDir);
}

function readPersistedPreference(agentDir = resolveAgentDir()): LocalePreference | undefined {
  for (const packageName of [LOCALE_CONFIG_PACKAGE, LEGACY_LOCALE_CONFIG_PACKAGE]) {
    const configPath = extensionConfigPath(packageName, LOCALE_CONFIG_FILE, agentDir);
    const loaded = readJsonObjectResult(configPath);
    if (loaded.status === "missing") continue;
    if (loaded.status === "invalid") {
      console.warn(
        `[pi-utils] Failed to read ${configPath}; using ${DEFAULT_LOCALE_PREFERENCE}: ${loaded.error.message}`,
      );
      continue;
    }
    const value = typeof loaded.value.locale === "string"
      ? parseLocalePreference(loaded.value.locale)
      : undefined;
    if (value) return value;
    console.warn(
      `[pi-utils] Invalid locale in ${configPath}; using ${DEFAULT_LOCALE_PREFERENCE}.`,
    );
  }
  return undefined;
}

export function getLocalePreference(): LocalePreference {
  const state = runtime();
  const owned = state.ownerOverrides.at(-1);
  if (owned) return owned.preference;
  if (state.overrideSet && state.overridePreference) return state.overridePreference;

  const envValue = process.env[LOCALE_ENV];
  if (envValue !== undefined) {
    const parsed = parseLocalePreference(envValue);
    if (parsed) return parsed;
    console.warn(
      `[pi-utils] Invalid ${LOCALE_ENV}=${JSON.stringify(envValue)}; using ${DEFAULT_LOCALE_PREFERENCE}.`,
    );
    return DEFAULT_LOCALE_PREFERENCE;
  }

  return readPersistedPreference() ?? DEFAULT_LOCALE_PREFERENCE;
}

function detectSystemLocale(): Locale {
  const systemLocale = process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? "";
  return systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function getLocale(): Locale {
  const preference = getLocalePreference();
  return preference === "auto" ? detectSystemLocale() : preference;
}

export const getActiveLocale = getLocale;

/** Applies the legacy process-local locale override. */
export function applyLocale(preference: LocalePreference): void {
  const state = runtime();
  state.overrideSet = true;
  state.overridePreference = preference;
  publishSnapshot();
}

/** Clears only the legacy process-local override, never another runtime's owned override. */
export function clearLocaleOverride(): void {
  const state = runtime();
  state.overrideSet = false;
  state.overridePreference = undefined;
  publishSnapshot();
}

/** Creates an opaque owner for one extension/runtime lifecycle. This does not change the locale. */
export function createLocaleOverrideOwner(): LocaleOverrideOwner {
  return Object.freeze({});
}

/** Removes this owner's current override without touching parent/root owners. */
function removeOwnedLocaleOverride(state: I18nRuntime, owner: LocaleOverrideOwner): boolean {
  const next = state.ownerOverrides.filter((entry) => entry.owner !== owner);
  if (next.length === state.ownerOverrides.length) return false;
  state.ownerOverrides = next;
  return true;
}

/** Applies an override owned by one runtime; reapplying moves that owner to the active position. */
export function applyLocaleForOwner(owner: LocaleOverrideOwner, preference: LocalePreference): void {
  const state = runtime();
  removeOwnedLocaleOverride(state, owner);
  state.ownerOverrides.push({ owner, preference });
  publishSnapshot();
}

/**
 * Makes this runtime explicitly inherit the currently active parent/process preference.
 * A child with no --locale flag should use this instead of clearLocaleOverride().
 */
export function inheritLocaleForOwner(owner: LocaleOverrideOwner): void {
  const state = runtime();
  if (removeOwnedLocaleOverride(state, owner)) publishSnapshot();
}

/** Idempotent lifecycle cleanup for an owned override. */
export function releaseLocaleOverrideOwner(owner: LocaleOverrideOwner): void {
  inheritLocaleForOwner(owner);
}

export function resetLocaleState(): void {
  const state = runtime();
  state.registry.clear();
  state.overrideSet = false;
  state.overridePreference = undefined;
  state.ownerOverrides = [];
  publishSnapshot();
}

export function saveLocalePreference(
  preference: LocalePreference,
  agentDir = resolveAgentDir(),
): string {
  const normalized = parseLocalePreference(preference);
  if (!normalized) throw new Error(`Unsupported locale preference: ${String(preference)}`);
  const configPath = getLocaleConfigPath(agentDir);
  const config: LocaleConfig = { locale: normalized };
  writeJsonAtomic(configPath, config);
  publishSnapshot();
  return configPath;
}

/** Registers one package namespace. Re-registering replaces the namespace atomically. */
export function registerStrings(namespace: string, byLocale: LocaleStrings): void {
  if (!namespace.trim()) throw new Error("i18n namespace must not be empty");
  const strings = new Map<Locale, TranslationMap>();
  for (const locale of SUPPORTED_LOCALES) {
    const value = byLocale[locale];
    if (value) strings.set(locale, Object.freeze({ ...value }));
  }
  runtime().registry.set(namespace, strings);
  publishSnapshot();
}

export function tr(
  namespace: string,
  key: string,
  fallback: string,
  params?: MessageParams,
): string {
  const strings = runtime().registry.get(namespace);
  const locale = getLocale();
  const template = strings?.get(locale)?.[key]
    ?? strings?.get("en-US")?.[key]
    ?? fallback;
  return interpolate(template, params);
}

export function scope(namespace: string): (
  key: string,
  fallback: string,
  params?: MessageParams,
) => string {
  return (key, fallback, params) => tr(namespace, key, fallback, params);
}

export function interpolate(template: string, params: MessageParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, name) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing interpolation value for ${placeholder}`);
    return String(value);
  });
}

function activeNamespaceSnapshot(): Readonly<Record<string, TranslationMap>> {
  const locale = getLocale();
  const namespaces: Record<string, TranslationMap> = {};
  for (const [namespace, byLocale] of runtime().registry) {
    namespaces[namespace] = byLocale.get(locale) ?? byLocale.get("en-US") ?? {};
  }
  return Object.freeze(namespaces);
}

function publishSnapshot(): void {
  const state: I18nState = Object.freeze({
    locale: getLocale(),
    namespaces: activeNamespaceSnapshot(),
  });
  (globalThis as unknown as { [I18N_STATE_KEY]: I18nState })[I18N_STATE_KEY] = state;
}

publishSnapshot();
