import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { i18n } from "../src/i18n.ts";
import { loadAdvisorConfig, validateGuidanceFields } from "./config.ts";
import { executeAdvisor } from "./execute.ts";
import { ADVISOR_TOOL_NAME, messages } from "./messages.ts";
import type { AdvisorState } from "./state.ts";

const AdvisorParams = Type.Object({}, { additionalProperties: false });

export function getDefaultPromptSnippet(): string {
	return messages.promptSnippet();
}

let cachedGuidelines: { locale: string; value: string[] } | undefined;

export function getDefaultPromptGuidelines(): string[] {
	const locale = i18n.locale();
	if (cachedGuidelines?.locale === locale) return cachedGuidelines.value;
	const value = messages.promptGuidelines();
	cachedGuidelines = { locale, value };
	return value;
}

export function registerAdvisorTool(pi: ExtensionAPI, state: AdvisorState): void {
	const guidance = validateGuidanceFields(loadAdvisorConfig().guidance);
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: messages.toolLabel(),
		description: guidance.description ?? messages.toolDescription(),
		promptSnippet: guidance.promptSnippet ?? getDefaultPromptSnippet(),
		promptGuidelines: guidance.promptGuidelines ?? getDefaultPromptGuidelines(),
		parameters: AdvisorParams,
		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			return executeAdvisor(state, ctx, pi, signal, onUpdate);
		},
	});
}
