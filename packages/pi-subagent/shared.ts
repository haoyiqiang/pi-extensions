import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionConfigPath } from "@kevinhao/pi-utils";
import {
	closeSurface,
	createSurface,
	createSurfaceRenameContext,
	getMuxBackend,
	isMuxAvailable,
	muxSetupHint,
	parseOrcaTerminalTabInfo,
	readScreen,
	shellEscape,
	TERMINAL_RENAME_CONTEXT_ENV,
} from "@kevinhao/pi-terminal-mux";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	/** Terminal panel created by pi-terminal-mux. Empty until launch. */
	surface: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Explicit pi CLI tool and resource options reused when the run is relaunched. */
	launchArgs?: string[];
	/** Snapshot of additional system instructions, applied by the child control bridge. */
	appendSystemPromptFile?: string;
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	/** Monotonic metadata revision used to detect concurrent updates. */
	revision?: number;
	/** Assistant entry that predates the latest send; never return it as that send's result. */
	responseAfter?: string;
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

const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(dirname(extensionConfigPath("pi-subagent", "config.json", getAgentDir())), "runs");
}

export function legacyRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function runDirForHandle(handle: string): string {
	const next = join(getRunsDir(), handle);
	if (existsSync(next) || !existsSync(join(legacyRunsDir(), handle))) return next;
	return join(legacyRunsDir(), handle);
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
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
			typeof metadata.surface !== "string" ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

function withRunLock<T>(runDir: string, action: () => T): T | undefined {
	const lock = join(runDir, "metadata.lock");
	const deadline = Date.now() + 5000;
	while (true) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			writeFileSync(join(lock, "owner"), String(process.pid), { mode: 0o600 });
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return undefined;
			if (code !== "EEXIST") throw error;
			try {
				const owner = Number(readFileSync(join(lock, "owner"), "utf8"));
				if (Number.isInteger(owner) && owner > 0) {
					try {
						process.kill(owner, 0);
					} catch (ownerError) {
						if ((ownerError as NodeJS.ErrnoException).code === "ESRCH") {
							rmSync(lock, { recursive: true, force: true });
							continue;
						}
					}
				}
			} catch {
				// Recover a creator that died before writing its owner PID.
				if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 30_000) {
					rmSync(lock, { recursive: true, force: true });
					continue;
				}
			}
			if (Date.now() >= deadline) throw new Error(`Timed out locking metadata: ${runDir}`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
	try {
		return action();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

function writeMetadataUnlocked(metadata: RunMetadata): void {
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(metadata.runDir, { recursive: true, mode: 0o700 });
	withRunLock(metadata.runDir, () => writeMetadataUnlocked({ ...metadata, revision: 1 }));
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	return withRunLock(runDir, () => {
		const current = readMetadata(runDir);
		if (!current) return undefined;
		const next: RunMetadata = {
			...current,
			...patch,
			version: 1,
			handle: current.handle,
			runDir: current.runDir,
			revision: (current.revision ?? 0) + 1,
			updatedAt: new Date().toISOString(),
		};
		writeMetadataUnlocked(next);
		return next;
	});
}

/** Absence must be confirmed by a successful terminal inventory, not a failed read. */
export function runSurfaceState(surface: string): "present" | "absent" | "unknown" {
	if (!surface) return "unknown";
	if (getMuxBackend() === "orca") {
		const result = spawnSync("orca", ["terminal", "list", "--json"], { encoding: "utf8", timeout: 5000 });
		return result.status === 0 ? parseOrcaTerminalTabInfo(result.stdout, surface).kind : "unknown";
	}
	if (getMuxBackend() === "tmux") {
		const result = spawnSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8", timeout: 5000 });
		if (result.status === 0) return result.stdout.split(/\s+/).includes(surface) ? "present" : "absent";
		if (/no server running|error connecting.*No such file|failed to connect.*No such file/.test(result.stderr ?? "")) return "absent";
	}
	return "unknown";
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const surface = readMetadata(runDir)?.surface;
	const deadline = Date.now() + timeoutMs;
	while (surface && Date.now() < deadline) {
		if (runSurfaceState(surface) === "absent") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	throw new Error(`Could not confirm subagent panel closure; kept run records: ${runDir}`);
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function buildLaunchCommand(metadata: RunMetadata, initialArgs: string[]): string {
	const launchArgs = metadata.launchArgs ?? [];
	const args = [
		"--session",
		metadata.sessionFile,
		"--provider",
		metadata.provider,
		"--model",
		metadata.model,
		"--thinking",
		metadata.thinking,
		...launchArgs,
		...initialArgs,
	];
	// Explicit user extensions must not suppress the child control bridge.
	if (!launchArgs.some((arg, index) => (arg === "--extension" || arg === "-e") && launchArgs[index + 1] === extensionPath))
		args.push("--extension", extensionPath);
	// The new panel ID is not available yet. An empty, restricted context grants no
	// shared window/tab naming rights and never reuses a suspended run's old panel ID.
	const rename = createSurfaceRenameContext("", getMuxBackend());
	const env = [
		`PI_SUBAGENT_RUN_DIR=${shellEscape(metadata.runDir)}`,
		`${TERMINAL_RENAME_CONTEXT_ENV}=${shellEscape(JSON.stringify(rename))}`,
	];
	const command = ["pi", ...args].map((arg) => shellEscape(arg)).join(" ");
	return `cd ${shellEscape(metadata.cwd)} && exec env ${env.join(" ")} ${command}`;
}

/** Open a panel and start the child pi process. The panel id is stored on the run. */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): void {
	if (!isMuxAvailable()) {
		throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
	}
	const surface = createSurface(metadata.name ?? metadata.handle, {
		command: buildLaunchCommand(metadata, initialArgs),
	});
	try {
		// Patch only the panel ID: the child may already have recorded its startup state.
		if (!updateMetadata(metadata.runDir, { surface })) {
			throw new Error(`Could not record subagent panel: ${metadata.handle}`);
		}
	} catch (error) {
		try {
			closeSurface(surface);
		} catch {
			// The pane may already be gone.
		}
		throw error;
	}
}

export function surfaceAlive(surface: string): boolean {
	if (!surface) return false;
	try {
		readScreen(surface, 1);
		return true;
	} catch {
		return false;
	}
}

export function closeRunSurface(surface: string): void {
	if (!surface) throw new Error("Subagent panel is not recorded; cannot confirm closure");
	if (runSurfaceState(surface) === "absent") return;
	try {
		closeSurface(surface);
	} catch (error) {
		if (runSurfaceState(surface) !== "absent") throw error;
	}
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!surfaceAlive(metadata.surface)
	) {
		return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const runs = new Map<string, RunMetadata>();
	for (const root of [legacyRunsDir(), getRunsDir()]) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const metadata = readMetadata(join(root, entry.name));
			if (!metadata) continue;
			if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
			runs.set(metadata.handle, metadata);
		}
	}
	return [...runs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

export function readLatestAssistantEntry(sessionFile: string): AssistantEntry | undefined {
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
	return activeBranch(entries).findLast(isAssistantEntry);
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	return readLatestAssistantEntry(sessionFile)?.message;
}

function hasInboxMessages(runDir: string): boolean {
	return existsSync(inboxDir(runDir)) && readdirSync(inboxDir(runDir)).some((file) => file.endsWith(".json"));
}

/** Return only a new response from a stable idle snapshot. */
export function readIdleResponse(metadata: RunMetadata): AssistantMessage | undefined {
	if (!metadata.hasStarted || metadata.state !== "idle" || hasInboxMessages(metadata.runDir)) return undefined;
	const entry = readLatestAssistantEntry(metadata.sessionFile);
	if (!entry || entry.id === metadata.responseAfter) return undefined;
	const latest = readMetadata(metadata.runDir);
	if (!latest || latest.state !== "idle" || latest.revision !== metadata.revision || hasInboxMessages(metadata.runDir))
		return undefined;
	return entry.message;
}

export function inboxMessageText(id: string, message: string): string {
	return `<!-- subagent-inbox:${id} -->\n${message}`;
}

export function inboxMessageId(content: unknown): string | undefined {
	const text = typeof content === "string" ? content : Array.isArray(content)
		? content.filter((item) => item?.type === "text").map((item) => item.text).join("\n") : "";
	return /^<!-- subagent-inbox:([a-z0-9.-]+) -->\n/.exec(text)?.[1];
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
