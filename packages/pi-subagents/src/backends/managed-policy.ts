import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getToolNamesForType, isDefaultsDisabled } from "../agent-types.js";
import { DEFAULT_AGENTS } from "../default-agents.js";
import { detectEnv } from "../env.js";
import { i18n } from "../i18n.js";
import { buildAgentPrompt, type PromptExtras } from "../prompts.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../structured-output.js";
import type { AgentConfig, EffectiveThinkingLevel, SubagentType } from "../types.js";
import { getGraceTurns, resolveDefaultModel, resolveEffectiveMaxTurns } from "./embedded.js";
import { compileInvocationSchema, validTurnBudget } from "./invocation-policy.js";
import { modelFingerprint } from "./model-identity.js";
import { snapshotPromptBinding, type PromptBinding } from "./prompt-binding.js";
import type { ExecutionRunOptions } from "./types.js";
import { assertRequiredTools, snapshotRequiredTools } from "./tool-requirements.js";

/** Fully resolved, credential-free policy for one isolated managed conversation. */
export interface ManagedPolicy {
  readonly promptBinding?: PromptBinding;
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

/** Resolve and validate all policy that must be fixed before a managed session is created. */
export async function prepareManagedPolicy(
  ctx: ExtensionContext,
  type: SubagentType,
  options: ExecutionRunOptions,
  diagnosticPrefix: "terminalBackend" | "managedEmbedded" = "terminalBackend",
): Promise<ManagedPolicy> {
  const requiredTools = snapshotRequiredTools(options.requiredTools);
  const promptBinding = snapshotPromptBinding(options.promptBinding);
  const invalidConfig = (): never => { throw new Error(i18n.t(`${diagnosticPrefix}.invalidConfig`)); };
  const unsupported = (feature: string): never => { throw new Error(i18n.t(`${diagnosticPrefix}.unsupported`, { feature })); };
  const agent = resolveAgent(type, invalidConfig);

  // Managed execution is deliberately narrower than the legacy embedded backend.
  // Keep these checks ahead of detectEnv(), the first operation that may spawn a process.
  rejectUnsupportedOptions(agent, options, unsupported);
  if (options.structuredOutput !== undefined && (!options.structuredOutput || typeof options.structuredOutput.check !== "function")) invalidConfig();
  const structuredSchema = options.structuredOutput === undefined ? undefined
    : compileInvocationSchema(options.structuredOutput.schema).schema;
  const maxTurns = resolveEffectiveMaxTurns(type, options.maxTurns);
  const graceTurns = maxTurns === undefined ? undefined : getGraceTurns();
  if (!validTurnBudget(maxTurns, graceTurns)) invalidConfig();

  const tools = resolveTools(type, agent, unsupported);
  assertRequiredTools(requiredTools, structuredSchema === undefined ? tools : [...tools, STRUCTURED_OUTPUT_TOOL_NAME]);
  const selectedModel = options.model ?? resolveDefaultModel(ctx.model, ctx.modelRegistry, agent.model);
  if (!selectedModel || !nonEmpty(selectedModel.provider) || !nonEmpty(selectedModel.id)) {
    throw new Error(i18n.t(`${diagnosticPrefix}.noModel`));
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
    ...(promptBinding !== undefined ? { promptBinding } : {}),
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

export function validateManagedPolicy(value: unknown): asserts value is ManagedPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidConfig();
  const policy = value as ManagedPolicy;
  if (!nonEmpty(policy.type) || !nonEmpty(policy.name) || !nonEmpty(policy.cwd)
    || !isAbsolute(policy.cwd) || !policy.model || !nonEmpty(policy.model.provider)
    || !nonEmpty(policy.model.id) || typeof policy.systemPrompt !== "string" || !Array.isArray(policy.tools)
    || policy.tools.some((tool) => !BUILTIN_TOOL_NAMES.includes(tool)) || new Set(policy.tools).size !== policy.tools.length
    || (policy.modelFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(policy.modelFingerprint))
    || (policy.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(policy.thinkingLevel))
    || !validTurnBudget(policy.maxTurns, policy.graceTurns)) invalidConfig();
  snapshotPromptBinding(policy.promptBinding);
  if (policy.structuredSchema !== undefined) compileInvocationSchema(policy.structuredSchema);
}

function resolveAgent(type: SubagentType, invalidConfig: () => never): AgentConfig {
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
  unsupported: (feature: string) => never,
): void {
  if (options.isolated !== true) unsupported("isolated=false");
  if (options.inheritContext === true) unsupported("inheritContext");
  if (options.resumeSessionFile !== undefined) unsupported("resumeSessionFile");
  if (agent.memory !== undefined) unsupported("memory");
  if (agent.persistSession === false) unsupported("persistSession=false");
  // nestedRuntime is intentionally ignored: isolated embedded runs do not admit
  // nested delegation tools either, so no manager object crosses the boundary.
}

function resolveTools(type: SubagentType, agent: AgentConfig, unsupported: (feature: string) => never): string[] {
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

function invalidConfig(): never {
  throw new Error(i18n.t("terminalBackend.invalidConfig"));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
