import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isHeadlessSurface } from "pi-terminal-mux";
import { i18n } from "../../i18n.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../../structured-output.js";
import { validateManagedPolicy as validatePolicy, type ManagedPolicy } from "../managed-policy.js";
import type { PersistentSessionReference } from "../session-reference.js";
import {
  STANDARD_TERMINAL_CONFIG_ENV,
  TERMINAL_MANIFEST_ENV,
  type StandardTerminalChildConfig,
  type TerminalChildManifest,
} from "./bridge-protocol.js";
import type { TerminalLaunchPlan } from "./types.js";
import type { ProcessExitReceipt } from "./process-exit.js";
import type { StandardTerminalPolicy } from "./standard-policy.js";

export { prepareManagedPolicy as prepareTerminalPolicy, validateManagedPolicy as validatePolicy } from "../managed-policy.js";

const DEFAULT_ROOT_DIRECTORY = "terminal-subagents";
const DEFAULT_INTERPRETER = "bash";
const CHILD_EXTENSION_FILE = fileURLToPath(new URL("./child-extension.ts", import.meta.url));
const LAUNCH_PROCESS_FILE = fileURLToPath(new URL("./launch-process.mjs", import.meta.url));
const STANDARD_CHILD_LAUNCH_FILE = fileURLToPath(new URL("./launch-standard-child.mjs", import.meta.url));
const PI_CLI_FILE = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

export interface TerminalBackendConfig {
  /** Compatibility default is managed; standard enables normal product execution. */
  profile?: "managed" | "standard";
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

/** Compatibility name for the shared isolated managed policy. */
export type TerminalPolicy = ManagedPolicy;

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

/** Prepare a standard SDK child while retaining the private lifecycle bridge. */
export function prepareStandardTerminalLaunch(
  policy: StandardTerminalPolicy,
  session: PersistentSessionReference<"terminal">,
  runId: string,
  endpoint: TerminalChildManifest["endpoint"],
  prompt: string,
  requiredTools: readonly string[] | undefined,
  config: TerminalBackendConfig = {},
): TerminalLaunchPlan & { processExit: ProcessExitReceipt } {
  validateSession(session);
  if (!nonEmpty(runId) || typeof prompt !== "string" || !validEndpoint(endpoint)) invalidConfig();
  const resolved = resolveConfig(config);

  mkdirSync(resolved.artifactDir, { recursive: true, mode: 0o700 });
  const runDirectory = join(resolved.artifactDir, randomUUID());
  mkdirSync(runDirectory, { mode: 0o700 });

  const manifestFile = join(runDirectory, "manifest.json");
  const standardConfigFile = join(runDirectory, "standard.json");
  const promptFile = join(runDirectory, "prompt.txt");
  const launchConfigFile = join(runDirectory, "launch.json");
  const launchScriptFile = join(runDirectory, resolved.interpreter === "powershell" ? "launch.ps1" : "launch.sh");
  const run = Object.freeze({ runId, session });
  const manifest: TerminalChildManifest = {
    version: 1,
    profile: "standard",
    run,
    endpoint: { host: "127.0.0.1", port: endpoint.port, token: endpoint.token },
    ...(policy.model ? { model: { provider: policy.model.provider, id: policy.model.id } } : {}),
    ...(policy.modelFingerprint ? { modelFingerprint: policy.modelFingerprint } : {}),
    tools: [...policy.tools],
    systemPrompt: policy.systemPrompt,
    ...(policy.structuredSchema ? { structuredSchema: policy.structuredSchema } : {}),
    ...(policy.maxTurns !== undefined ? { maxTurns: policy.maxTurns, graceTurns: policy.graceTurns } : {}),
    interactive: policy.interactive,
    autoExit: policy.autoExit,
    ...(requiredTools?.length ? { requiredTools: [...requiredTools] } : {}),
  };
  const standardConfig: StandardTerminalChildConfig = {
    version: 1,
    policy,
    promptFile,
    agentDir: resolved.agentDir,
    providerExtensions: [...resolved.providerExtensions],
    outputMode: resolved.mode === "json" ? "json" : "text",
  };

  const processExit = { path: join(runDirectory, "process-exit.json"), runId, token: randomBytes(32).toString("hex") };
  const launchConfig: LaunchProcessConfig = {
    executable: resolved.executable,
    args: [...(config.executableArgs ?? []), STANDARD_CHILD_LAUNCH_FILE],
    cwd: policy.cwd,
    processExit,
    env: {
      PI_CODING_AGENT_DIR: resolved.agentDir,
      PI_SUBAGENT_NAME: policy.name,
      PI_SUBAGENT_SESSION: session.sessionFile,
      PI_SUBAGENT_ID: runId,
      ...(policy.autoExit ? { PI_SUBAGENT_AUTO_EXIT: "1" } : {}),
      ...(policy.interactive ? { PI_SUBAGENT_INTERACTIVE: "1" } : {}),
      [TERMINAL_MANIFEST_ENV]: manifestFile,
      [STANDARD_TERMINAL_CONFIG_ENV]: standardConfigFile,
    },
  };

  try {
    writePrivateFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    writePrivateFile(standardConfigFile, `${JSON.stringify(standardConfig)}\n`);
    writePrivateFile(promptFile, prompt);
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
    buildCommand: (surface) => {
      if ((policy.interactive || !policy.autoExit) && isHeadlessSurface(surface)) {
        throw new Error(i18n.t("terminalBackend.unsupported", { feature: "interactive/headless" }));
      }
      return command;
    },
    processExit,
  };
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
  if (config.profile !== undefined && config.profile !== "managed" && config.profile !== "standard") invalidConfig();
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

function invalidConfig(): never {
  throw new Error(i18n.t("terminalBackend.invalidConfig"));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
