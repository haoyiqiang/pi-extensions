import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { extensionConfigPath, readJsonObjectResult, type JsonObject } from "pi-utils";

export interface GuidanceFields {
  promptSnippet?: string;
  promptGuidelines?: string[];
}

export interface TodoConfig {
  guidance?: GuidanceFields;
  maxWidgetLines?: number;
  collapseKey?: string;
}

export interface ConfigDiagnostic {
  path: string;
  error: Error;
}

export interface ConfigLoadResult {
  config: TodoConfig;
  path: string;
  legacy: boolean;
  diagnostic?: ConfigDiagnostic;
}

export const DEFAULT_MAX_WIDGET_LINES = 12;
export type CollapseKeySpec = string;
export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+shift+t";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

export function todoConfigPath(): string {
  return extensionConfigPath("pi-todo", "config.json");
}

export function legacyTodoConfigPath(): string {
  const raw = process.env.XDG_CONFIG_HOME?.trim();
  const base = raw && isAbsolute(raw) ? raw : join(homedir(), ".config");
  return join(base, "rpiv-todo", "config.json");
}

function asTodoConfig(value: JsonObject): TodoConfig {
  return value as TodoConfig;
}

export function loadConfigResult(): ConfigLoadResult {
  const canonicalPath = todoConfigPath();
  const canonical = readJsonObjectResult(canonicalPath);
  if (canonical.status === "loaded") {
    return { config: asTodoConfig(canonical.value), path: canonicalPath, legacy: false };
  }
  if (canonical.status === "invalid") {
    return {
      config: {},
      path: canonicalPath,
      legacy: false,
      diagnostic: { path: canonicalPath, error: canonical.error },
    };
  }

  const legacyPath = legacyTodoConfigPath();
  const legacy = readJsonObjectResult(legacyPath);
  if (legacy.status === "loaded") {
    return { config: asTodoConfig(legacy.value), path: legacyPath, legacy: true };
  }
  if (legacy.status === "invalid") {
    return {
      config: {},
      path: legacyPath,
      legacy: true,
      diagnostic: { path: legacyPath, error: legacy.error },
    };
  }
  return { config: {}, path: canonicalPath, legacy: false };
}

export function loadConfig(): TodoConfig {
  return loadConfigResult().config;
}

export function validateGuidanceFields(value: unknown): GuidanceFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const promptSnippet =
    typeof raw.promptSnippet === "string" && raw.promptSnippet.trim() ? raw.promptSnippet : undefined;
  const promptGuidelines =
    Array.isArray(raw.promptGuidelines) &&
    raw.promptGuidelines.length > 0 &&
    raw.promptGuidelines.every((item) => typeof item === "string" && item.trim().length > 0)
      ? [...raw.promptGuidelines] as string[]
      : undefined;
  return { ...(promptSnippet ? { promptSnippet } : {}), ...(promptGuidelines ? { promptGuidelines } : {}) };
}

export function getMaxWidgetLines(config: TodoConfig = loadConfig()): number {
  const lines = config.maxWidgetLines;
  return typeof lines === "number" && lines >= 3 ? lines : DEFAULT_MAX_WIDGET_LINES;
}

const SPECIAL_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

export function isValidCollapseKeySpec(spec: string): boolean {
  if (!spec || spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
  const parts = spec.split("+");
  const base = parts.at(-1) ?? "";
  const modifiers = parts.slice(0, -1);
  if (modifiers.length !== new Set(modifiers).size) return false;
  if (!modifiers.every((modifier) => MODIFIERS.has(modifier))) return false;
  return base.length === 1
    ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base)
    : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(config: TodoConfig = loadConfig()): CollapseKeySpec {
  const raw = typeof config.collapseKey === "string" ? config.collapseKey.trim().toLowerCase() : undefined;
  if (!raw) return DEFAULT_COLLAPSE_KEY;
  if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
  return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}
