import * as z from "zod";

const MAX_TIMER_MS = 2_147_483_647;

export const TITLE_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type TitleEffort = typeof TITLE_EFFORT_LEVELS[number];

const NAMING_SWITCHES = ["automaticNaming", "manualNaming"] as const;
/** Accepted and discarded so pre-existing config files keep loading. */
const LEGACY_TARGETS_KEY = "targets";

export interface TitleConfig {
  maxLength: number;
  preferredLength: number;
  language: string;
  instructions: string;
  timeoutMs: number;
  maxTokens: number;
  effort: TitleEffort;
}

export const DEFAULT_TITLE_CONFIG: Readonly<TitleConfig> = Object.freeze({
  maxLength: 15,
  preferredLength: 10,
  language: "auto",
  instructions: "",
  timeoutMs: 10_000,
  maxTokens: 2048,
  effort: "low",
});

export interface NamingConfig {
  automaticNaming: boolean;
  manualNaming: boolean;
  title: TitleConfig;
}

function invalid(field: string): never {
  throw new Error(`Invalid configuration field: ${field}. Check the field name, type and allowed range.`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid(field);
  return value;
}

export function isTitleEffort(value: unknown): value is TitleEffort {
  return TITLE_EFFORT_LEVELS.some((level) => level === value);
}

/** Strict validation; only omitted fields receive defaults. No file I/O lives here. */
export function parseConfig(value: unknown): NamingConfig {
  const raw = object(value, "config");
  const allowed = new Set<string>([...NAMING_SWITCHES, LEGACY_TARGETS_KEY, "title"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) invalid(key);
  for (const key of NAMING_SWITCHES) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") invalid(key);
  }
  if (raw[LEGACY_TARGETS_KEY] !== undefined) object(raw[LEGACY_TARGETS_KEY], LEGACY_TARGETS_KEY);
  const titleRaw = raw.title === undefined ? {} : object(raw.title, "title");
  for (const key of Object.keys(titleRaw)) {
    if (!Object.hasOwn(DEFAULT_TITLE_CONFIG, key)) invalid(`title.${key}`);
  }
  const title: TitleConfig = { ...DEFAULT_TITLE_CONFIG };
  for (const key of ["maxLength", "preferredLength", "timeoutMs", "maxTokens"] as const) {
    if (titleRaw[key] !== undefined) title[key] = positiveInteger(titleRaw[key], `title.${key}`);
  }
  if (title.preferredLength > title.maxLength) invalid("title.preferredLength");
  if (title.timeoutMs > MAX_TIMER_MS) invalid("title.timeoutMs");
  for (const key of ["language", "instructions"] as const) {
    if (titleRaw[key] === undefined) continue;
    if (typeof titleRaw[key] !== "string") invalid(`title.${key}`);
    title[key] = titleRaw[key].trim();
  }
  if (!title.language) invalid("title.language");
  if (titleRaw.effort !== undefined) {
    if (!isTitleEffort(titleRaw.effort)) invalid("title.effort");
    title.effort = titleRaw.effort;
  }
  return {
    automaticNaming: (raw.automaticNaming as boolean | undefined) ?? true,
    manualNaming: (raw.manualNaming as boolean | undefined) ?? true,
    title,
  };
}

/** Keep Spark's safeParse contract without replacing invalid naming fields with defaults. */
export const namingConfigSchema = z.unknown().transform((value, ctx): NamingConfig => {
  try {
    return parseConfig(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});
