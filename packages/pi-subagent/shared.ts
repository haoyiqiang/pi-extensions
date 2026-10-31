import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The child's own lifecycle position. Written by the child, or by the parent when it launches one. */
export type RunState = "starting" | "busy" | "idle";

/** A run's state for humans and CLI output: the child's state while it lives, and the two facts a dead run can show. */
export type RunView = RunState | "interrupted" | "unstarted" | "stopped";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

/** Present only after `subagent stop`. Its presence is the single durable record of "the user ended this". */
export function stoppedPath(runDir: string): string {
	return join(runDir, "stopped");
}

/** Written by the child when its Pi process shuts down, so the parent can wait for it before reopening a session. */
export function childExitPath(runDir: string): string {
	return join(runDir, "exited");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		// Records written by the retired panel-based release used "exited" and "error" as states. They are
		// never live, so normalizing them to "idle" only affects runs that are about to be relaunched.
		return { ...(metadata as RunMetadata), state: normalizeState(metadata.state) };
	} catch {
		return undefined;
	}
}

function normalizeState(value: unknown): RunState {
	return value === "starting" || value === "busy" ? value : "idle";
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

/** Every subagent owns one tmux session whose name is derived from its handle, so no run needs to store it. */
export function tmuxSessionName(handle: string): string {
	return `pi-subagent-${handle}`;
}

/**
 * Names of all live tmux sessions. One call per command instead of one probe per run, and an absent tmux
 * server simply means nothing is running.
 */
export function liveSessions(): Set<string> {
	const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
	if (result.status !== 0) return new Set();
	return new Set(result.stdout.split("\n").filter(Boolean));
}

export function isStopped(runDir: string): boolean {
	return existsSync(stoppedPath(runDir));
}

export function markStopped(runDir: string): void {
	writeFileSync(stoppedPath(runDir), "", { mode: 0o600 });
}

export function clearStopped(runDir: string): void {
	rmSync(stoppedPath(runDir), { force: true });
}

export function clearChildExited(runDir: string): void {
	rmSync(childExitPath(runDir), { force: true });
}

/** Resolve once the child recorded its shutdown, or when the timeout runs out. */
export async function waitForChildExit(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(childExitPath(runDir))) return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

/**
 * A run is alive when its tmux session exists. Everything else is derived: a dead run that the user ended is
 * stopped, one that had started working is interrupted and can be resumed, and one that never got going is a
 * failed spawn.
 */
export function runView(metadata: RunMetadata, live: Set<string>): RunView {
	if (live.has(tmuxSessionName(metadata.handle))) return metadata.state;
	if (isStopped(metadata.runDir)) return "stopped";
	return metadata.hasStarted ? "interrupted" : "unstarted";
}

function controlBridgeArgs(launchArgs: string[] | undefined): string[] {
	const provided = (launchArgs ?? []).some(
		(arg, index, all) => (arg === "--extension" || arg === "-e") && all[index + 1] === extensionPath,
	);
	return provided ? [] : ["--extension", extensionPath];
}

/** Start the child pi process in its own detached tmux session. `initialArgs` is passed on the first spawn only. */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): void {
	const result = spawnSync(
		"tmux",
		[
			"new-session",
			"-d",
			"-s",
			tmuxSessionName(metadata.handle),
			"-x",
			"120",
			"-y",
			"40",
			"-c",
			metadata.cwd,
			"--",
			"env",
			`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
			"pi",
			"--session",
			metadata.sessionFile,
			"--provider",
			metadata.provider,
			"--model",
			metadata.model,
			"--thinking",
			metadata.thinking,
			...(metadata.launchArgs ?? []),
			...controlBridgeArgs(metadata.launchArgs),
			...initialArgs,
		],
		{ encoding: "utf8" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to create tmux session");
}

/** Kill the run's tmux session. Returns whether there was a live session to kill. */
export function killRun(handle: string, live = liveSessions()): boolean {
	const session = tmuxSessionName(handle);
	if (!live.has(session)) return false;
	const result = spawnSync("tmux", ["kill-session", "-t", `=${session}`], { encoding: "utf8" });
	// A session that vanished between the inventory and the kill is already in the desired state.
	if (result.status !== 0 && liveSessions().has(session))
		throw new Error(result.stderr.trim() || `Failed to kill tmux session ${session}`);
	return true;
}

export function pendingMessageCount(runDir: string): number {
	const queueDir = inboxDir(runDir);
	if (!existsSync(queueDir)) return 0;
	return readdirSync(queueDir).filter((entry) => entry.endsWith(".json")).length;
}

/** Compact, human-readable run age: 42s, 2m14s, 3h07m, 2d04h. */
export function runAge(metadata: RunMetadata): string {
	const seconds = Math.max(0, Math.round((Date.now() - Date.parse(metadata.createdAt)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
