import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyWithSource } from "pi-extensions-i18n";
import { NOTICE_SOURCE } from "../src/i18n.ts";
import { loadAdvisorConfigResult, modelKey, parseModelKey, validateDisabledForModels } from "./config.ts";
import { reconcileAdvisorTool } from "./handlers.ts";
import { EFFORT_ORDINAL, messages } from "./messages.ts";
import { isExecutorBlocked, setDisabledForModels } from "./policy.ts";
import { setAdvisorEffort, setAdvisorModel, type AdvisorState } from "./state.ts";

export function __resetAdvisorAnnounced(state: AdvisorState): void {
	state.restoreAnnounced = false;
	state.diagnosticsAnnounced = false;
}

function notifyOnce(state: AdvisorState, ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (!ctx.hasUI || state.restoreAnnounced) return;
	notifyWithSource({ ctx, source: NOTICE_SOURCE, level, message });
	state.restoreAnnounced = true;
}

function notifyDiagnostics(state: AdvisorState, ctx: ExtensionContext, warnings: readonly string[]): void {
	if (!ctx.hasUI || state.diagnosticsAnnounced || warnings.length === 0) return;
	for (const warning of warnings) notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: warning });
	state.diagnosticsAnnounced = true;
}

export function restoreAdvisorState(state: AdvisorState, ctx: ExtensionContext, pi: ExtensionAPI): void {
	const loaded = loadAdvisorConfigResult();
	const config = loaded.config;
	const warnings = [...loaded.warnings];
	setDisabledForModels(state, validateDisabledForModels(config.disabledForModels, warnings));

	const deactivate = (): void => {
		setAdvisorModel(state, undefined);
		setAdvisorEffort(state, undefined);
		reconcileAdvisorTool(pi, ctx, { blocked: true });
	};

	if (!config.modelKey || typeof config.modelKey !== "string") {
		deactivate();
		notifyDiagnostics(state, ctx, warnings);
		return;
	}
	const parsed = parseModelKey(config.modelKey);
	if (!parsed) {
		deactivate();
		notifyDiagnostics(state, ctx, warnings);
		return;
	}

	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		deactivate();
		notifyDiagnostics(state, ctx, warnings);
		notifyOnce(state, ctx, messages.modelUnavailable(config.modelKey), "warning");
		return;
	}

	setAdvisorModel(state, model);
	let effort = config.effort;
	if (effort !== undefined && !EFFORT_ORDINAL.includes(effort)) {
		warnings.push(messages.invalidEffort(String(effort)));
		effort = undefined;
	}
	setAdvisorEffort(state, effort);
	notifyDiagnostics(state, ctx, warnings);

	if (isExecutorBlocked(state, ctx, pi.getThinkingLevel())) {
		reconcileAdvisorTool(pi, ctx, { blocked: true });
		notifyOnce(state, ctx, messages.advisorRestoredInactive(modelKey(model), effort), "info");
		return;
	}

	reconcileAdvisorTool(pi, ctx, { blocked: false });
	notifyOnce(state, ctx, messages.advisorRestored(modelKey(model), effort), "info");
}

export function registerAdvisorSessionStart(pi: ExtensionAPI, state: AdvisorState): void {
	pi.on("session_start", async (_event, ctx) => {
		restoreAdvisorState(state, ctx, pi);
	});
}
