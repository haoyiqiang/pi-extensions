import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { notifyWithSource } from "pi-utils";
import { NOTICE_SOURCE } from "../src/i18n.ts";
import { showAdvisorPicker, showEffortPicker } from "../advisor-ui.js";
import { modelKey, saveAdvisorConfig } from "./config.ts";
import { reconcileAdvisorTool } from "./handlers.ts";
import {
	ADVISOR_TOOL_NAME,
	CHECKMARK,
	DEFAULT_EFFORT,
	EFFORT_ORDINAL,
	messages,
	NO_ADVISOR_VALUE,
	OFF_VALUE,
	type GradedEffort,
} from "./messages.ts";
import { isExecutorBlocked } from "./policy.ts";
import { getAdvisorEffort, getAdvisorModel, setAdvisorEffort, setAdvisorModel, type AdvisorState } from "./state.ts";

function notice(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	notifyWithSource({ ctx, source: NOTICE_SOURCE, level, message });
}

function buildModelItems(models: Model<Api>[], currentKey: string | undefined): SelectItem[] {
	const items = models.map((model) => {
		const key = modelKey(model);
		return { value: key, label: `${model.name}  (${model.provider})${key === currentKey ? CHECKMARK : ""}` };
	});
	items.push({
		value: NO_ADVISOR_VALUE,
		label: currentKey === undefined ? `${messages.noAdvisor()}${CHECKMARK}` : messages.noAdvisor(),
	});
	return items;
}

function buildEffortItems(model: Model<Api>): SelectItem[] {
	const levels = getSupportedThinkingLevels(model).filter((level): level is GradedEffort =>
		EFFORT_ORDINAL.includes(level as GradedEffort),
	);
	return [
		{ value: OFF_VALUE, label: messages.offNoReasoning() },
		...levels.map((level) => ({
			value: level,
			label: level === DEFAULT_EFFORT ? `${level}${messages.recommendedSuffix()}` : level,
		})),
	];
}

function applyDisable(pi: ExtensionAPI, state: AdvisorState, ctx: ExtensionContext): void {
	if (!saveAdvisorConfig(undefined, undefined)) {
		notice(ctx, messages.persistFailed(), "error");
		return;
	}
	setAdvisorModel(state, undefined);
	setAdvisorEffort(state, undefined);
	const active = pi.getActiveTools();
	if (active.includes(ADVISOR_TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== ADVISOR_TOOL_NAME));
	notice(ctx, messages.advisorDisabled(), "info");
}

function applyEnable(
	pi: ExtensionAPI,
	state: AdvisorState,
	ctx: ExtensionContext,
	model: Model<Api>,
	effort: GradedEffort | undefined,
): void {
	if (!saveAdvisorConfig(modelKey(model), effort)) {
		notice(ctx, messages.persistFailed(), "error");
		return;
	}
	setAdvisorModel(state, model);
	setAdvisorEffort(state, effort);
	const blocked = isExecutorBlocked(state, ctx, pi.getThinkingLevel());
	reconcileAdvisorTool(pi, ctx, { blocked });
	notice(
		ctx,
		blocked ? messages.advisorEnabledInactive(modelKey(model), effort) : messages.advisorEnabled(modelKey(model), effort),
		"info",
	);
}

export function registerAdvisorCommand(pi: ExtensionAPI, state: AdvisorState): void {
	const command: Omit<RegisteredCommand, "name" | "sourceInfo"> = {
		description: messages.commandDescription(),
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
			notice(ctx, messages.requiresUi(), "error");
				return;
			}

			const available = ctx.modelRegistry.getAvailable();
			const current = getAdvisorModel(state);
			const choice = await showAdvisorPicker(ctx, buildModelItems(available, current ? modelKey(current) : undefined));
			if (!choice) return;
			if (choice === NO_ADVISOR_VALUE) {
				applyDisable(pi, state, ctx);
				return;
			}

			const picked = available.find((model) => modelKey(model) === choice);
			if (!picked) {
				notice(ctx, messages.selectionNotFound(choice), "error");
				return;
			}

			let effort: GradedEffort | undefined;
			if (picked.reasoning) {
				const selected = await showEffortPicker(ctx, buildEffortItems(picked), getAdvisorEffort(state), DEFAULT_EFFORT);
				if (!selected) notice(ctx, messages.effortNotSet(), "info");
				else effort = selected === OFF_VALUE ? undefined : selected as GradedEffort;
			}
			applyEnable(pi, state, ctx, picked, effort);
		},
	};

	pi.registerCommand("config:advisor", command);
	pi.registerCommand("advisor", command);
}
