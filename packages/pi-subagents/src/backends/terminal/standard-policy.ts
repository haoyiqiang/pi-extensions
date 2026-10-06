import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getMemoryToolNames,
  getReadOnlyMemoryToolNames,
  isDefaultsDisabled,
} from "../../agent-types.js";
import { buildParentContext } from "../../context.js";
import { DEFAULT_AGENTS } from "../../default-agents.js";
import { detectEnv } from "../../env.js";
import { i18n } from "../../i18n.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "../../memory.js";
import { getMaxSubagentDepth } from "../../nested-tools.js";
import { buildAgentPrompt, type PromptExtras } from "../../prompts.js";
import { resolveAgentLaunchBehavior } from "../../invocation-config.js";
import { preloadSkills } from "../../skill-loader.js";
import type { AgentConfig, EffectiveThinkingLevel, SubagentType } from "../../types.js";
import { getDefaultMaxTurns, getGraceTurns, getRememberAgents, normalizeMaxTurns, resolveDefaultModel } from "../embedded.js";
import { compileInvocationSchema, validTurnBudget } from "../invocation-policy.js";
import { modelFingerprint } from "../model-identity.js";
import { snapshotPromptBinding, type PromptBinding } from "../prompt-binding.js";
import type { ExecutionRunOptions } from "../types.js";

export type StandardTerminalCli = "pi";

export interface StandardTerminalPolicy {
  readonly profile: "standard";
  readonly promptBinding?: PromptBinding;
  readonly type: SubagentType;
  readonly name: string;
  readonly cwd: string;
  /** Resource/settings/trust origin; may intentionally differ from cwd. */
  readonly configCwd: string;
  readonly cli: StandardTerminalCli;
  readonly agent: AgentConfig;
  readonly isolated: boolean;
  readonly projectTrusted: boolean;
  readonly persistSession: boolean;
  readonly sessionDir?: string;
  readonly model?: Readonly<{ provider: string; id: string }>;
  readonly modelFingerprint?: string;
  readonly thinkingLevel?: EffectiveThinkingLevel;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  readonly interactive: boolean;
  readonly autoExit: boolean;
  readonly structuredSchema?: Record<string, unknown>;
  readonly maxTurns?: number;
  readonly graceTurns?: number;
  readonly nested?: Readonly<{
    /** Descendants remain on the backend that owns this persisted branch. */
    backend: "terminal";
    depth: number;
    maxSubagentDepth: number;
  }>;
}

function resolveAgent(type: SubagentType, captured?: AgentConfig): AgentConfig {
  if (captured?.enabled === false) throw new Error(i18n.t("terminalBackend.invalidConfig"));
  if (captured) return captured;
  const registered = getAgentConfig(type);
  if (registered?.enabled === false) throw new Error(i18n.t("terminalBackend.invalidConfig"));
  if (registered) return registered;
  if (!isDefaultsDisabled()) {
    const lower = type.toLowerCase();
    for (const [name, agent] of DEFAULT_AGENTS) {
      if (name.toLowerCase() === lower && agent.enabled !== false) return agent;
    }
  }
  throw new Error(i18n.t("terminalBackend.invalidConfig"));
}

function configuredSessionDir(value: string | undefined, cwd: string): string | undefined {
  if (!value) return undefined;
  if (value === "~" || value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/** Prepare ordinary product execution without imposing the managed profile. */
export async function prepareStandardTerminalPolicy(
  ctx: ExtensionContext,
  type: SubagentType,
  options: ExecutionRunOptions,
): Promise<{ policy: StandardTerminalPolicy; prompt: (prompt: string) => string }> {
  const agent = resolveAgent(type, options.agentConfig);
  const launch = resolveAgentLaunchBehavior(agent, options);
  if (options.structuredOutput !== undefined && (!options.structuredOutput || typeof options.structuredOutput.check !== "function")) {
    throw new Error(i18n.t("terminalBackend.invalidConfig"));
  }

  const cwd = options.cwd ?? ctx.cwd;
  const configCwd = options.configCwd ?? cwd;
  const isolated = options.isolated ?? agent.isolated ?? false;
  const inheritContext = options.inheritContext ?? agent.inheritContext ?? false;
  if (!isAbsolute(cwd) || !isAbsolute(configCwd)) throw new Error(i18n.t("terminalBackend.invalidConfig"));

  const structuredSchema = options.structuredOutput === undefined
    ? undefined
    : compileInvocationSchema(options.structuredOutput.schema).schema;
  const maxTurns = normalizeMaxTurns(options.maxTurns ?? agent.maxTurns ?? getDefaultMaxTurns());
  const graceTurns = maxTurns === undefined ? undefined : getGraceTurns();
  if (!validTurnBudget(maxTurns, graceTurns)) throw new Error(i18n.t("terminalBackend.invalidConfig"));

  let tools = agent.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
  const extras: PromptExtras = {};
  if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;
  if (options.workflow && !structuredSchema) extras.workflowChild = true;

  if (agent.memory) {
    const current = new Set(tools);
    const denied = new Set(agent.disallowedTools ?? []);
    const writable = (current.has("write") && !denied.has("write")) || (current.has("edit") && !denied.has("edit"));
    if (writable) {
      tools = [...tools, ...getMemoryToolNames(current)];
      extras.memoryBlock = buildMemoryBlock(agent.name, agent.memory, configCwd);
    } else {
      tools = [...tools, ...getReadOnlyMemoryToolNames(current)];
      extras.memoryBlock = buildReadOnlyMemoryBlock(agent.name, agent.memory, configCwd);
    }
  }
  tools = [...new Set(tools)].filter((name) => !agent.disallowedTools?.includes(name));

  if (!isolated && Array.isArray(agent.skills)) {
    const loaded = preloadSkills(agent.skills, configCwd);
    if (loaded.length > 0) extras.skillBlocks = loaded;
  }

  const env = await detectEnv(options.pi, cwd);
  const systemPrompt = buildAgentPrompt(agent, cwd, env, ctx.getSystemPrompt(), extras);
  const selectedModel = options.model ?? resolveDefaultModel(ctx.model, ctx.modelRegistry, agent.model);
  const thinkingLevel = options.thinkingLevel ?? agent.thinking;
  const persistSession = agent.persistSession ?? (options.nested ? false : getRememberAgents());
  const nested = !isolated && agent.allowedSubagents ? Object.freeze({
    // This policy is created only after the terminal backend owns the branch.
    // Persist that fact so a later config edit cannot reroute descendants.
    backend: "terminal" as const,
    depth: options.nestedRuntime?.depth ?? 1,
    maxSubagentDepth: options.nestedRuntime?.maxSubagentDepth ?? getMaxSubagentDepth(),
  }) : undefined;

  const policy: StandardTerminalPolicy = Object.freeze({
    profile: "standard",
    ...(options.promptBinding !== undefined ? { promptBinding: snapshotPromptBinding(options.promptBinding) } : {}),
    type,
    name: agent.displayName ?? agent.name,
    cwd,
    configCwd,
    cli: "pi",
    agent: Object.freeze({ ...agent }),
    isolated,
    projectTrusted: typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false,
    persistSession,
    ...(configuredSessionDir(agent.sessionDir, cwd) ? { sessionDir: configuredSessionDir(agent.sessionDir, cwd) } : {}),
    ...(selectedModel ? { model: Object.freeze({ provider: selectedModel.provider, id: selectedModel.id }), modelFingerprint: modelFingerprint(selectedModel) } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    tools: Object.freeze(tools),
    systemPrompt,
    interactive: launch.interactive,
    autoExit: launch.autoExit,
    ...(structuredSchema ? { structuredSchema } : {}),
    ...(maxTurns !== undefined ? { maxTurns, graceTurns } : {}),
    ...(nested ? { nested } : {}),
  });

  return {
    policy,
    prompt(prompt) {
      if (!inheritContext) return prompt;
      const parent = buildParentContext(ctx);
      return parent ? parent + prompt : prompt;
    },
  };
}

export function validateStandardTerminalPolicy(value: unknown): asserts value is StandardTerminalPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(i18n.t("terminalBackend.invalidConfig"));
  const policy = value as StandardTerminalPolicy;
  if (policy.profile !== "standard" || !policy.type || !policy.name || !isAbsolute(policy.cwd)
    || !isAbsolute(policy.configCwd) || policy.cli !== "pi"
    || !policy.agent || typeof policy.agent !== "object" || Array.isArray(policy.agent)
    || typeof policy.agent.name !== "string" || typeof policy.agent.description !== "string"
    || (policy.model !== undefined && (!policy.model || typeof policy.model.provider !== "string" || !policy.model.provider.trim()
      || typeof policy.model.id !== "string" || !policy.model.id.trim()))
    || (policy.modelFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(policy.modelFingerprint))
    || (policy.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(policy.thinkingLevel))
    || typeof policy.systemPrompt !== "string" || typeof policy.interactive !== "boolean"
    || typeof policy.autoExit !== "boolean" || typeof policy.isolated !== "boolean"
    || typeof policy.projectTrusted !== "boolean" || typeof policy.persistSession !== "boolean"
    || (policy.sessionDir !== undefined && !isAbsolute(policy.sessionDir))
    || !Array.isArray(policy.tools) || policy.tools.some((tool) => typeof tool !== "string")
    || (policy.nested !== undefined && (policy.nested.backend !== "terminal"
      || !Number.isSafeInteger(policy.nested.depth) || policy.nested.depth < 0
      || !Number.isSafeInteger(policy.nested.maxSubagentDepth) || policy.nested.maxSubagentDepth < 0))
    || !validTurnBudget(policy.maxTurns, policy.graceTurns)) {
    throw new Error(i18n.t("terminalBackend.invalidConfig"));
  }
  snapshotPromptBinding(policy.promptBinding);
  if (policy.structuredSchema !== undefined) compileInvocationSchema(policy.structuredSchema);
}
