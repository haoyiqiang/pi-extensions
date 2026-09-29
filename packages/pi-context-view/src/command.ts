/**
 * `/context` command grammar, argument completions, and Initial capture
 * resolution shared by the Usage and Injections views.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
	buildNativeSnapshot,
	type CompactionState,
	type InitialCaptureState,
	type SilentProbeState,
} from "./capture.ts";
import type { ConfigCreationResult } from "./config.ts";
import type { InitialSnapshot } from "./model.ts";
import { runWithProbeToken } from "./probe-token.ts";
import { normalizePreviewText } from "./text.ts";
import { i18n, NOTICE_SOURCE } from "./i18n.ts";
import { notifyWithSource, type NoticeLevel } from "pi-extensions-i18n";

/** Cap for reported messages, which may quote configuration files and OS error text. */
const MAX_REPORTED_MESSAGE_LENGTH = 500;
const DEFAULT_VIEW: ContextView = "usage";
/** Command argument completions. Descriptions are localized when the palette opens. */
const ARGUMENT_OPTIONS = [
	{ value: "usage", label: "usage", messageKey: "argumentUsage" },
	{ value: "injections", label: "injections", messageKey: "argumentInjections" },
	{ value: "config", label: "config", messageKey: "argumentConfig" },
] as const satisfies readonly { value: string; label: string; messageKey: string }[];

/**
 * Slash-command palette text, kept beside the grammar it describes.
 * RegisteredCommand has no argumentHint; mimic pi's `<hint> — <description>` style.
 * Built per call so the entry follows the locale in effect at registration.
 */
export function contextCommandDescription(): string {
	return i18n.t("commandDescription");
}

/** The focused view a `/context` invocation requests. */
export type ContextView = "usage" | "injections";

/** Parsed `/context` argument grammar. */
export type ContextCommand =
	| { readonly type: "view"; readonly view: ContextView }
	| { readonly type: "config" }
	| { readonly type: "invalid"; readonly message: string };

/** Resolved Initial capture, possibly degraded to the pi-native fallback. */
export interface InitialCaptureResult {
	readonly snapshot: InitialSnapshot;
	readonly degradedReason?: string;
}

/** Parse the complete, intentionally small `/context` argument grammar. */
export function parseContextCommand(argumentsText: string): ContextCommand {
	const words = argumentsText.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return { type: "view", view: DEFAULT_VIEW };
	}
	if (words.length === 1 && words[0] === "usage") {
		return { type: "view", view: "usage" };
	}
	if (words.length === 1 && words[0] === "injections") {
		return { type: "view", view: "injections" };
	}
	if (words.length === 1 && words[0] === "config") {
		return { type: "config" };
	}
	return { type: "invalid", message: i18n.t("usage") };
}

/** Complete full argument values for the supported `/context` grammar. */
export function getContextArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const normalizedPrefix = argumentPrefix.trimStart().toLowerCase();
	const matches = ARGUMENT_OPTIONS.filter((option) => option.value.startsWith(normalizedPrefix));
	return matches.length > 0
		? matches.map((option) => ({ value: option.value, label: option.label, description: i18n.t(option.messageKey) }))
		: null;
}

/** Obtain Initial through passive capture, one silent probe, or a pi-native fallback. */
export async function resolveInitialCapture(
	pi: ExtensionAPI,
	capture: InitialCaptureState,
	probe: SilentProbeState,
	compaction: CompactionState,
	context: ExtensionCommandContext,
): Promise<InitialCaptureResult> {
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	await context.waitForIdle();
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	const unavailableReason = getProbeUnavailableReason(context, compaction.isActive);
	if (unavailableReason !== undefined) {
		return createFallback(pi, context, unavailableReason);
	}

	const attempt = probe.start();
	if (attempt.started) {
		context.ui.setWorkingVisible(false);
		try {
			// Pi emits `input` and `before_agent_start` from inside this call, so the
			// token reaches both handlers and identifies the run even when another
			// extension's input transform rewrites the prompt text.
			runWithProbeToken(attempt.token, () => pi.sendUserMessage(""));
		} catch (error) {
			probe.fail(error instanceof Error ? error.message : String(error));
		}
	}

	try {
		const outcome = await attempt.completion;
		if (outcome.status === "captured" && capture.snapshot !== undefined) {
			return { snapshot: capture.snapshot };
		}
		const reason = outcome.status === "failed" ? outcome.reason : i18n.t("probeNoCapture");
		return createFallback(pi, context, reason);
	} finally {
		if (attempt.started) context.ui.setWorkingVisible(true);
	}
}

/**
 * Report command errors in both interactive and headless modes. Messages can
 * quote untrusted text such as configuration keys, so they are sanitized and
 * capped before reaching the terminal.
 */
export function reportCommandMessage(
	context: ExtensionCommandContext,
	message: string,
	type: NoticeLevel,
): void {
	const safeMessage = truncate(normalizePreviewText(message), MAX_REPORTED_MESSAGE_LENGTH);
	if (context.hasUI) {
		notifyWithSource({ ctx: context, source: NOTICE_SOURCE, level: type, message: safeMessage });
		return;
	}
	process.stderr.write(`${safeMessage}\n`);
}

/** Refuse a view outside TUI mode, naming the form the user typed. */
export function reportTuiOnly(context: ExtensionCommandContext, view: ContextView): void {
	reportCommandMessage(context, i18n.t("tuiOnly", { view }), "warning");
}

/** Report the outcome of the explicit create-only configuration command. */
export function reportConfigCreation(context: ExtensionCommandContext, result: ConfigCreationResult): void {
	switch (result.type) {
		case "created":
			reportCommandMessage(context, i18n.t("configCreated", { path: result.filePath }), "info");
			break;
		case "exists":
			reportCommandMessage(context, i18n.t("configExists", { path: result.filePath }), "warning");
			break;
		case "failed":
			reportCommandMessage(
				context,
				i18n.t("configFailed", { path: result.filePath, reason: result.reason }),
				"error",
			);
			break;
		default: {
			// Compile-time proof that every result variant is reported.
			const _exhaustive: never = result;
			return _exhaustive;
		}
	}
}

/** Shorten over-long text with an ellipsis marker. */
function truncate(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/** Explain why a silent probe cannot run now, or undefined when it can. */
function getProbeUnavailableReason(
	context: ExtensionCommandContext,
	compactionInProgress: boolean,
): string | undefined {
	if (compactionInProgress) return i18n.t("probeCompactionInProgress");
	if (context.model === undefined) return i18n.t("probeNoModel");
	if (!context.modelRegistry.hasConfiguredAuth(context.model)) {
		return i18n.t("probeNoAuth", { provider: context.model.provider });
	}
	return undefined;
}

/** Build a degraded pi-native snapshot when passive capture and probing both failed. */
function createFallback(
	pi: ExtensionAPI,
	context: ExtensionCommandContext,
	reason: string,
): InitialCaptureResult {
	return {
		snapshot: buildNativeSnapshot({
			systemPrompt: context.getSystemPrompt(),
			options: context.getSystemPromptOptions(),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
		}),
		degradedReason: i18n.t("fallbackDegraded", { reason }),
	};
}
