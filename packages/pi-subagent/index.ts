import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	closeRunSurface,
	effectiveRunState,
	hasPendingInbox,
	inboxDir,
	launchRun,
	listRuns,
	readMetadata,
	removeRunDir,
	runDisplayName,
	stopRun,
	surfaceGone,
	type InboxMessage,
	updateMetadata,
	waitForRunShutdown,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

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
		pi.on("session_start", (_event, ctx) => {
			// Relaunch children that were suspended when this session was last quit or switched away from.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.suspended || !surfaceGone(run.surface)) continue;
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
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (event.reason === "reload") return;
			// Suspend running children: stop the process but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (surfaceGone(run.surface)) {
					if (!run.suspended) removeRunDir(run.runDir);
					continue;
				}
				updateMetadata(run.runDir, { suspended: true });
				try {
					closeRunSurface(run.surface);
					await waitForRunShutdown(run.runDir);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					updateMetadata(run.runDir, { error: message });
					if (ctx.hasUI) ctx.ui.notify(`Could not suspend ${runDisplayName(run)}: ${message}`, "error");
				}
			}
		});
		// `spawn --auto-stop` runs are stopped at the end of the turn that owns them, once the child is
		// idle and has no queued message. Busy, failed, and already exited runs keep their records so the
		// transcript stays available for inspection.
		pi.on("turn_end", (_event, ctx) => {
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.autoStop || !run.hasStarted) continue;
				if (effectiveRunState(run) !== "idle" || hasPendingInbox(run.runDir)) continue;
				void stopRun(run).catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					if (ctx.hasUI) ctx.ui.notify(`Could not auto-stop ${runDisplayName(run)}: ${message}`, "warning");
				});
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
