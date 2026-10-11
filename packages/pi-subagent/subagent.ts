#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRoles, resolveExtensionSource, resolveRuntimeOptions, THINKING_LEVELS } from "./roles.ts";
import {
	assistantText,
	closeRunSurface,
	effectiveRunState,
	getRunsDir,
	inboxDir,
	launchRun,
	legacyRunsDir,
	listRuns,
	readIdleResponse,
	readLatestAssistantEntry,
	readMetadata,
	removeRunDir,
	runDirForHandle as resolveRunDir,
	runDisplayName,
	isValidRunName,
	surfaceAlive,
	updateMetadata,
	waitForRunShutdown,
	writeMetadata,
	type InboxMessage,
	type RunMetadata,
} from "./shared.ts";

const VALID_THINKING_LEVELS = new Set<string>(THINKING_LEVELS);
const DEFAULT_THINKING_LEVEL = "medium";
const DEFAULT_WAIT_TIMEOUT_SECONDS = 1800;
function fail(message: string): never {
	throw new Error(message);
}

function helpText(command?: string): string {
	switch (command) {
		case undefined:
		case "help":
			return `Usage: subagent <command> [arguments]

Persistent Pi subagents in terminal panels.

Commands:
  spawn    Start a child with a fresh conversation and return its handle
  status   Show a run's state, saved model settings, and panel ID
  rename   Change a run's display name
  send     Prompt an idle child, steer busy work, or queue a follow-up
  wait     Wait for an idle child's durable assistant response
  stop     Close the panel and permanently delete the run
  list     List existing runs, not available role definitions
  roles    Inspect role presets as a Markdown table
  help     Show this overview or help for one command

Help:
  subagent --help                 Show this overview (-h also works)
  subagent <command> --help       Show command arguments, defaults, and examples
  subagent help [command]         Equivalent help form

Help prints to stdout and exits successfully without launching a child,
reading run records, or requiring model settings or a terminal multiplexer.

Examples:
  subagent spawn --name investigation --prompt "Trace the authentication flow"
  subagent wait a1b2c3
  subagent stop a1b2c3`;
		case "spawn":
			return `Usage: subagent spawn [options] (--prompt <text> | --file <path>)...

Start a separate Pi process. Its conversation is new, not a fork of the
parent's history. At least one --prompt or --file is required.

Role:
  --role <name>                    Optional role preset and additional system instructions
                                  Omit for an ordinary child; see subagent roles

Task inputs and extra instructions (repeatable):
  --prompt <text>                  Task text in the initial user message
  --file <path>                    Existing task attachment via Pi's @file input
  --append-system-prompt <text|path>
                                  Additional system instructions, not task text

Runtime options:
  --name <name>                    Display label: 1-64 single-line characters
                                  Names need not be unique; they do not select roles
  --model <provider/model>         Explicit model; overrides the role and parent model
                                  Bare model IDs with --provider remain supported
  --provider <provider>            Legacy provider selector for a bare model ID
  --thinking <level>               Explicit level; otherwise role, PI_REASONING_LEVEL,
                                  then ${DEFAULT_THINKING_LEVEL}
                                  Levels: ${[...VALID_THINKING_LEVELS].join(", ")}
                                  Pi clamps the level to the model's capabilities
  --cwd <dir>                      Child working directory; default: current directory
  --tools <names>                  Non-empty, comma-separated tool allowlist
                                  Applies to built-in, extension, and custom tools
                                  Default: role tools, then Pi settings
  --no-tools                       Disable all built-in, extension, and custom tools
                                  Cannot be combined with --tools
  -e, --extension <path|source>     Explicit extension file/directory or package source
                                  Repeatable; combines with ordinary discovery
  -ne, --no-extensions             Disable ordinary extension discovery;
                                  explicit -e entries and the control bridge still load
  --no-skills                      Disable discovered/configured skills
  --no-prompt-templates            Disable reusable /command prompt templates,
                                  not the --prompt task text
  --no-context-files              Skip AGENTS.md / CLAUDE.md discovery,
                                  not APPEND_SYSTEM.md
  -h, --help                       Show this help (use: subagent spawn --help)

Precedence: explicit CLI options > role frontmatter > parent/Pi defaults.
CLI --tools or --no-tools replaces the role's tool list. Any -e or -ne replaces
its entire extension preset, never merging in the role's sources. -e alone
keeps ordinary discovery; -ne disables it. The control bridge always loads.
Custom model providers may require their registration extension; explicitly
retain that extension when disabling ordinary discovery.
Provider/model must come from CLI, a role's provider/model, or the parent.
Relative input paths resolve from the invoking shell's directory, even when
--cwd points elsewhere. Local -e paths, including ~/ and file:// paths, also
resolve from that shell directory. npm:, git:, and remote sources are passed
to Pi unchanged. Explicit extension options are saved for resume. Combine -ne
with repeated -e to load only selected extensions plus the control bridge.
Prompt/file fragments are combined into one user turn.

For --append-system-prompt, an existing file is read; otherwise the value is
literal text. Verify file paths to avoid treating a missing path as instructions.
The selected role body comes first, then repeated additions in flag order.
The combined content is snapshotted in the run directory. Follow-ups, reloads,
and resume reuse it, while Pi still loads its normal system prompt and
APPEND_SYSTEM.md. --role applies model/thinking/tools/extensions presets and
strips frontmatter before appending the body. Explicit CLI settings always win;
conflicting role defaults are not errors. Role presets do not grant permissions.
--append-system-prompt does not parse frontmatter. Paths inside either input
are not rewritten. Ordinary Pi configuration is not snapshotted.

Tools are not an OS sandbox: bash can modify files, and loaded extensions may
have side effects even if their tools are excluded. For file-reading/search
only, use --tools read,grep,find,ls and consider --no-extensions.

Spawn returns a stable handle and panel ID, not a completion result. Use wait
for a response and stop when finished. Managed children cannot spawn children.
There is no system-prompt replacement or history-fork option.

Examples:
  subagent spawn --role explore --name investigation --prompt "Find authentication entry points; search breadth: medium"
  subagent spawn --role plan --prompt "Plan the authentication change without modifying files"
  subagent spawn --name implementation --file /tmp/spec.md --prompt "Implement the spec"
  subagent spawn --model openai-codex/gpt-5.4-mini --prompt "Investigate the failure"
  subagent spawn --tools read,grep,find,ls --no-extensions --prompt "Inspect src/auth"
  subagent spawn -ne -e ./extensions/todo.ts -e npm:pi-example --prompt "Handle the task"
  subagent spawn --no-tools --prompt "Give an independent second opinion"
  subagent spawn --append-system-prompt /absolute/path/to/role.md --prompt "<task>"`;
		case "roles":
			return `Usage: subagent roles

Print a Markdown table with Name, Description, Model, Thinking, Tools, and
Extensions columns. This is a debugging/inspection command: the extension
already advertises role names and descriptions to the parent model. No role
bodies enter parent context, no child is started, and no arguments are accepted.
This requires neither model settings nor a terminal multiplexer.

Roles come only from Markdown files in this package's skills/subagent/references
directory. Each file must contain a prompt body and YAML frontmatter:
  ---
  name: explore
  description: Locate files, symbols, and references through read-only search.
  tools: [read, bash, grep, find, ls]
  extensions: true
  ---

Built-in roles:
  general-purpose  Implementation, research, review, and other multi-step tasks
  explore          Read-only file/symbol/reference lookup; not review or design
  plan             Read-only implementation planning; no mandatory TODO workflow

All three inherit model and thinking. explore and plan preset read-only tools;
general-purpose leaves tools to CLI/Pi defaults. Omitting --role starts an
ordinary child. All role bodies are additive; no model is pinned.

name and description are required; names must be unique and use lowercase
letters, digits, hyphens, or underscores. model, thinking, tools, and extensions
are optional startup presets. An em dash means unspecified; arrays use JSON.
  model: provider/model   -> use this provider and model
  thinking: high          -> use this Pi thinking level
  tools: [read, bash]      -> restrict tools to this list
  tools: []               -> disable all tools
  extensions: true        -> ordinary extension discovery
  extensions: false       -> disable ordinary discovery
  extensions: [sources...] -> disable discovery and load only these sources
  extensions: []          -> disable ordinary discovery

Extension entries are explicit paths or package sources, not discovered names.
Relative paths resolve from the role file's directory and are displayed as
absolute paths; npm:, git:, and remote sources are left unchanged. Listing
presets does not load or install extensions. No user-level or project-level
role discovery is performed; other frontmatter fields are ignored.

spawn --role <name> applies these presets and appends the body without its
frontmatter. Explicit CLI options override presets; omitted options retain them.
Tools lists are replaced, not merged. Any -e/-ne replaces the whole extension
preset. Role instructions never supply the task or grant permissions.
--name is a display label; list shows run instances.

Examples:
  subagent roles
  subagent spawn --role explore --prompt "Find references to authenticate; search breadth: quick"
  subagent spawn --role general-purpose --prompt "Review the current diff without editing or running tests"`;
		case "status":
			return `Usage: subagent status <handle>

Show the effective run state, saved provider/model/thinking settings, and panel
ID. The handle comes from spawn or list. A display name is not a handle.
Saved model settings describe the launch request, not proof of model execution.
Use wait to retrieve a response; status does not establish task completion.

Example:
  subagent status a1b2c3`;
		case "rename":
			return `Usage: subagent rename <handle> <name>

Change the display label of an existing run. Names are trimmed, must be a
single line of 1-64 characters, and need not be unique. Quote names with spaces.
The stable handle, role instructions, and model configuration do not change.

Example:
  subagent rename a1b2c3 "authentication review"`;
		case "send":
			return `Usage: subagent send <handle> [--follow-up] <message>

Send a non-empty message through a running child's control inbox.
  Default          Idle: start another task. Busy: steer current work.
  --follow-up      Busy: queue another turn after current work finishes.
                   Idle: start another task.

Quote the message. Sending returns after queueing, not after the child finishes.
Inbox files remain until a tagged user message is persisted in the child's
session. Failed acceptance preserves the inbox and reports an error; fix the
cause and reload/resume the child to retry.
Use wait to retrieve its reply. This does not send terminal keys or change the
saved role prompt, and it cannot resume an exited or suspended panel.

Examples:
  subagent send a1b2c3 "Focus on error handling"
  subagent send a1b2c3 --follow-up "Then summarize the remaining risks"`;
		case "wait":
			return `Usage: subagent wait <handle> [--timeout <seconds>]

Options:
  --timeout <seconds>  Positive integer deadline; default: ${DEFAULT_WAIT_TIMEOUT_SECONDS} seconds

Wait until the child has started, is idle, and has no pending inbox messages,
then print its latest non-aborted assistant response. After send, never return
the assistant entry that predates that message; require a stable state snapshot. An aborted reply keeps
waiting for the user or send to continue. The deadline includes time spent
waiting for user input. A reply can be an intermediate question, not the final
deliverable; verify it against the task before declaring completion.

This reads durable session state, not terminal output. Execution errors, child
exit, and timeout return a nonzero exit status. Timeout and successful wait do
not close the child or delete its run. Inspect the existing run before retrying.
Set the enclosing bash tool timeout above this deadline.

Examples:
  subagent wait a1b2c3
  subagent wait a1b2c3 --timeout 300`;
		case "stop":
			return `Usage: subagent stop <handle>

Close the child's panel and permanently delete its run directory, including
transcript, metadata, inbox, and additional system-prompt snapshot.
This is not a turn-level interrupt or suspension. Save any needed findings first.
Deletion occurs only after panel absence is confirmed. Failed or unverifiable
closure returns an error and preserves the run. Completion and wait do not
stop a child automatically.

Example:
  subagent stop a1b2c3`;
		case "list":
			return `Usage: subagent list

List recorded runs with their handles, display names, states, saved model
settings, and thinking levels. With PI_SESSION_ID set, list only that parent's
children; otherwise list all recorded runs. No additional arguments are accepted.

This lists instances, including recorded runs that have exited or been suspended,
not available roles or prompt files. Use subagent roles for available roles.

Example:
  subagent list`;
		default:
			return fail(`Unknown command: ${command}\nRun subagent --help for available commands.`);
	}
}

function usage(command?: string): never {
	fail(helpText(command));
}

function isHelpFlag(value: string | undefined): boolean {
	return value === "--help" || value === "-h";
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${option} requires a value`);
	return value;
}

function normalizeRunName(value: string): string {
	const name = value.trim();
	if (!isValidRunName(name)) fail("Subagent name must be a single line of 1 to 64 characters");
	return name;
}

function runDirForHandle(handle: string): string {
	if (!/^[a-z0-9]+$/.test(handle)) fail(`Invalid subagent handle: ${handle}`);
	return resolveRunDir(handle);
}

function getRun(handle: string): RunMetadata {
	const metadata = readMetadata(runDirForHandle(handle));
	if (!metadata) fail(`Unknown subagent: ${handle}`);
	return metadata;
}

function generateHandle(): string {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = randomBytes(3).toString("hex");
		if (!existsSync(join(getRunsDir(), handle)) && !existsSync(join(legacyRunsDir(), handle))) return handle;
	}
	fail("Could not allocate a unique subagent handle");
}

function spawnSubagent(args: string[]): void {
	if (process.env.PI_SUBAGENT_RUN_DIR) fail("Nested subagents are disabled");
	let name: string | undefined;
	let roleName: string | undefined;
	let provider: string | undefined;
	let model: string | undefined;
	let thinking: string | undefined;
	let cwd = process.cwd();
	let tools: string | undefined;
	let noTools = false;
	let noExtensions = false;
	let extensions: string[] | undefined;
	let noSkills = false;
	let noPromptTemplates = false;
	let noContextFiles = false;
	const prompts: string[] = [];
	const files: string[] = [];
	const systemPrompts: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--role":
				if (roleName !== undefined) fail("--role can only be specified once");
				roleName = valueAfter(args, i, arg);
				i++;
				break;
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
			case "--no-tools":
				noTools = true;
				break;
			case "-e":
			case "--extension": {
				const source = valueAfter(args, i, arg);
				if (source.startsWith("-")) fail(`${arg} requires a value`);
				(extensions ??= []).push(resolveExtensionSource(source, process.cwd()));
				i++;
				break;
			}
			case "-ne":
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
			case "--append-system-prompt": {
				const source = valueAfter(args, i, arg);
				const content = existsSync(source) ? readFileSync(source, "utf8") : source;
				systemPrompts.push(content.replace(/^\uFEFF/, ""));
				i++;
				break;
			}
			case "--prompt":
				prompts.push(valueAfter(args, i, arg));
				i++;
				break;
			case "--file": {
				const file = resolve(valueAfter(args, i, arg));
				if (!existsSync(file)) fail(`File not found: ${file}`);
				files.push(file);
				i++;
				break;
			}
			default:
				fail(`Unknown spawn argument: ${arg}`);
		}
	}

	if (tools !== undefined && !tools.split(",").some((tool) => tool.trim()))
		fail("--tools requires at least one tool name");
	if (noTools && tools !== undefined) fail("Use either --tools or --no-tools, not both");
	if (prompts.length === 0 && files.length === 0) fail("spawn requires at least one --prompt or --file");
	if (!existsSync(cwd)) fail(`Working directory not found: ${cwd}`);
	const role = roleName === undefined ? undefined : loadRoles().find((entry) => entry.name === roleName);
	if (roleName !== undefined && !role) fail(`Unknown role: ${roleName}\nRun subagent roles for available roles.`);
	const runtime = resolveRuntimeOptions(
		{ provider, model, thinking, tools, noTools, extensions, noExtensions },
		role,
		{ provider: process.env.PI_PROVIDER, model: process.env.PI_MODEL, thinking: process.env.PI_REASONING_LEVEL || undefined },
	);
	if (!runtime.provider) fail("No provider specified by CLI, role, or PI_PROVIDER");
	if (!runtime.model) fail("No model specified by CLI, role, or PI_MODEL");
	if (!runtime.thinking || !VALID_THINKING_LEVELS.has(runtime.thinking)) fail(`Invalid thinking level: ${runtime.thinking}`);
	if (role) systemPrompts.unshift(role.prompt);

	const handle = generateHandle();
	const runDir = runDirForHandle(handle);
	const sessionFile = join(runDir, "session.jsonl");
	mkdirSync(inboxDir(runDir), { recursive: true, mode: 0o700 });
	writeFileSync(sessionFile, "", { mode: 0o600 });

	const appendSystemPrompt = systemPrompts.filter(Boolean).join("\n\n");
	const appendSystemPromptFile = appendSystemPrompt ? join(runDir, "append-system-prompt.md") : undefined;

	const launchArgs: string[] = [];
	if (runtime.tools) launchArgs.push("--tools", runtime.tools);
	if (runtime.noTools) launchArgs.push("--no-tools");
	if (runtime.noExtensions) launchArgs.push("--no-extensions");
	for (const source of runtime.extensions ?? []) launchArgs.push("--extension", source);
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
		provider: runtime.provider,
		model: runtime.model,
		thinking: runtime.thinking,
		launchArgs,
		appendSystemPromptFile,
		state: "starting",
		hasStarted: false,
		createdAt: now,
		updatedAt: now,
	};
	const initialArgs = files.map((file) => `@${file}`);
	if (prompts.length > 0) initialArgs.push(`Task:\n${prompts.join("\n\n")}`);
	try {
		if (appendSystemPromptFile) {
			writeFileSync(appendSystemPromptFile, appendSystemPrompt, { encoding: "utf8", mode: 0o600 });
		}
		writeMetadata(metadata);
		launchRun(metadata, initialArgs);
	} catch (error) {
		removeRunDir(runDir);
		throw error;
	}

	const launched = readMetadata(runDir) ?? metadata;
	process.stdout.write(`Spawned ${runDisplayName(launched)}\nState: busy\nPanel: ${launched.surface}\n`);
}

function statusSubagent(args: string[]): void {
	if (args.length !== 1) usage("status");
	const metadata = getRun(args[0]);
	process.stdout.write(
		`${runDisplayName(metadata)}: ${effectiveRunState(metadata)} (${metadata.provider}/${metadata.model}, ${metadata.thinking})\nPanel: ${metadata.surface}\n`,
	);
}

function renameSubagent(args: string[]): void {
	if (args.length !== 2) usage("rename");
	const metadata = getRun(args[0]);
	const name = normalizeRunName(args[1]);
	const updated = updateMetadata(metadata.runDir, { name });
	if (!updated) fail(`Could not rename subagent: ${metadata.handle}`);
	process.stdout.write(`Renamed ${runDisplayName(updated)}\n`);
}

function sendSubagent(args: string[]): void {
	const handle = args.shift();
	if (!handle) usage("send");
	let followUp = false;
	const messageParts: string[] = [];
	for (const arg of args) {
		if (arg === "--follow-up") followUp = true;
		else if (arg.startsWith("--")) fail(`Unknown send argument: ${arg}`);
		else messageParts.push(arg);
	}
	const message = messageParts.join(" ").trim();
	if (!message) fail("send requires a message");
	const metadata = getRun(handle);
	if (!surfaceAlive(metadata.surface)) fail(`${handle} is not running`);

	const queueDir = inboxDir(metadata.runDir);
	mkdirSync(queueDir, { recursive: true, mode: 0o700 });
	const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
	const target = join(queueDir, `${id}.json`);
	const temporary = `${target}.tmp`;
	const payload: InboxMessage = { message, delivery: followUp ? "followUp" : "auto" };
	writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
	const responseAfter = readLatestAssistantEntry(metadata.sessionFile)?.id;
	if (!updateMetadata(metadata.runDir, { state: "busy", responseAfter, error: undefined }))
		fail(`Could not record message submission: ${handle}`);
	renameSync(temporary, target);

	const state = effectiveRunState(metadata);
	const verb = followUp && state === "busy" ? "Queued follow-up for" : state === "idle" ? "Prompted" : "Steered";
	process.stdout.write(`${verb} ${runDisplayName(metadata)}\n`);
}

function parseTimeout(args: string[]): number {
	if (args.length === 0) return DEFAULT_WAIT_TIMEOUT_SECONDS;
	if (args.length !== 2 || args[0] !== "--timeout") usage("wait");
	const timeout = Number(args[1]);
	if (!Number.isInteger(timeout) || timeout <= 0) fail("--timeout must be a positive integer");
	return timeout;
}

async function waitSubagent(args: string[]): Promise<void> {
	const handle = args.shift();
	if (!handle) usage("wait");
	const timeoutSeconds = parseTimeout(args);
	const deadline = Date.now() + timeoutSeconds * 1000;

	while (Date.now() < deadline) {
		const metadata = getRun(handle);
		const state = effectiveRunState(metadata);
		if (state === "error") fail(metadata.error || `${handle} failed`);
		if (state === "exited") fail(`${handle} exited before finishing`);
		const message = state === "idle" ? readIdleResponse(metadata) : undefined;
		if (message && message.stopReason !== "aborted") {
			const failed = message.stopReason === "error";
			process.stdout.write(`${handle} ${failed ? "failed" : "finished"}\n\n${assistantText(message)}\n`);
			if (failed) process.exitCode = 1;
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	fail(`Timed out after ${timeoutSeconds}s waiting for ${handle}`);
}

async function stopSubagent(args: string[]): Promise<void> {
	if (args.length !== 1) usage("stop");
	const metadata = getRun(args[0]);
	closeRunSurface(metadata.surface);
	await waitForRunShutdown(metadata.runDir);
	removeRunDir(metadata.runDir);
	process.stdout.write(`Stopped ${runDisplayName(metadata)}\n`);
}

function listSubagents(args: string[]): void {
	if (args.length !== 0) usage("list");
	const runs = listRuns(process.env.PI_SESSION_ID || undefined);
	if (runs.length === 0) {
		process.stdout.write("No subagents\n");
		return;
	}
	for (const metadata of runs) {
		process.stdout.write(
			`${runDisplayName(metadata)}  ${effectiveRunState(metadata).padEnd(8)}  ${metadata.provider}/${metadata.model}  ${metadata.thinking}\n`,
		);
	}
}

function markdownCell(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n?|\n/g, " ").trim();
}

function listRoles(args: string[]): void {
	if (args.length !== 0) usage("roles");
	const roles = loadRoles();
	process.stdout.write("| Name | Description | Model | Thinking | Tools | Extensions |\n| --- | --- | --- | --- | --- | --- |\n");
	for (const role of roles) {
		const cells = [
			role.name,
			role.description,
			role.model ?? "—",
			role.thinking ?? "—",
			role.tools === undefined ? "—" : JSON.stringify(role.tools),
			role.extensions === undefined ? "—" : JSON.stringify(role.extensions),
		];
		process.stdout.write(`| ${cells.map(markdownCell).join(" | ")} |\n`);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args.shift();
	// Only standalone help invocations are intercepted. A literal "-h" used as a
	// prompt, name, or message is data, not a request to skip the command.
	if (isHelpFlag(command)) {
		if (args.length !== 0) usage();
		process.stdout.write(`${helpText()}\n`);
		return;
	}
	if (command === "help") {
		if (args.length > 1) usage();
		process.stdout.write(`${helpText(isHelpFlag(args[0]) ? undefined : args[0])}\n`);
		return;
	}
	if (args.length === 1 && isHelpFlag(args[0])) {
		process.stdout.write(`${helpText(command)}\n`);
		return;
	}
	switch (command) {
		case "spawn":
			spawnSubagent(args);
			break;
		case "roles":
			listRoles(args);
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
			if (!command) usage();
			fail(`Unknown command: ${command}\nRun subagent --help for available commands.`);
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
