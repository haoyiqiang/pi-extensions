import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { renderSubagentWidget, type SubagentWidgetRun } from "./widget.ts";
import {
	closeRunSurface,
	effectiveRunState,
	getAgentDir,
	inboxDir,
	launchRun,
	listRuns,
	readMetadata,
	removeRunDir,
	runDisplayName,
	surfaceAlive,
	updateMetadata,
	waitForRunShutdown,
	type InboxMessage,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

/** Link this package's CLI into Pi's bin dir. Pi prepends that dir to bash PATH. */
function ensureSubagentBin(): "ready" | "blocked" | "failed" {
	const target = join(packageDir, "subagent.ts");
	const linkPath = join(getAgentDir(), "bin", "subagent");
	try {
		try {
			chmodSync(target, 0o755);
		} catch {
			// A read-only install can still run when the file is already executable.
		}
		mkdirSync(dirname(linkPath), { recursive: true });
		try {
			if (!lstatSync(linkPath).isSymbolicLink()) return "blocked";
			if (readlinkSync(linkPath) === target) return "ready";
			unlinkSync(linkPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "failed";
		}
		symlinkSync(target, linkPath);
		return "ready";
	} catch {
		return "failed";
	}
}

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
	}

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;
		let widgetTui: TUI | undefined;
		let widgetMounted = false;

		const widgetRuns = (): SubagentWidgetRun[] => {
			if (!widgetContext) return [];
			return listRuns(widgetContext.sessionManager.getSessionId())
				.map((run) => ({
					name: run.name ?? run.handle,
					startTime: Date.parse(run.createdAt),
					state: effectiveRunState(run),
				}))
				.filter((run) => run.state !== "exited");
		};

		const refreshWidget = (): void => {
			if (!widgetContext) return;
			if (widgetRuns().length === 0) {
				if (widgetMounted) widgetContext.ui.setWidget("subagents", undefined);
				widgetMounted = false;
				widgetTui = undefined;
				return;
			}
			if (!widgetMounted) {
				widgetContext.ui.setWidget(
					"subagents",
					(tui, _theme) => {
						widgetTui = tui;
						return {
							render: (width) => renderSubagentWidget(widgetRuns(), width),
							invalidate() {},
						};
					},
					{ placement: "aboveEditor" },
				);
				widgetMounted = true;
				return;
			}
			widgetTui?.requestRender();
		};

		pi.on("session_start", (_event, ctx) => {
			const linked = ensureSubagentBin();
			if (ctx.hasUI && linked === "failed") {
				ctx.ui.notify("Could not link subagent into the Pi bin directory", "warning");
			} else if (ctx.hasUI && linked === "blocked") {
				ctx.ui.notify("Pi bin already has a subagent command that is not a symlink; left it unchanged", "warning");
			}

			// Relaunch children that were suspended when this session was last quit or switched away from.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.suspended || surfaceAlive(run.surface)) continue;
				if (!existsSync(run.sessionFile)) {
					removeRunDir(run.runDir);
					continue;
				}
				const starting = updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run;
				try {
					launchRun(starting);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					updateMetadata(run.runDir, { state: "error", error: message });
					if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
				}
			}

			if (!ctx.hasUI) return;
			widgetContext = ctx;
			refreshWidget();
			widgetTimer = setInterval(refreshWidget, 1000);
			widgetTimer.unref();
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			widgetTui = undefined;
			widgetMounted = false;
			ctx.ui.setWidget("subagents", undefined);
			if (event.reason === "reload") return;
			// Suspend running children: close the panel but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!surfaceAlive(run.surface)) {
					if (!run.suspended) removeRunDir(run.runDir);
					continue;
				}
				updateMetadata(run.runDir, { suspended: true });
				closeRunSurface(run.surface);
				await waitForRunShutdown(run.runDir);
			}
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
					updateMetadata(runDir, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
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
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			suspended: undefined,
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

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason === "quit") updateMetadata(runDir, { state: "exited" });
	});
}
