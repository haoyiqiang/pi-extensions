import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { extensionConfigPath, readJsonObjectResult, writeJsonAtomic, type JsonObject } from "pi-utils";
import { EFFORT_ORDINAL, messages, type GradedEffort } from "./messages.ts";

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
	description?: string;
}

export type DisabledForModelsEntry = string | { model: string; minEffort?: GradedEffort };

export interface AdvisorConfig extends JsonObject {
	modelKey?: string;
	effort?: GradedEffort;
	guidance?: GuidanceFields;
	disabledForModels?: DisabledForModelsEntry[];
}

export interface AdvisorConfigLoadResult {
	config: AdvisorConfig;
	path: string;
	warnings: string[];
	legacyPath?: string;
}

export function advisorConfigPath(): string {
	return extensionConfigPath("pi-advisor", "advisor.json");
}

function expandTilde(path: string): string | undefined {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return isAbsolute(path) ? path : undefined;
}

export function legacyAdvisorConfigPath(): string {
	const configured = process.env.XDG_CONFIG_HOME?.trim();
	const base = configured ? expandTilde(configured) : undefined;
	return join(base ?? join(homedir(), ".config"), "rpiv-advisor", "advisor.json");
}

function legacyAdvisorConfigPaths(): string[] {
	const preferred = legacyAdvisorConfigPath();
	const fixedHome = join(homedir(), ".config", "rpiv-advisor", "advisor.json");
	return preferred === fixedHome ? [preferred] : [preferred, fixedHome];
}

function asConfig(value: JsonObject): AdvisorConfig {
	return value as AdvisorConfig;
}

export function loadAdvisorConfigResult(): AdvisorConfigLoadResult {
	const path = advisorConfigPath();
	const canonical = readJsonObjectResult(path);
	if (canonical.status === "loaded") return { config: asConfig(canonical.value), path, warnings: [] };
	if (canonical.status === "invalid") {
		return { config: {}, path, warnings: [messages.configReadFailed(path, canonical.error.message)] };
	}

	for (const legacyPath of legacyAdvisorConfigPaths()) {
		const legacy = readJsonObjectResult(legacyPath);
		if (legacy.status === "loaded") return { config: asConfig(legacy.value), path, warnings: [], legacyPath };
		if (legacy.status === "invalid") {
			return { config: {}, path, warnings: [messages.configReadFailed(legacyPath, legacy.error.message)], legacyPath };
		}
	}
	return { config: {}, path, warnings: [] };
}

export function loadAdvisorConfig(): AdvisorConfig {
	return loadAdvisorConfigResult().config;
}

export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
	const input = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof input.promptSnippet === "string" && input.promptSnippet.length > 0) result.promptSnippet = input.promptSnippet;
	if (
		Array.isArray(input.promptGuidelines) &&
		input.promptGuidelines.length > 0 &&
		input.promptGuidelines.every((item) => typeof item === "string" && item.length > 0)
	) result.promptGuidelines = input.promptGuidelines as string[];
	if (typeof input.description === "string" && input.description.length > 0) result.description = input.description;
	return result;
}

export function validateDisabledForModels(value: unknown, warnings: string[] = []): DisabledForModelsEntry[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is DisabledForModelsEntry => {
		if (typeof entry === "string") return entry.length > 0;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
		const item = entry as Record<string, unknown>;
		if (typeof item.model !== "string" || item.model.length === 0) return false;
		if (item.minEffort !== undefined && !EFFORT_ORDINAL.includes(item.minEffort as GradedEffort)) {
			warnings.push(messages.invalidMinEffort(item.model, String(item.minEffort)));
			return false;
		}
		return true;
	});
}

export function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
	const slash = key.indexOf("/");
	if (slash >= 1 && slash < key.length - 1) return { provider: key.slice(0, slash), modelId: key.slice(slash + 1) };
	const colon = key.indexOf(":");
	if (colon >= 1 && colon < key.length - 1) return { provider: key.slice(0, colon), modelId: key.slice(colon + 1) };
	return undefined;
}

export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function saveAdvisorConfig(key: string | undefined, effort: GradedEffort | undefined): boolean {
	try {
		const path = advisorConfigPath();
		const loaded = readJsonObjectResult(path);
		const current = loaded.status === "loaded" ? { ...loaded.value } : {};
		if (key) current.modelKey = key;
		else delete current.modelKey;
		if (effort) current.effort = effort;
		else delete current.effort;
		writeJsonAtomic(path, current, { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}
