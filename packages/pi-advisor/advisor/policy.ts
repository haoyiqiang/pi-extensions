import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey, parseModelKey, type DisabledForModelsEntry } from "./config.ts";
import { EFFORT_ORDINAL, type GradedEffort } from "./messages.ts";
import type { AdvisorState } from "./state.ts";

export function setDisabledForModels(state: AdvisorState, models: DisabledForModelsEntry[]): void {
	state.disabledForModels = models;
}

function canonicalKey(entry: string): string {
	const parsed = parseModelKey(entry);
	return parsed ? `${parsed.provider}/${parsed.modelId}` : entry;
}

export function isModelBlocked(
	state: AdvisorState,
	model: Model<Api> | undefined,
	thinkingLevel?: string,
): boolean {
	if (!model) return false;
	const key = modelKey(model);
	for (const entry of state.disabledForModels) {
		if (typeof entry === "string") {
			if (canonicalKey(entry) === key) return true;
			continue;
		}
		if (canonicalKey(entry.model) !== key) continue;
		if (entry.minEffort === undefined) return true;
		const threshold = EFFORT_ORDINAL.indexOf(entry.minEffort);
		if (threshold === -1) continue;
		const executor = EFFORT_ORDINAL.indexOf(thinkingLevel as GradedEffort);
		if (executor >= threshold) return true;
	}
	return false;
}

export function isExecutorBlocked(state: AdvisorState, ctx: ExtensionContext | undefined, thinkingLevel?: string): boolean {
	return isModelBlocked(state, ctx?.model, thinkingLevel);
}
