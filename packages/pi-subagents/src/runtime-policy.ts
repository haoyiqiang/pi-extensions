import { resolve } from "node:path";
import { loadSettings, type SubagentsConfig } from "./settings.js";

/** Invocation-owned defaults; a replacement root cannot rewrite a draining actor. */
export interface SubagentsRuntimePolicy {
  readonly configCwd: string;
  readonly projectTrusted: boolean;
  readonly settings: Readonly<SubagentsConfig>;
  readonly defaultMaxTurns: number;
  readonly graceTurns: number;
  readonly rememberAgents: boolean;
  readonly outputTranscript: boolean;
  readonly scopeModels: boolean;
  readonly worktreeIsolation: boolean;
  readonly maxSubagentDepth: number;
}

export function captureRuntimePolicy(
  cwd: string,
  projectTrusted: boolean,
  capturedSettings?: Readonly<SubagentsConfig>,
): SubagentsRuntimePolicy {
  const configCwd = resolve(cwd);
  const configured = capturedSettings ?? loadSettings(configCwd, { projectTrusted });
  const settings = Object.freeze({
    ...configured,
    ...(Array.isArray(configured.defaultExtensions)
      ? { defaultExtensions: Object.freeze([...configured.defaultExtensions]) as unknown as string[] }
      : {}),
    disableDefaultAgents: configured.disableDefaultAgents ?? false,
    scopeModels: configured.scopeModels ?? false,
    worktreeIsolation: configured.worktreeIsolation ?? true,
    rememberAgents: configured.rememberAgents ?? true,
    outputTranscript: configured.outputTranscript ?? true,
    graceTurns: configured.graceTurns ?? 5,
    maxSubagentDepth: configured.maxSubagentDepth ?? 2,
  });
  return Object.freeze({
    configCwd,
    projectTrusted,
    settings,
    defaultMaxTurns: settings.defaultMaxTurns ?? 0,
    graceTurns: settings.graceTurns ?? 5,
    rememberAgents: settings.rememberAgents ?? true,
    outputTranscript: settings.outputTranscript ?? true,
    scopeModels: settings.scopeModels ?? false,
    worktreeIsolation: settings.worktreeIsolation ?? true,
    maxSubagentDepth: settings.maxSubagentDepth ?? 2,
  });
}
