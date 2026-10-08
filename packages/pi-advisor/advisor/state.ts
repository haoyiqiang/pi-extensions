import type { Api, Model } from "@earendil-works/pi-ai";
import type { DisabledForModelsEntry } from "./config.ts";
import type { GradedEffort } from "./messages.ts";

export interface AdvisorState {
	selectedModel: Model<Api> | undefined;
	selectedEffort: GradedEffort | undefined;
	disabledForModels: DisabledForModelsEntry[];
	restoreAnnounced: boolean;
	diagnosticsAnnounced: boolean;
}

export function createAdvisorState(): AdvisorState {
	return {
		selectedModel: undefined,
		selectedEffort: undefined,
		disabledForModels: [],
		restoreAnnounced: false,
		diagnosticsAnnounced: false,
	};
}

export function getAdvisorModel(state: AdvisorState): Model<Api> | undefined {
	return state.selectedModel;
}

export function setAdvisorModel(state: AdvisorState, model: Model<Api> | undefined): void {
	state.selectedModel = model;
}

export function getAdvisorEffort(state: AdvisorState): GradedEffort | undefined {
	return state.selectedEffort;
}

export function setAdvisorEffort(state: AdvisorState, effort: GradedEffort | undefined): void {
	state.selectedEffort = effort;
}

export function resetAdvisorState(state: AdvisorState): void {
	state.selectedModel = undefined;
	state.selectedEffort = undefined;
	state.disabledForModels = [];
	state.restoreAnnounced = false;
	state.diagnosticsAnnounced = false;
}
