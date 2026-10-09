import { homedir } from "node:os";
import { join } from "node:path";
import { extensionConfigPath, readJsonObjectResult, type JsonObject } from "pi-utils";
import { i18n } from "./state/i18n-bridge.js";

export interface GuidanceFields {
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";
export const CONFIG_FILE_NAME = "config.json";

export interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
	collapseKey?: CollapseKeySpec;
}

export interface LoadedAskUserQuestionConfig {
	config: AskUserQuestionConfig;
	path: string;
	legacy: boolean;
	diagnostics: string[];
}

const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidCollapseKeySpec(spec: string): boolean {
	if (!spec || spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((modifier) => MODIFIERS.has(modifier))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, "collapseKey">): CollapseKeySpec {
	const raw = config.collapseKey?.trim().toLowerCase();
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

const COMPOUND_KEY_DISPLAY: Record<string, string> = { pageup: "PageUp", pagedown: "PageDown" };

export function formatKeySpecForDisplay(spec: CollapseKeySpec): string {
	return spec
		.split("+")
		.map((part) =>
			COMPOUND_KEY_DISPLAY[part] ??
			(part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)),
		)
		.join("+");
}

export function validateGuidanceFields(value: unknown): GuidanceFields {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const raw = value as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof raw.description === "string" && raw.description.trim()) result.description = raw.description;
	if (typeof raw.promptSnippet === "string" && raw.promptSnippet.trim()) result.promptSnippet = raw.promptSnippet;
	if (
		Array.isArray(raw.promptGuidelines) &&
		raw.promptGuidelines.length > 0 &&
		raw.promptGuidelines.every((item) => typeof item === "string" && item.trim().length > 0)
	) {
		result.promptGuidelines = [...raw.promptGuidelines] as string[];
	}
	return result;
}

function guidanceWasInvalid(value: unknown, parsed: GuidanceFields): boolean {
	if (value === undefined) return false;
	if (!value || typeof value !== "object" || Array.isArray(value)) return true;
	const raw = value as Record<string, unknown>;
	return (
		(raw.description !== undefined && parsed.description === undefined) ||
		(raw.promptSnippet !== undefined && parsed.promptSnippet === undefined) ||
		(raw.promptGuidelines !== undefined && parsed.promptGuidelines === undefined)
	);
}

function legacyConfigPath(): string {
	const root = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
	return join(root, "rpiv-ask-user-question", "config.json");
}

function parseConfig(raw: JsonObject, path: string, legacy: boolean): LoadedAskUserQuestionConfig {
	const diagnostics: string[] = [];
	const guidance = validateGuidanceFields(raw.guidance);
	if (guidanceWasInvalid(raw.guidance, guidance)) {
		diagnostics.push(i18n.t("config.invalid_guidance", { path }));
	}
	let collapseKey: string | undefined;
	if (raw.collapseKey !== undefined) {
		if (typeof raw.collapseKey === "string") collapseKey = raw.collapseKey;
		else diagnostics.push(i18n.t("config.invalid_collapse_key", { path, fallback: DEFAULT_COLLAPSE_KEY }));
	}
	const config: AskUserQuestionConfig = {
		...(Object.keys(guidance).length > 0 ? { guidance } : {}),
		...(collapseKey !== undefined ? { collapseKey } : {}),
	};
	if (collapseKey !== undefined && resolveCollapseKey(config) === DEFAULT_COLLAPSE_KEY) {
		const normalized = collapseKey.trim().toLowerCase();
		if (normalized !== "" && normalized !== DEFAULT_COLLAPSE_KEY) {
			diagnostics.push(i18n.t("config.invalid_collapse_key", { path, fallback: DEFAULT_COLLAPSE_KEY }));
		}
	}
	return { config, path, legacy, diagnostics };
}

export function loadConfigResult(): LoadedAskUserQuestionConfig {
	const canonical = extensionConfigPath("pi-ask-user-question", CONFIG_FILE_NAME);
	const canonicalResult = readJsonObjectResult(canonical);
	if (canonicalResult.status === "loaded") return parseConfig(canonicalResult.value, canonical, false);
	if (canonicalResult.status === "invalid") {
		return {
			config: {},
			path: canonical,
			legacy: false,
			diagnostics: [i18n.t("config.invalid_json", { path: canonical, error: canonicalResult.error.message })],
		};
	}

	const legacy = legacyConfigPath();
	const legacyResult = readJsonObjectResult(legacy);
	if (legacyResult.status === "loaded") return parseConfig(legacyResult.value, legacy, true);
	if (legacyResult.status === "invalid") {
		return {
			config: {},
			path: canonical,
			legacy: false,
			diagnostics: [i18n.t("config.invalid_json", { path: legacy, error: legacyResult.error.message })],
		};
	}
	return { config: {}, path: canonical, legacy: false, diagnostics: [] };
}

export function loadConfig(): AskUserQuestionConfig {
	return loadConfigResult().config;
}
