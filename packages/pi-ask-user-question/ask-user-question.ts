import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { LOCALE_CHANGED_EVENT, NOTICE_TAG_COLOR, notifyWithSource, type NoticeSource } from "pi-utils";
import {
	COLLAPSE_KEY_OFF,
	formatKeySpecForDisplay,
	loadConfigResult,
	resolveCollapseKey,
	validateGuidanceFields,
} from "./config.js";
import {
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
} from "./events.js";
// Static import is fine — rpc-fallback pulls only types + the i18n bridge,
// none of the ~560ms TUI render graph that QuestionnaireSession lazy-loads.
import { type DialogUI, hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.js";
import { displayLabel, i18n } from "./state/i18n-bridge.js";
import { sentinelsToAppend } from "./state/row-intent.js";
import { normalizeQuestionParams } from "./tool/normalize-params.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionnaireError,
	type QuestionnaireResult,
	type QuestionParams,
	buildQuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams): void {
	const payload: AskUserPromptEventPayload = {
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

function emitAskUserBlockedEvent(pi: ExtensionAPI, active: boolean): void {
	const payload: AskUserBlockedEventPayload = { active };
	pi.events.emit(ASK_USER_BLOCKED_EVENT, payload);
}

const NOTICE_SOURCE: NoticeSource = { tag: "ask", color: NOTICE_TAG_COLOR };

/** Non-interactive host backstop (the reconciler normally strips the tool first). */
function rejectWithoutUi() {
	return buildToolResult(i18n.t("error.no_ui"), { answers: [], cancelled: true, error: "no_ui" });
}

/** Cancellation before any prompt is shown: no prompt/blocked event, listener, bell, or dialog. */
function cancelBeforePrompt(params: QuestionParams) {
	return buildQuestionnaireResponse({ answers: [], cancelled: true }, params);
}

/** Sequential native-dialog walker for RPC hosts; brackets it with the blocked-event pair + terminal bell. */
async function runRpcPath(pi: ExtensionAPI, ui: DialogUI, typed: QuestionParams, signal: AbortSignal) {
	emitAskUserBlockedEvent(pi, true);
	try {
		emitTerminalAttention();
		return buildQuestionnaireResponse(await runRpcQuestionnaire(ui, typed, signal), typed);
	} finally {
		emitAskUserBlockedEvent(pi, false);
	}
}

/** Canonical tool name — single source of truth shared with the reconcile module. */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";


/** Standard terminal bell — same byte rpiv-warp exports as OSC_TERMINATOR. */
export const BEL = "\x07";

/**
 * Emit one portable terminal attention signal without touching redirected output.
 * Writes to stdout rather than rpiv-warp's `/dev/tty` transport: the `isTTY` gate
 * both proves an interactive terminal owns the coming wait and keeps the byte out
 * of piped RPC transports (VS Code pendant, Zed) — a `/dev/tty` write would ring
 * even when the questionnaire renders in a remote host's own UI.
 */
function emitTerminalAttention(): void {
	try {
		if (process.stdout.isTTY) process.stdout.write(BEL);
	} catch {
		// Terminal attention is best effort; the questionnaire must still proceed.
	}
}

/** Delay before the background session-graph pre-warm; mirrors rpiv-workflow's /wf prewarm. */
export const PREWARM_DELAY_MS = 2000;

type SessionModule = typeof import("./state/questionnaire-session.js");

type SessionRef = { current: import("./state/questionnaire-session.js").QuestionnaireSession | null };
type OverlayHandleRef = { current: OverlayHandle | undefined };

type SessionLoad =
	| { ok: true; module: SessionModule }
	| { ok: false; error: Extract<QuestionnaireError, "session_load_failed" | "stale_module_cache">; message: string };

/**
 * Lazy-load the ~560ms QuestionnaireSession view/TUI render graph, guarding
 * the two failure shapes of issue #107. Pi's jiti loader registers a module in
 * its graph cache BEFORE evaluating the body and does not evict it when
 * evaluation throws (jiti 2.7.0), so one failed load — e.g. `pnpm install
 * --force` replacing the store entry mid-session — leaves every later import
 * of this specifier resolving to a namespace without the class. That state is
 * unrecoverable in-process (cache-busting specifiers fail jiti resolution);
 * both branches therefore return an LLM-facing envelope that names the restart
 * requirement instead of leaking a bare "not a constructor" TypeError.
 */
export async function loadQuestionnaireSession(): Promise<SessionLoad> {
	let mod: SessionModule;
	try {
		mod = await import("./state/questionnaire-session.js");
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		return { ok: false, error: "session_load_failed", message: i18n.t("error.session_load_failed", { cause }) };
	}
	if (typeof mod.QuestionnaireSession !== "function") {
		const keys = JSON.stringify(Object.keys(mod));
		return {
			ok: false,
			error: "stale_module_cache",
			message: i18n.t("error.stale_module_cache", { keys }),
		};
	}
	return { ok: true, module: mod };
}

/**
 * Register the raw terminal listener that toggles collapse while the overlay is hidden.
 * Returns the remover, or undefined when the key is off / the host has no raw input hook —
 * callers derive `canReopenWhileHidden` from that.
 */
function registerCollapseKeyListener(
	ctx: ExtensionContext,
	collapseKey: string,
	sessionRef: SessionRef,
	overlayHandleRef: OverlayHandleRef,
): (() => void) | undefined {
	if (collapseKey === COLLAPSE_KEY_OFF || typeof ctx.ui.onTerminalInput !== "function") return undefined;
	let hasAnnouncedHide = false;
	return ctx.ui.onTerminalInput((data) => {
		const handle = overlayHandleRef.current;
		if (!handle) return undefined;
		// Only act while the questionnaire is hidden (its handleInput is
		// unreachable) or actually focused. When some other overlay is on
		// top (e.g. `/btw`), leave the keystroke to that overlay instead of
		// toggling the questionnaire from underneath it.
		if (!handle.isHidden() && !handle.isFocused()) return undefined;
		if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
		// Kitty-protocol terminals report press, repeat, and release separately.
		// Toggle only on the initial press so a tap does not immediately reopen
		// the overlay and a held key does not toggle it repeatedly.
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
		sessionRef.current?.toggleCollapsedExternal();
		if (handle.isHidden() && !hasAnnouncedHide) {
			hasAnnouncedHide = true;
			notifyWithSource({
				ctx,
				source: NOTICE_SOURCE,
				level: "info",
				message: i18n.t("notice.hidden", { key: formatKeySpecForDisplay(collapseKey) }),
			});
		}
		return { consume: true };
	});
}

/**
 * Build the `ctx.ui.custom` component factory: constructs the session (capturing it in
 * `sessionRef`) and exposes its component. `editInput` keeps its two dynamic imports —
 * they must stay lazy per-invocation.
 */
function makeSessionFactory(config: {
	ctx: ExtensionContext;
	typed: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	collapseKey: string;
	canReopenWhileHidden: boolean;
	sessionRef: SessionRef;
	Session: SessionModule["QuestionnaireSession"];
	signal: AbortSignal;
	resumeTui: () => boolean;
}) {
	const { ctx, typed, itemsByTab, collapseKey, canReopenWhileHidden, sessionRef, Session, signal, resumeTui } = config;
	return (
		tui: TUI,
		theme: Theme,
		keybindings: import("./state/questionnaire-session.js").QuestionnaireSessionConfig["keybindings"],
		done: (result: QuestionnaireResult) => void,
	): import("./state/questionnaire-session.js").QuestionnaireSessionComponent => {
		const session = new Session({
			tui,
			theme,
			params: typed,
			itemsByTab,
			done,
			keybindings,
			signal,
			editInput: async (value, editorSignal) => {
				try {
					const [{ SettingsManager, ProjectTrustStore }, { resolveAgentDir }, { editWithExternalEditor }] =
						await Promise.all([
							import("@earendil-works/pi-coding-agent"),
							import("pi-utils"),
							import("./state/external-editor.js"),
						]);
					if (editorSignal.aborted) return undefined;
					const agentDir = resolveAgentDir();
					let settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: false });
					const trustDecision = new ProjectTrustStore(agentDir).get(ctx.cwd);
					if (
						trustDecision === true ||
						(trustDecision !== false && settings.getDefaultProjectTrust() === "always")
					) {
						settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: true });
					}
					const command = settings.getExternalEditorCommand();
					return await editWithExternalEditor(tui, command, value, {
						signal: editorSignal,
						launchMessage: i18n.t("editor.launch", { command }),
						resumeTui,
					});
				} catch (error) {
					if (editorSignal.aborted) return undefined;
					const message = error instanceof Error ? error.message : String(error);
					notifyWithSource({
						ctx,
						source: NOTICE_SOURCE,
						level: "error",
						message: i18n.t("editor.failed", { error: message }),
					});
					return undefined;
				}
			},
			collapseKey,
			canReopenWhileHidden,
		});
		sessionRef.current = session;
		if (signal.aborted) queueMicrotask(() => session.cancelExternal());
		return session.component;
	};
}

/**
 * A TUI questionnaire ALWAYS resolves a QuestionnaireResult (cancel included), so
 * `undefined` uniquely means "host cannot render", never "user declined". RPC builds
 * that predate ctx.mode land here: run the dialog walker when the host has the
 * primitives; otherwise tell the model the user never saw the questions.
 */
async function resolveUndefinedResult(ctx: ExtensionContext, typed: QuestionParams, signal: AbortSignal) {
	if (ctx.mode === "rpc" && hasDialogUI(ctx.ui)) {
		return buildQuestionnaireResponse(await runRpcQuestionnaire(ctx.ui, typed, signal), typed);
	}
	return buildToolResult(i18n.t("error.no_custom_ui"), {
		answers: [],
		cancelled: true,
		error: "no_custom_ui",
	});
}

/**
 * Pre-warm the lazy session graph once startup settles (#107). A graph
 * evaluated while the paths Pi resolved at boot still exist stays in memory
 * for the process lifetime, so later on-disk dependency churn (e.g. `pnpm
 * install --force` replacing the store mid-session) can no longer poison
 * jiti's graph cache. Swallowed failure is safe: the first real call
 * re-imports and surfaces it through loadQuestionnaireSession's structured
 * envelope. unref keeps the timer from holding a non-TUI embedder's process
 * open.
 */
function scheduleSessionGraphPrewarm(): ReturnType<typeof setTimeout> {
	const timer = setTimeout(() => void loadQuestionnaireSession().catch(() => undefined), PREWARM_DELAY_MS);
	timer.unref?.();
	return timer;
}

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

const guidanceParams = { maxQuestions: MAX_QUESTIONS, minOptions: MIN_OPTIONS, maxOptions: MAX_OPTIONS };
export const DEFAULT_PROMPT_SNIPPET = i18n.t("tool.prompt_snippet", guidanceParams);
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	i18n.t("tool.guideline.1", guidanceParams),
	i18n.t("tool.guideline.2", guidanceParams),
	i18n.t("tool.guideline.3", guidanceParams),
	i18n.t("tool.guideline.4", guidanceParams),
];
export const DEFAULT_TOOL_DESCRIPTION = i18n.t("tool.description");

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const loadedConfig = loadConfigResult();
	const guidance = validateGuidanceFields(loadedConfig.config.guidance);
	const activeCancels = new Set<(shutdown?: boolean) => Promise<void>>();
	let prewarmTimer: ReturnType<typeof setTimeout> | undefined;
	let metadataLocale: string | undefined;
	const releaseLocale = pi.events.on(LOCALE_CHANGED_EVENT, refreshMetadata);
	pi.on("input", refreshMetadata);
	pi.on("before_agent_start", refreshMetadata);

	pi.on("session_start", (_event, ctx) => {
		refreshMetadata();
		for (const message of loadedConfig.diagnostics) {
			notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message });
		}
		if (ctx.mode !== "tui") return;
		if (prewarmTimer) clearTimeout(prewarmTimer);
		prewarmTimer = scheduleSessionGraphPrewarm();
	});
	pi.on("session_shutdown", async () => {
		releaseLocale();
		if (prewarmTimer) clearTimeout(prewarmTimer);
		prewarmTimer = undefined;
		const cancellations = [...activeCancels].map((cancel) => cancel(true));
		await Promise.allSettled(cancellations);
		activeCancels.clear();
	});

	function refreshMetadata() {
		const locale = i18n.locale();
		if (metadataLocale === locale) return;
		metadataLocale = locale;
		pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: i18n.t("tool.label"),
		description: guidance.description ?? i18n.t("tool.description"),
		promptSnippet: guidance.promptSnippet ?? i18n.t("tool.prompt_snippet", guidanceParams),
		promptGuidelines:
			guidance.promptGuidelines ??
			[1, 2, 3, 4].map((index) =>
				i18n.t(`tool.guideline.${index}` as Parameters<typeof i18n.t>[0], guidanceParams),
			),
		parameters: buildQuestionParamsSchema(),
		executionMode: "sequential",

		async execute(_toolCallId, params, toolSignal, _onUpdate, ctx) {
			const typed = normalizeQuestionParams(params as unknown as QuestionParams);
			if (!ctx.hasUI) return rejectWithoutUi();

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, { answers: [], cancelled: true, error: validation.error });
			}

			const interactionController = new AbortController();
			const sessionRef: SessionRef = { current: null };
			let sessionClosing = false;
			const cancelInteraction = async (shutdown = false) => {
				if (shutdown) sessionClosing = true;
				interactionController.abort();
				await sessionRef.current?.cancelExternal();
			};
			const cancelFromTool = () => void cancelInteraction();
			if (toolSignal?.aborted) interactionController.abort();
			else toolSignal?.addEventListener("abort", cancelFromTool, { once: true });
			activeCancels.add(cancelInteraction);
			const signal = interactionController.signal;

			try {
				if (ctx.mode === "rpc") {
					if (signal.aborted) return cancelBeforePrompt(typed);
					if (!hasDialogUI(ctx.ui)) {
						return buildToolResult(i18n.t("error.no_custom_ui"), {
							answers: [],
							cancelled: true,
							error: "no_custom_ui",
						});
					}
					emitAskUserPromptEvent(pi, typed);
					return await runRpcPath(pi, ctx.ui, typed, signal);
				}

				if (ctx.mode !== "tui") {
					return buildToolResult(i18n.t("error.no_custom_ui"), {
						answers: [],
						cancelled: true,
						error: "no_custom_ui",
					});
				}
				if (signal.aborted) return cancelBeforePrompt(typed);

				const itemsByTab: WrappingSelectItem[][] = typed.questions.map((question) =>
					buildItemsForQuestion(question),
				);
				const sessionLoad = await loadQuestionnaireSession();
				if (signal.aborted) return cancelBeforePrompt(typed);
				if (!sessionLoad.ok) {
					return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
				}

				const collapseKey = resolveCollapseKey(loadedConfig.config);
				const overlayHandleRef: OverlayHandleRef = { current: undefined };
				const removeOverlayInputListener = registerCollapseKeyListener(
					ctx,
					collapseKey,
					sessionRef,
					overlayHandleRef,
				);
				const cancelSession = () => void sessionRef.current?.cancelExternal();
				signal.addEventListener("abort", cancelSession, { once: true });
				emitAskUserPromptEvent(pi, typed);
				emitAskUserBlockedEvent(pi, true);
				try {
					emitTerminalAttention();
					const result = await ctx.ui.custom<QuestionnaireResult>(
						makeSessionFactory({
							ctx,
							typed,
							itemsByTab,
							collapseKey,
							canReopenWhileHidden: removeOverlayInputListener !== undefined,
							sessionRef,
							Session: sessionLoad.module.QuestionnaireSession,
							signal,
							resumeTui: () => !sessionClosing,
						}),
						{
							overlay: true,
							overlayOptions: {
								anchor: "bottom-center",
								width: "100%",
								maxHeight: "100%",
								margin: { left: 0, right: 0, bottom: 0 },
							},
							onHandle: (handle) => {
								overlayHandleRef.current = handle;
								sessionRef.current?.setOverlayHandle(handle);
							},
						},
					);
					if (result === undefined) return resolveUndefinedResult(ctx, typed, signal);
					return buildQuestionnaireResponse(result, typed);
				} finally {
					signal.removeEventListener("abort", cancelSession);
					removeOverlayInputListener?.();
					emitAskUserBlockedEvent(pi, false);
				}
			} finally {
				toolSignal?.removeEventListener("abort", cancelFromTool);
				activeCancels.delete(cancelInteraction);
			}
		},
		});
	}
	refreshMetadata();
}

export { buildQuestionnaireResponse, buildToolResult };
