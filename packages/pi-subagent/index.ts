import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openSubagentConfigPanel } from "./config-panel.ts";
import { formatRoleCatalog, loadRoles } from "./roles.ts";
import {
	closeRunSurface,
	getAgentDir,
	inboxDir,
	inboxMessageId,
	inboxMessageText,
	launchRun,
	listRuns,
	readMetadata,
	removeRunDir,
	runDisplayName,
	runSurfaceState,
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
		pi.on("before_agent_start", (event) => {
			const catalog = formatRoleCatalog(loadRoles());
			if (catalog) event.systemPromptOptions.appendSystemPrompt = [
				event.systemPromptOptions.appendSystemPrompt,
				catalog,
			].filter(Boolean).join("\n\n");
		});
	}

	if (!runDir) {
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
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (event.reason === "reload") return;
			// Suspend running children: close the panel but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (runSurfaceState(run.surface) === "absent") {
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
		pi.registerCommand("config:subagent", {
			description: "Configure subagent role presets (model, thinking, tools, extensions)",
			handler: (_args, ctx) => openSubagentConfigPanel(pi, ctx),
		});
		return;
	}

	const promptFile = readMetadata(runDir)?.appendSystemPromptFile;
	const appendSystemPrompt = promptFile ? readFileSync(promptFile, "utf8") : undefined;
	if (appendSystemPrompt) {
		pi.on("before_agent_start", (event) => {
			// Keep Pi's discovered APPEND_SYSTEM.md and structured base prompt intact.
			event.systemPromptOptions.appendSystemPrompt = [
				event.systemPromptOptions.appendSystemPrompt,
				appendSystemPrompt,
			].filter(Boolean).join("\n\n");
		});
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let sessionName: string | undefined;
	const inFlight = new Map<string, number>();

	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		sessionName = next;
	};

	const processInbox = (): void => {
		if (processing || !currentContext) return;
		processing = true;
		try {
			syncSessionName();
			const queueDir = inboxDir(runDir);
			if (!existsSync(queueDir)) return;
			// sendUserMessage returns void and hides asynchronous failures. A receipt
			// is accepted only after the uniquely tagged user message is persisted.
			const accepted = new Set<string>();
			for (const entry of currentContext.sessionManager.getBranch()) {
				if (entry.type === "message" && entry.message.role === "user") {
					const id = inboxMessageId(entry.message.content);
					if (id) accepted.add(id);
				}
			}
			const names = readdirSync(queueDir).filter((entry) => entry.endsWith(".json")).sort();
			for (const name of names) {
				if (accepted.has(name)) {
					unlinkSync(join(queueDir, name));
					inFlight.delete(name);
				}
			}
			// Serialize idle preflight; do not issue a second prompt while the first
			// is awaiting auth/input/compaction. Retain unacknowledged disk messages.
			if (currentContext.isIdle() && inFlight.size > 0) {
				if (!currentContext.hasPendingMessages() && Date.now() - Math.min(...inFlight.values()) > 5000 &&
					readMetadata(runDir)?.state !== "error") {
					updateMetadata(runDir, { state: "error", error: "Message was not accepted; inbox retained. Fix the cause and reload or resume to retry." });
				}
				return;
			}
			if (readMetadata(runDir)?.state === "error") return;
			// A reload can retain Pi's in-memory queues while replacing this map.
			if (inFlight.size === 0 && currentContext.hasPendingMessages()) return;
			for (const name of names) {
				if (accepted.has(name) || inFlight.has(name)) continue;
				const value: unknown = JSON.parse(readFileSync(join(queueDir, name), "utf8"));
				if (!isInboxMessage(value)) throw new Error(`Invalid inbox message: ${name}`);
				updateMetadata(runDir, { state: "busy", error: undefined });
				inFlight.set(name, Date.now());
				pi.sendUserMessage(inboxMessageText(name, value.message), {
					deliverAs: value.delivery === "followUp" ? "followUp" : "steer",
				});
				return;
			}
		} catch (error) {
			updateMetadata(runDir, { state: "error", error: error instanceof Error ? error.message : String(error) });
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
			timer = setInterval(processInbox, 250);
			timer.unref();
		}
		processInbox();
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
