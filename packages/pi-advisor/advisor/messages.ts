import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { i18n } from "../src/i18n.ts";

export const ADVISOR_TOOL_NAME = "advisor";
export const NO_ADVISOR_VALUE = "__no_advisor__";
export const OFF_VALUE = "__off__";
export type GradedEffort = ThinkingLevel;
export const EFFORT_ORDINAL: readonly GradedEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT: GradedEffort = "high";
export const CHECKMARK = " ✓";

function effortSuffix(effort: ThinkingLevel | undefined): string {
	return effort ? `, ${effort}` : "";
}

export const messages = {
	toolLabel: () => i18n.t("toolLabel"),
	toolDescription: () => i18n.t("toolDescription"),
	commandDescription: () => i18n.t("commandDescription"),
	promptSnippet: () => i18n.t("promptSnippet"),
	promptGuidelines: () => [
		i18n.t("promptGuideline1"),
		i18n.t("promptGuideline2"),
		i18n.t("promptGuideline3"),
		i18n.t("promptGuideline4"),
		i18n.t("promptGuideline5"),
		i18n.t("promptGuideline6"),
		i18n.t("promptGuideline7"),
	],
	systemPrompt: () => i18n.t("systemPrompt"),
	inventoryHeader: () => i18n.t("inventoryHeader"),
	parametersLabel: () => i18n.t("parametersLabel"),
	advisorNudge: () => i18n.t("advisorNudge"),
	advisorDisabled: () => i18n.t("advisorDisabled"),
	requiresUi: () => i18n.t("requiresUi"),
	effortNotSet: () => i18n.t("effortNotSet"),
	persistFailed: () => i18n.t("persistFailed"),
	noModel: () => i18n.t("noModel"),
	callAborted: () => i18n.t("callAborted"),
	emptyResponse: () => i18n.t("emptyResponse"),
	noModelSelected: () => i18n.t("noModelSelected"),
	emptyResponseDetail: () => i18n.t("emptyResponseDetail"),
	abortedDetail: () => i18n.t("abortedDetail"),
	unknownError: () => i18n.t("unknownError"),
	misconfigured: (label: string, error: string) => i18n.t("misconfigured", { label, error }),
	callFailed: (error?: string) => i18n.t("callFailed", { error: error ?? i18n.t("unknownError") }),
	callThrew: (error: string) => i18n.t("callThrew", { error }),
	selectionNotFound: (choice: string) => i18n.t("selectionNotFound", { choice }),
	modelUnavailable: (key: string) => i18n.t("modelUnavailable", { key }),
	advisorEnabled: (label: string, effort?: ThinkingLevel) => i18n.t("advisorEnabled", { label, effort: effortSuffix(effort) }),
	advisorRestored: (label: string, effort?: ThinkingLevel) => i18n.t("advisorRestored", { label, effort: effortSuffix(effort) }),
	advisorRestoredInactive: (label: string, effort?: ThinkingLevel) => i18n.t("advisorRestoredInactive", { label, effort: effortSuffix(effort) }),
	advisorEnabledInactive: (label: string, effort?: ThinkingLevel) => i18n.t("advisorEnabledInactive", { label, effort: effortSuffix(effort) }),
	advisorDisabledFor: (model: string) => i18n.t("advisorDisabledFor", { model }),
	consulting: (label: string, effort?: ThinkingLevel) => i18n.t("consulting", { label, effort: effortSuffix(effort) }),
	configReadFailed: (path: string, error: string) => i18n.t("configReadFailed", { path, error }),
	invalidMinEffort: (model: string, effort: string) => i18n.t("invalidMinEffort", { model, effort }),
	invalidEffort: (effort: string) => i18n.t("invalidEffort", { effort, valid: EFFORT_ORDINAL.join(", ") }),
	noAdvisor: () => i18n.t("noAdvisor"),
	offNoReasoning: () => i18n.t("offNoReasoning"),
	recommendedSuffix: () => i18n.t("recommendedSuffix"),
};
