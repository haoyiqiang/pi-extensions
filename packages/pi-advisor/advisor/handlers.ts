import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyWithSource } from "pi-extensions-i18n";
import { NOTICE_SOURCE } from "../src/i18n.ts";
import { modelKey } from "./config.ts";
import { ADVISOR_TOOL_NAME, messages } from "./messages.ts";
import { isExecutorBlocked, isModelBlocked } from "./policy.ts";
import { getAdvisorEffort, getAdvisorModel, type AdvisorState } from "./state.ts";

interface ReconcileNotify {
	disabled: string;
	restored: string;
}

export function reconcileAdvisorTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { blocked: boolean; notify?: ReconcileNotify },
): void {
	const active = pi.getActiveTools();
	const hasTool = active.includes(ADVISOR_TOOL_NAME);
	if (options.blocked && hasTool) {
		pi.setActiveTools(active.filter((name) => name !== ADVISOR_TOOL_NAME));
		if (options.notify && ctx.hasUI) notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: options.notify.disabled });
	} else if (!options.blocked && !hasTool) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
		if (options.notify && ctx.hasUI) notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: options.notify.restored });
	}
}

export function registerAdvisorBeforeAgentStart(pi: ExtensionAPI, state: AdvisorState): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		const blocked = !getAdvisorModel(state) || isExecutorBlocked(state, ctx, pi.getThinkingLevel());
		reconcileAdvisorTool(pi, ctx, { blocked });
	});
}

export function registerModelSelectHandler(pi: ExtensionAPI, state: AdvisorState): void {
	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") return;
		const advisor = getAdvisorModel(state);
		if (!advisor) return;
		reconcileAdvisorTool(pi, ctx, {
			blocked: isModelBlocked(state, event.model, pi.getThinkingLevel()),
			notify: {
				disabled: messages.advisorDisabledFor(modelKey(event.model)),
				restored: messages.advisorRestored(modelKey(advisor), getAdvisorEffort(state)),
			},
		});
	});
}

export function registerThinkingLevelSelectHandler(pi: ExtensionAPI, state: AdvisorState): void {
	pi.on("thinking_level_select", async (event, ctx) => {
		const advisor = getAdvisorModel(state);
		if (!advisor) return;
		const model = ctx.model;
		reconcileAdvisorTool(pi, ctx, {
			blocked: isModelBlocked(state, model, event.level),
			notify: {
				disabled: model ? messages.advisorDisabledFor(modelKey(model)) : messages.advisorDisabled(),
				restored: messages.advisorRestored(modelKey(advisor), getAdvisorEffort(state)),
			},
		});
	});
}
