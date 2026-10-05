import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getToolNamesForType, isDefaultsDisabled } from "../../agent-types.js";
import { DEFAULT_AGENTS } from "../../default-agents.js";
import { detectEnv } from "../../env.js";
import { i18n } from "../../i18n.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../../structured-output.js";
import { buildAgentPrompt, type PromptExtras } from "../../prompts.js";
import type { AgentConfig, EffectiveThinkingLevel, SubagentType } from "../../types.js";
import { getGraceTurns, resolveDefaultModel, resolveEffectiveMaxTurns } from "../embedded.js";
import type { PersistentSessionReference } from "../session-reference.js";
import type { ExecutionRunOptions } from "../types.js";
import { TERMINAL_MANIFEST_ENV, modelFingerprint, type TerminalChildManifest } from "./bridge-protocol.js";
import type { TerminalLaunchPlan } from "./types.js";
import type { ProcessExitReceipt } from "./process-exit.js";
import { compileTerminalSchema, validTurnBudget } from "./run-policy.js";

const DEFAULT_ROOT_DIRECTORY = "terminal-subagents";
const DEFAULT_INTERPRETER = "bash";
const CHILD_EXTENSION_FILE = fileURLToPath(new URL("./child-extension.ts", import.meta.url));
const LAUNCH_PROCESS_FILE = fileURLToPath(new URL("./launch-process.mjs", import.meta.url));
const PI_CLI_FILE = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

export interface TerminalBackendConfig {
  sessionDir?: string;
  artifactDir?: string;
  agentDir?: string;
  executable?: string;
  executableArgs?: string[];
  interpreter?: "bash" | "powershell";
  /** Explicit, trusted extensions needed only to register the selected provider in the child process. */
  providerExtensions?: string[];
  /** auto preserves Pi's normal TTY/headless detection; json is deterministic for tests and integrations. */
  mode?: "auto" | "json";
  startupTimeoutMs?: number;
  exitTimeoutMs?: number;
}

/** Fully resolved, credential-free policy for one isolated terminal conversation. */
export interface TerminalPolicy {
  readonly type: SubagentType;
  readonly name: string;
  readonly cwd: string;
  readonly model: Readonly<{ provider: string; id: string }>;
  readonly modelFingerprint?: string;
  readonly thinkingLevel?: EffectiveThinkingLevel;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  readonly structuredSchema?: Record<string, unknown>;
  readonly maxTurns?: number;
  readonly graceTurns?: number;
}

interface ResolvedTerminalBackendConfig {
  readonly sessionDir: string;
  readonly artifactDir: string;
  readonly agentDir: string;
  readonly executable: string;
  readonly executableArgs: readonly string[];
  readonly interpreter: "bash" | "powershell";
  readonly providerExtensions: readonly string[];
  readonly mode: "auto" | "json";
}

interface LaunchProcessConfig {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  processExit: ProcessExitReceipt;
}

/** Resolve and validate all policy that must be fixed before a terminal child is created. */
export async function prepareTerminalPolicy(
  ctx: ExtensionContext,
  type: SubagentType,
  options: ExecutionRunOptions,
): Promise<TerminalPolicy> {
  const agent = resolveAgent(type);

  // Terminal execution is deliberately narrower than the embedded backend. Keep
  // these checks ahead of detectEnv(), the first operation that may spawn a process.
  rejectUnsupportedOptions(agent, options);
  if (options.structuredOutput !== undefined && (!options.structuredOutput || typeof options.structuredOutput.check !== "function")) invalidConfig();
  const structuredSchema = options.structuredOutput === undefined ? undefined
    : compileTerminalSchema(options.structuredOutput.schema).schema;
  const maxTurns = resolveEffectiveMaxTurns(type, options.maxTurns);
  const graceTurns = maxTurns === undefined ? undefined : getGraceTurns();
  if (!validTurnBudget(maxTurns, graceTurns)) invalidConfig();

  const tools = resolveTools(type, agent);
  const selectedModel = options.model ?? resolveDefaultModel(ctx.model, ctx.modelRegistry, agent.model);
  if (!selectedModel || !nonEmpty(selectedModel.provider) || !nonEmpty(selectedModel.id)) {
    throw new Error(i18n.t("terminalBackend.noModel"));
  }

  const cwd = options.cwd ?? ctx.cwd;
  if (!nonEmpty(cwd) || !isAbsolute(cwd)) invalidConfig();

  const env = await detectEnv(options.pi, cwd);
  const extras: PromptExtras = {};
  if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;
  if (options.workflow && !structuredSchema) extras.workflowChild = true;
  const systemPrompt = buildAgentPrompt(agent, cwd, env, ctx.getSystemPrompt(), extras);
  const thinkingLevel = options.thinkingLevel ?? agent.thinking;

  return Object.freeze({
    type,
    name: agent.displayName ?? agent.name,
    cwd,
    model: Object.freeze({ provider: selectedModel.provider, id: selectedModel.id }),
    modelFingerprint: modelFingerprint(selectedModel),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    tools: Object.freeze(tools),
    systemPrompt,
    ...(structuredSchema ? { structuredSchema } : {}),
    ...(maxTurns !== undefined ? { maxTurns, graceTurns } : {}),
  });
}

/** Create one fresh, persisted Pi v3 session with a stable terminal reference. */
export function createTerminalSession(
  policy: TerminalPolicy,
  config: TerminalBackendConfig = {},
): PersistentSessionReference<"terminal"> {
  validatePolicy(policy);
  const resolved = resolveConfig(config);
  mkdirSync(resolved.sessionDir, { recursive: true, mode: 0o700 });

  const sessionId = randomUUID();
  const sessionFile = join(resolved.sessionDir, `${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: policy.cwd,
  } as const;
  writePrivateFile(sessionFile, `${JSON.stringify(header)}\n`);

  return Object.freeze({ backend: "terminal", sessionId, sessionFile });
}

/**
 * Materialize a unique run directory and return the lifecycle launch plan.
 * The returned plan intentionally has no signal; the owning backend adds it.
 */
export function prepareTerminalLaunch(
  policy: TerminalPolicy,
  session: PersistentSessionReference<"terminal">,
  runId: string,
  endpoint: TerminalChildManifest["endpoint"],
  prompt: string,
  config: TerminalBackendConfig = {},
): TerminalLaunchPlan & { processExit: ProcessExitReceipt } {
  validatePolicy(policy);
  validateSession(session);
  if (!nonEmpty(runId) || typeof prompt !== "string" || !validEndpoint(endpoint)) invalidConfig();
  const resolved = resolveConfig(config);

  mkdirSync(resolved.artifactDir, { recursive: true, mode: 0o700 });
  const runDirectory = join(resolved.artifactDir, randomUUID());
  mkdirSync(runDirectory, { mode: 0o700 });

  const manifestFile = join(runDirectory, "manifest.json");
  const promptFile = join(runDirectory, "prompt.txt");
  const systemPromptFile = join(runDirectory, "system-prompt.txt");
  const launchConfigFile = join(runDirectory, "launch.json");
  const launchScriptFile = join(runDirectory, resolved.interpreter === "powershell" ? "launch.ps1" : "launch.sh");
  const run = Object.freeze({ runId, session });
  const manifest: TerminalChildManifest = {
    version: 1,
    run,
    endpoint: { host: "127.0.0.1", port: endpoint.port, token: endpoint.token },
    model: { provider: policy.model.provider, id: policy.model.id },
    ...(policy.modelFingerprint ? { modelFingerprint: policy.modelFingerprint } : {}),
    tools: [...policy.tools],
    systemPrompt: policy.systemPrompt,
    ...(policy.structuredSchema ? { structuredSchema: policy.structuredSchema } : {}),
    ...(policy.maxTurns !== undefined ? { maxTurns: policy.maxTurns, graceTurns: policy.graceTurns } : {}),
  };

  const args = buildCliArguments(policy, session, promptFile, systemPromptFile, resolved);
  const processExit = { path: join(runDirectory, "process-exit.json"), runId, token: randomBytes(32).toString("hex") };
  const launchConfig: LaunchProcessConfig = {
    executable: resolved.executable,
    args,
    cwd: policy.cwd,
    processExit,
    env: {
      PI_CODING_AGENT_DIR: resolved.agentDir,
      [TERMINAL_MANIFEST_ENV]: manifestFile,
    },
  };

  try {
    writePrivateFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    writePrivateFile(promptFile, prompt);
    writePrivateFile(systemPromptFile, policy.systemPrompt);
    writePrivateFile(launchConfigFile, `${JSON.stringify(launchConfig)}\n`);
  } catch (error) {
    rmSync(runDirectory, { recursive: true, force: true });
    throw error;
  }

  const command = resolved.interpreter === "powershell"
    ? `& ${quotePowerShell(process.execPath)} ${quotePowerShell(LAUNCH_PROCESS_FILE)} ${quotePowerShell(launchConfigFile)}; exit $LASTEXITCODE`
    : `exec ${quoteBash(process.execPath)} ${quoteBash(LAUNCH_PROCESS_FILE)} ${quoteBash(launchConfigFile)}`;

  return {
    run,
    name: policy.name,
    launchScriptFile,
    interpreter: resolved.interpreter,
    buildCommand: () => command,
    processExit,
  };
}

function resolveAgent(type: SubagentType): AgentConfig {
  const registered = getAgentConfig(type);
  if (registered?.enabled === false) invalidConfig();
  if (registered) return registered;

  if (isDefaultsDisabled()) invalidConfig();
  const lower = type.toLowerCase();
  for (const [name, agent] of DEFAULT_AGENTS) {
    if (name.toLowerCase() === lower && agent.enabled !== false) return agent;
  }
  invalidConfig();
}

function rejectUnsupportedOptions(
  agent: AgentConfig,
  options: ExecutionRunOptions,
): void {
  if (options.isolated !== true) unsupported("isolated=false");
  if (options.inheritContext === true) unsupported("inheritContext");
  if (options.resumeSessionFile !== undefined) unsupported("resumeSessionFile");
  if (agent.memory !== undefined) unsupported("memory");
  if (agent.persistSession === false) unsupported("persistSession=false");
  // nestedRuntime is intentionally ignored: isolated embedded runs do not admit
  // nested delegation tools either, so no manager object crosses the boundary.
}

function resolveTools(type: SubagentType, agent: AgentConfig): string[] {
  // Direct callers may prepare a built-in before the process-wide registry has
  // been populated. Preserve that built-in's explicit tool tier in that case.
  const requested = getAgentConfig(type) === undefined && agent.builtinToolNames !== undefined
    ? agent.builtinToolNames
    : getToolNamesForType(type);
  const known = new Set(BUILTIN_TOOL_NAMES);
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    if (!known.has(name)) unsupported(`tool:${name}`);
    if (!seen.has(name)) {
      seen.add(name);
      tools.push(name);
    }
  }
  const denied = new Set(agent.disallowedTools ?? []);
  return tools.filter((name) => !denied.has(name));
}

function buildCliArguments(
  policy: TerminalPolicy,
  session: PersistentSessionReference<"terminal">,
  promptFile: string,
  systemPromptFile: string,
  config: ResolvedTerminalBackendConfig,
): string[] {
  const args = [
    ...config.executableArgs,
    "-e",
    CHILD_EXTENSION_FILE,
  ];
  for (const extension of config.providerExtensions) args.push("-e", extension);
  args.push(
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-approve",
    "--offline",
    "--model",
    `${policy.model.provider}/${policy.model.id}`,
  );
  if (policy.thinkingLevel !== undefined) args.push("--thinking", policy.thinkingLevel);
  args.push(
    "--session",
    session.sessionFile,
    "--system-prompt",
    systemPromptFile,
  );
  // Pi keeps --tools as a registry-level allowlist, including later dynamic tools.
  const cliTools = [...policy.tools, ...(policy.structuredSchema ? [STRUCTURED_OUTPUT_TOOL_NAME] : [])];
  if (cliTools.length === 0) args.push("--no-tools");
  else args.push("--tools", cliTools.join(","));
  if (config.mode === "json") args.push("--mode", "json");
  args.push("--", `@${promptFile}`);
  return args;
}

function resolveConfig(config: TerminalBackendConfig): ResolvedTerminalBackendConfig {
  if (config === null || typeof config !== "object" || Array.isArray(config)) invalidConfig();
  const agentDir = config.agentDir ?? getAgentDir();
  const sessionDir = config.sessionDir ?? join(agentDir, DEFAULT_ROOT_DIRECTORY, "sessions");
  const artifactDir = config.artifactDir ?? join(agentDir, DEFAULT_ROOT_DIRECTORY, "runs");
  const executable = config.executable ?? process.execPath;
  const executableArgs = config.executableArgs ?? [PI_CLI_FILE];
  const interpreter = config.interpreter ?? DEFAULT_INTERPRETER;
  const providerExtensions = config.providerExtensions ?? [];
  const mode = config.mode ?? "auto";

  if (![agentDir, sessionDir, artifactDir].every((path) => nonEmpty(path) && isAbsolute(path))) invalidConfig();
  if (!nonEmpty(executable) || !Array.isArray(executableArgs)
    || executableArgs.some((argument) => typeof argument !== "string")) invalidConfig();
  if (interpreter !== "bash" && interpreter !== "powershell") invalidConfig();
  if (mode !== "auto" && mode !== "json") invalidConfig();
  if (!Array.isArray(providerExtensions)
    || providerExtensions.some((path) => !nonEmpty(path) || !isAbsolute(path))) invalidConfig();
  if (config.startupTimeoutMs !== undefined
    && (typeof config.startupTimeoutMs !== "number"
      || !Number.isFinite(config.startupTimeoutMs)
      || config.startupTimeoutMs <= 0)) invalidConfig();

  return {
    agentDir,
    sessionDir,
    artifactDir,
    executable,
    executableArgs: [...executableArgs],
    interpreter,
    providerExtensions: [...providerExtensions],
    mode,
  };
}

export function validatePolicy(value: unknown): asserts value is TerminalPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidConfig();
  const policy = value as TerminalPolicy;
  if (!nonEmpty(policy.type) || !nonEmpty(policy.name) || !nonEmpty(policy.cwd)
    || !isAbsolute(policy.cwd) || !policy.model || !nonEmpty(policy.model.provider)
    || !nonEmpty(policy.model.id) || typeof policy.systemPrompt !== "string" || !Array.isArray(policy.tools)
    || policy.tools.some((tool) => !BUILTIN_TOOL_NAMES.includes(tool)) || new Set(policy.tools).size !== policy.tools.length
    || (policy.modelFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(policy.modelFingerprint))
    || (policy.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(policy.thinkingLevel))
    || !validTurnBudget(policy.maxTurns, policy.graceTurns)) invalidConfig();
  if (policy.structuredSchema !== undefined) compileTerminalSchema(policy.structuredSchema);
}

function validateSession(session: PersistentSessionReference<"terminal">): void {
  if (!session || session.backend !== "terminal" || !nonEmpty(session.sessionId)
    || !nonEmpty(session.sessionFile) || !isAbsolute(session.sessionFile)) invalidConfig();
}

function validEndpoint(endpoint: TerminalChildManifest["endpoint"]): boolean {
  return endpoint !== null && typeof endpoint === "object" && endpoint.host === "127.0.0.1"
    && Number.isSafeInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65_535
    && nonEmpty(endpoint.token);
}

function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function quoteBash(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function unsupported(feature: string): never {
  throw new Error(i18n.t("terminalBackend.unsupported", { feature }));
}

function invalidConfig(): never {
  throw new Error(i18n.t("terminalBackend.invalidConfig"));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
