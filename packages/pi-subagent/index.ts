import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	keyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	childExitPath,
	clearChildExited,
	inboxDir,
	isStopped,
	killRun,
	launchRun,
	liveSessions,
	listRuns,
	readMetadata,
	runDisplayName,
	runView,
	type RunMetadata,
	type RunView,
	tmuxSessionName,
	updateMetadata,
	type InboxMessage,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));
const WIDGET_ID = "subagent-status";
const LIVE_VIEWS = new Set<RunView>(["starting", "busy", "idle"]);

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

function formatElapsed(startedAt: string): string {
	const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function borderTop(title: string, info: string, width: number, accent: (text: string) => string): string {
	if (width <= 0) return "";
	if (width === 1) return accent("╭");
	return `${accent("╭")}${accent(joinTop(title, info, width - 2))}${accent("╮")}`;
}

function joinTop(title: string, info: string, inner: number): string {
	const head = `─ ${title} `;
	const tail = ` ${info} ─`;
	const fill = "─".repeat(Math.max(0, inner - head.length - tail.length));
	return `${head}${fill}${tail}`.slice(0, inner).padEnd(inner, "─");
}

function borderBottom(width: number, accent: (text: string) => string): string {
	if (width <= 0) return "";
	if (width === 1) return accent("╰");
	return accent(`╰${"─".repeat(width - 2)}╯`);
}

/** `│left          right│`, with the right side preserved when the line has to shrink. */
function borderLine(
	left: string,
	right: string,
	width: number,
	accent: (text: string) => string,
): string {
	if (width <= 0) return "";
	if (width === 1) return accent("│");
	const inner = Math.max(0, width - 2);
	const rightText = truncateToWidth(right, inner);
	const rightWidth = visibleWidth(rightText);
	const leftText = truncateToWidth(left, Math.max(0, inner - rightWidth));
	const pad = Math.max(0, inner - visibleWidth(leftText) - rightWidth);
	return `${accent("│")}${leftText}${" ".repeat(pad)}${rightText}${accent("│")}`;
}

function statusLabel(view: RunView, theme: Theme): string {
	if (view === "busy") return theme.fg("warning", "active");
	if (view === "idle") return theme.fg("success", "waiting");
	return theme.fg("muted", "starting");
}

function renderWidget(rows: { run: RunMetadata; view: RunView }[], theme: Theme, width: number): string[] {
	const accent = (text: string) => theme.fg("accent", text);
	const lines = [borderTop("Subagents", `${rows.length} running`, width, accent)];
	for (const { run, view } of rows) {
		lines.push(
			borderLine(
				` ${formatElapsed(run.createdAt)}  ${run.name ?? run.handle} `,
				`${statusLabel(view, theme)} `,
				width,
				accent,
			),
		);
	}
	lines.push(borderBottom(width, accent));
	return lines;
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));

		let widgetContext: ExtensionContext | undefined;
		let widgetTimer: ReturnType<typeof setInterval> | undefined;

		const refreshWidget = (): void => {
			const ctx = widgetContext;
			if (!ctx?.hasUI) return;
			const runs = listRuns(ctx.sessionManager.getSessionId());
			if (runs.length === 0) {
				ctx.ui.setWidget(WIDGET_ID, undefined);
				return;
			}
			const live = liveSessions();
			const rows = runs
				.map((run) => ({ run, view: runView(run, live) }))
				.filter(({ view }) => LIVE_VIEWS.has(view));
			if (rows.length === 0) {
				ctx.ui.setWidget(WIDGET_ID, undefined);
				return;
			}
			ctx.ui.setWidget(
				WIDGET_ID,
				(_tui, theme) => ({
					invalidate() {},
					render: (width: number) => renderWidget(rows, theme, width),
				}),
				{ placement: "aboveEditor" },
			);
		};

		const relaunch = (run: RunMetadata, ctx: ExtensionContext): void => {
			try {
				clearChildExited(run.runDir);
				launchRun(updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateMetadata(run.runDir, { error: message });
				if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
			}
		};

		pi.on("session_start", (_event, ctx) => {
			// Children run in detached tmux sessions and are killed on quit, so anything that is not running
			// here either survived the parent or has to be restarted with its full history.
			const live = liveSessions();
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (live.has(tmuxSessionName(run.handle))) continue;
				if (isStopped(run.runDir) || !run.hasStarted) continue;
				if (!existsSync(run.sessionFile)) continue;
				relaunch(run, ctx);
			}

			widgetContext = ctx;
			if (!ctx.hasUI) return;
			refreshWidget();
			if (!widgetTimer) {
				widgetTimer = setInterval(refreshWidget, 1000);
				widgetTimer.unref();
			}
		});

		pi.on("session_shutdown", (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget(WIDGET_ID, undefined);
			if (event.reason === "reload") return;
			// Stop the children so a quit does not leave detached Pi processes burning tokens. Transcript
			// and metadata stay on disk; the next session_start relaunches them.
			const live = liveSessions();
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				try {
					killRun(run.handle, live);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (ctx.hasUI) ctx.ui.notify(`Could not stop ${runDisplayName(run)}: ${message}`, "error");
				}
			}
		});

		pi.registerCommand("subagent", {
			description: "Attach to a running subagent of this session",
			handler: async (_args, ctx) => {
				const live = liveSessions();
				const runs = listRuns(ctx.sessionManager.getSessionId()).filter((run) =>
					live.has(tmuxSessionName(run.handle)),
				);
				if (runs.length === 0) {
					ctx.ui.notify("No running subagents in this session", "info");
					return;
				}

				const items: SelectItem[] = runs.map((run) => ({
					value: run.handle,
					label: `${runDisplayName(run)}  ${runView(run, live)}  ${run.provider}/${run.model}  ${run.thinking}`,
				}));
				let tui: TUI | undefined;
				const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
					tui = customTui;
					const list = new SelectList(items, Math.min(items.length, 10), {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					});
					list.onSelect = (item) => done(item.value);
					list.onCancel = () => done(undefined);

					const container = new Container();
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					container.addChild(new Text(theme.fg("accent", theme.bold("Attach to subagent")), 1, 0));
					container.addChild(list);
					container.addChild(
						new Text(
							theme.fg(
								"dim",
								`${keyHint("tui.select.confirm", "attach")}  ${keyHint("tui.select.cancel", "cancel")}`,
							),
							1,
							0,
						),
					);
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

					return {
						render: (width) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							list.handleInput(data);
							customTui.requestRender();
						},
					};
				});
				if (!selected || !tui) return;
				const run = runs.find((candidate) => candidate.handle === selected);
				if (!run) return;
				const session = tmuxSessionName(run.handle);

				if (process.env.TMUX) {
					const exitCode = await new Promise<number | null>((resolveExit) => {
						const child = spawn("tmux", ["switch-client", "-t", `=${session}`], { stdio: "inherit" });
						child.on("error", () => resolveExit(null));
						child.on("close", resolveExit);
					});
					if (exitCode !== 0) ctx.ui.notify(`Could not switch to ${run.handle}`, "error");
					return;
				}

				tui.stop();
				try {
					const exitCode = await new Promise<number | null>((resolveExit) => {
						const child = spawn("tmux", ["attach-session", "-t", `=${session}`], { stdio: "inherit" });
						child.on("error", () => resolveExit(null));
						child.on("close", resolveExit);
					});
					if (exitCode !== 0) process.stderr.write(`Could not attach to ${run.handle}\n`);
				} finally {
					tui.start();
					tui.requestRender(true);
				}
			},
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let sessionName: string | undefined;

	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		sessionName = next;
	};

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		syncSessionName();
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					updateMetadata(runDir, { error: error instanceof Error ? error.message : String(error) });
					continue;
				}

				updateMetadata(runDir, { state: "busy", error: undefined });
				try {
					if (currentContext.isIdle()) {
						pi.sendUserMessage(payload.message);
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						});
					}
					unlinkSync(path);
				} catch (error) {
					updateMetadata(runDir, {
						state: currentContext.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}
		} finally {
			processing = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		clearChildExited(runDir);
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			error: undefined,
		});
		syncSessionName();
		if (!timer) {
			timer = setInterval(() => void processInbox(), 250);
			timer.unref();
		}
		void processInbox();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (ctx.isIdle()) updateMetadata(runDir, { state: "idle" });
	});

	pi.on("session_shutdown", () => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		// Record the exit so the parent can wait for it before it reopens this transcript.
		writeFileSync(childExitPath(runDir), "", { mode: 0o600 });
	});
}
