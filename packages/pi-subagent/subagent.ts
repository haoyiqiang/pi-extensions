#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	assistantText,
	closeRunSurface,
	effectiveRunState,
	extensionPath,
	getRunsDir,
	inboxDir,
	launchRun,
	listRuns,
	pendingMessageCount,
	readLatestAssistant,
	readMetadata,
	removeRunDir,
	runAge,
	isValidRunName,
	surfaceGone,
	type InboxMessage,
	type RunMetadata,
	updateMetadata,
	waitForRunShutdown,
	writeMetadata,
} from "./shared.ts";

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function fail(message: string): never {
	throw new Error(message);
}

function usage(): never {
	process.stderr.write(`usage:
  subagent spawn [--name <name>] [--provider <provider>] [--model <model>] [--thinking <level>]
    [--cwd <dir>] [--tools <names>] [--extension <path>] [--no-extensions] [--no-skills]
    [--no-prompt-templates] [--no-context-files] (--prompt <text> | --file <path>)...
  subagent status <handle> [--json]
  subagent rename <handle> <name>
  subagent send <handle> [--follow-up] <message>
  subagent wait <handle> [--timeout <seconds>]
  subagent stop <handle>
  subagent list [--json]`);
	process.exit(2);
}

/** Results go to stdout; hints and diagnostics go to stderr. */
function emit(line: string): void {
	process.stdout.write(`${line}\n`);
}

function emitHint(line: string): void {
	process.stderr.write(`${line}\n`);
}

function takeJsonFlag(args: string[]): { args: string[]; json: boolean } {
	const json = args.includes("--json");
	return { args: args.filter((arg) => arg !== "--json"), json };
}

interface RunView {
	handle: string;
	name: string | null;
	state: string;
	age: string;
	cwd: string;
	model: string;
	thinking: string;
	pending: number;
}

function runView(metadata: RunMetadata): RunView {
	return {
		handle: metadata.handle,
		name: metadata.name ?? null,
		state: effectiveRunState(metadata),
		age: runAge(metadata),
		cwd: metadata.cwd,
		model: `${metadata.provider}/${metadata.model}`,
		thinking: metadata.thinking,
		pending: pendingMessageCount(metadata.runDir),
	};
}

/** One copyable line, emitted only when the run is idle and stopping is the next useful action. */
function hintStopOnIdle(metadata: RunMetadata): void {
	if (effectiveRunState(metadata) === "idle") {
		emitHint(`Use \`subagent stop ${metadata.handle}\` to stop this subagent when it is no longer needed.`);
	}
}

function formatTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => row[index].length)),
	);
	const line = (cells: string[]): string =>
		cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
	return [line(headers), ...rows.map(line)].join("\n");
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${option} requires a value`);
	return value;
}

function normalizeRunName(value: string): string {
	const name = value.trim();
	if (!isValidRunName(name)) fail("subagent name must be a single line of 1 to 64 characters");
	return name;
}

function runDirForHandle(handle: string): string {
	if (!/^[a-z0-9]+$/.test(handle)) fail(`invalid subagent handle: ${handle}`);
	return join(getRunsDir(), handle);
}

function getRun(handle: string): RunMetadata {
	const metadata = readMetadata(runDirForHandle(handle));
	if (!metadata) fail(`unknown subagent: ${handle}`);
	return metadata;
}

function generateHandle(): string {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = randomBytes(3).toString("hex");
		if (!existsSync(runDirForHandle(handle))) return handle;
	}
	fail("could not allocate a unique subagent handle");
}

function spawnSubagent(args: string[]): void {
	if (process.env.PI_SUBAGENT_RUN_DIR) fail("nested subagents are disabled");
	let name: string | undefined;
	let provider = process.env.PI_PROVIDER;
	let model = process.env.PI_MODEL;
	let thinking = process.env.PI_REASONING_LEVEL || "medium";
	let cwd = process.cwd();
	let tools: string | undefined;
	let noExtensions = false;
	let noSkills = false;
	let noPromptTemplates = false;
	let noContextFiles = false;
	let json = false;
	const prompts: string[] = [];
	const files: string[] = [];
	const extraExtensions: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--name":
				name = normalizeRunName(valueAfter(args, i, arg));
				i++;
				break;
			case "--provider":
				provider = valueAfter(args, i, arg);
				i++;
				break;
			case "--model":
				model = valueAfter(args, i, arg);
				i++;
				break;
			case "--thinking":
				thinking = valueAfter(args, i, arg);
				i++;
				break;
			case "--cwd":
				cwd = resolve(valueAfter(args, i, arg));
				i++;
				break;
			case "--tools":
				tools = valueAfter(args, i, arg);
				i++;
				break;
			case "--extension":
			case "-e": {
				const extension = resolve(valueAfter(args, i, arg));
				if (!existsSync(extension)) fail(`extension not found: ${extension}`);
				extraExtensions.push(extension);
				i++;
				break;
			}
			case "--no-extensions":
				noExtensions = true;
				break;
			case "--no-skills":
				noSkills = true;
				break;
			case "--no-prompt-templates":
				noPromptTemplates = true;
				break;
			case "--no-context-files":
				noContextFiles = true;
				break;
			case "--prompt":
				prompts.push(valueAfter(args, i, arg));
				i++;
				break;
			case "--file": {
				const file = resolve(valueAfter(args, i, arg));
				if (!existsSync(file)) fail(`file not found: ${file}`);
				files.push(file);
				i++;
				break;
			}
			case "--json":
				json = true;
				break;
			default:
				fail(`unknown spawn argument: ${arg}`);
		}
	}

	if (!provider) fail("no provider specified and PI_PROVIDER is not set");
	if (!model) fail("no model specified and PI_MODEL is not set");
	if (!VALID_THINKING_LEVELS.has(thinking)) fail(`invalid thinking level: ${thinking}`);
	if (tools !== undefined && !tools.split(",").some((name) => name.trim()))
		fail("--tools requires at least one tool name");
	if (prompts.length === 0 && files.length === 0) fail("spawn requires at least one --prompt or --file");
	if (!existsSync(cwd)) fail(`working directory not found: ${cwd}`);

	const handle = generateHandle();
	const runDir = runDirForHandle(handle);
	const sessionFile = join(runDir, "session.jsonl");
	mkdirSync(inboxDir(runDir), { recursive: true, mode: 0o700 });
	writeFileSync(sessionFile, "", { mode: 0o600 });

	const launchArgs: string[] = [];
	if (tools) launchArgs.push("--tools", tools);
	if (noExtensions) launchArgs.push("--no-extensions");
	const seenExtensions = new Set<string>();
	for (const extension of extraExtensions) {
		if (extension === extensionPath || seenExtensions.has(extension)) continue;
		seenExtensions.add(extension);
		launchArgs.push("--extension", extension);
	}
	if (noSkills) launchArgs.push("--no-skills");
	if (noPromptTemplates) launchArgs.push("--no-prompt-templates");
	if (noContextFiles) launchArgs.push("--no-context-files");

	const now = new Date().toISOString();
	const metadata: RunMetadata = {
		version: 1,
		handle,
		name,
		parentSessionId: process.env.PI_SESSION_ID || undefined,
		parentSessionFile: process.env.PI_SESSION_FILE || undefined,
		surface: "",
		runDir,
		sessionFile,
		cwd,
		provider,
		model,
		thinking,
		launchArgs,
		state: "starting",
		hasStarted: false,
		createdAt: now,
		updatedAt: now,
	};
	writeMetadata(metadata);

	const initialArgs = files.map((file) => `@${file}`);
	if (prompts.length > 0) initialArgs.push(`Task:\n${prompts.join("\n\n")}`);
	try {
		launchRun(metadata, initialArgs);
	} catch (error) {
		removeRunDir(runDir);
		throw error;
	}

	const spawned = readMetadata(runDir) ?? metadata;
	if (json) emit(JSON.stringify({ handle: spawned.handle, name: spawned.name ?? null }));
	else emit(`spawned ${spawned.handle}${spawned.name ? ` ${spawned.name}` : ""}`);
}

function statusSubagent(args: string[]): void {
	const parsed = takeJsonFlag(args);
	if (parsed.args.length !== 1) usage();
	const metadata = getRun(parsed.args[0]);
	const view = runView(metadata);
	if (parsed.json) {
		emit(JSON.stringify(view));
		return;
	}
	emit(
		[
			`handle: ${view.handle}`,
			`name: ${view.name ?? "-"}`,
			`state: ${view.state}`,
			`age: ${view.age}`,
			`cwd: ${view.cwd}`,
			`model: ${view.model}`,
			`thinking: ${view.thinking}`,
			`pending: ${view.pending}`,
		].join("\n"),
	);
	hintStopOnIdle(metadata);
}

function renameSubagent(args: string[]): void {
	if (args.length !== 2) usage();
	const metadata = getRun(args[0]);
	const name = normalizeRunName(args[1]);
	if (!updateMetadata(metadata.runDir, { name })) fail(`could not rename subagent ${metadata.handle}`);
	emit(`${metadata.handle} renamed ${name}`);
}

function sendSubagent(args: string[]): void {
	const handle = args.shift();
	if (!handle) usage();
	let followUp = false;
	const messageParts: string[] = [];
	for (const arg of args) {
		if (arg === "--follow-up") followUp = true;
		else if (arg.startsWith("--")) fail(`unknown send argument: ${arg}`);
		else messageParts.push(arg);
	}
	const message = messageParts.join(" ").trim();
	if (!message) fail("send requires a message");
	const metadata = getRun(handle);
	if (surfaceGone(metadata.surface)) fail(`subagent ${handle} is not running`);

	const queueDir = inboxDir(metadata.runDir);
	mkdirSync(queueDir, { recursive: true, mode: 0o700 });
	const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
	const target = join(queueDir, `${id}.json`);
	const temporary = `${target}.tmp`;
	const payload: InboxMessage = { message, delivery: followUp ? "followUp" : "auto" };
	writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);

	const state = effectiveRunState(metadata);
	const verb = followUp && state === "busy" ? "follow-up queued" : state === "idle" ? "prompted" : "steered";
	emit(`${metadata.handle} ${verb}`);
}

function parseTimeout(args: string[]): number {
	if (args.length === 0) return 1800;
	if (args.length !== 2 || args[0] !== "--timeout") usage();
	const timeout = Number(args[1]);
	if (!Number.isInteger(timeout) || timeout <= 0) fail("--timeout must be a positive integer");
	return timeout;
}

async function waitSubagent(args: string[]): Promise<void> {
	const handle = args.shift();
	if (!handle) usage();
	const timeoutSeconds = parseTimeout(args);
	const deadline = Date.now() + timeoutSeconds * 1000;

	while (Date.now() < deadline) {
		const metadata = getRun(handle);
		const pending = pendingMessageCount(metadata.runDir) > 0;
		const state = effectiveRunState(metadata);
		if (state === "error") fail(metadata.error || `${handle} failed`);
		if (state === "exited") fail(`${handle} exited before finishing`);
		if (metadata.hasStarted && state === "idle" && !pending) {
			const message = readLatestAssistant(metadata.sessionFile);
			if (!message) fail(`${handle} finished without an assistant response`);
			emit(assistantText(message));
			hintStopOnIdle(metadata);
			if (message.stopReason === "error" || message.stopReason === "aborted") process.exitCode = 1;
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	fail(`Timed out after ${timeoutSeconds}s waiting for ${handle}`);
}

async function stopSubagent(args: string[]): Promise<void> {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	closeRunSurface(metadata.surface);
	await waitForRunShutdown(metadata.runDir);
	removeRunDir(metadata.runDir);
	emit(`${metadata.handle} stopped`);
}

function listSubagents(args: string[]): void {
	const parsed = takeJsonFlag(args);
	if (parsed.args.length !== 0) usage();
	const views = listRuns(process.env.PI_SESSION_ID || undefined).map(runView);
	if (parsed.json) {
		emit(JSON.stringify(views));
		return;
	}
	if (views.length === 0) {
		emit("no subagents");
		return;
	}
	emit(
		formatTable(
			["HANDLE", "NAME", "STATE", "AGE", "CWD", "MODEL"],
			views.map((view) => [
				view.handle,
				view.name ?? "-",
				view.state,
				view.age,
				view.cwd,
				view.model,
			]),
		),
	);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args.shift();
	switch (command) {
		case "spawn":
			spawnSubagent(args);
			break;
		case "status":
			statusSubagent(args);
			break;
		case "rename":
			renameSubagent(args);
			break;
		case "send":
			sendSubagent(args);
			break;
		case "wait":
			await waitSubagent(args);
			break;
		case "stop":
			await stopSubagent(args);
			break;
		case "list":
			listSubagents(args);
			break;
		default:
			usage();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
