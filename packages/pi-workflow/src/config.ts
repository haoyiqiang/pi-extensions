import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  extensionConfigPath,
  readJsonObjectResult,
  resolveAgentDir,
  type JsonObject,
} from "pi-extensions-config";
import type { ModelSelection } from "./host.js";
import { i18n } from "./i18n.js";
import type {
  WorkflowExecutorBackend,
  WorkflowExecutorSettings,
  WorkflowExecutorSkillApproval,
} from "./pi-protocol.js";

export const DEFAULT_WORKFLOW_EXECUTION = Object.freeze({
  executor: "pi-subagents",
  profile: "standard" as const,
  maxConcurrency: 4,
});

export interface WorkflowExecutionConfig {
  executor: string;
  profile?: "standard" | "managed";
  backend?: WorkflowExecutorBackend;
  agentType?: string;
  maxConcurrency?: number;
  maxTurns?: number;
}

export interface WorkflowModelsConfig {
  readonly defaults?: Readonly<ModelSelection>;
  readonly stages?: Readonly<Record<string, Readonly<ModelSelection>>>;
  readonly skills?: Readonly<Record<string, Readonly<ModelSelection>>>;
  readonly presets?: Readonly<Record<string, {
    readonly stages?: Readonly<Record<string, Readonly<ModelSelection>>>;
  }>>;
}

export interface WorkflowConfig {
  execution: WorkflowExecutionConfig;
  skills: readonly WorkflowExecutorSkillApproval[];
  requiredTools: readonly string[];
  models?: WorkflowModelsConfig;
}

interface WorkflowConfigLayer {
  execution?: Partial<WorkflowExecutionConfig>;
  skills?: readonly WorkflowExecutorSkillApproval[];
  requiredTools?: readonly string[];
  models?: WorkflowModelsConfig;
}

export interface WorkflowConfigPaths {
  global: string;
  project: string;
}

export interface LoadWorkflowConfigOptions {
  agentDir?: string;
  /** Explicit launcher decision; rejected projects cannot replace approved policy. */
  projectTrusted?: boolean;
}

const TOP_LEVEL_KEYS = new Set(["execution", "skills", "requiredTools", "models"]);
const EXECUTION_KEYS = new Set(["executor", "profile", "backend", "agentType", "maxConcurrency", "maxTurns"]);
const SKILL_KEYS = new Set(["name", "filePath", "baseDir", "format", "requiredTools", "expectedSha256"]);
const MODELS_KEYS = new Set(["defaults", "stages", "skills", "presets"]);
const MODEL_ENTRY_KEYS = new Set(["model", "thinking"]);
const PRESET_KEYS = new Set(["stages"]);
const THINKING_LEVELS = new Set<ModelSelection["thinking"]>([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);
const SHA256 = /^[a-f0-9]{64}$/i;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INVALID_PATH_CHARACTERS = /[\u0000-\u001f\u007f]/;
const INVALID_TOOL_NAME_CHARACTERS = /[\s\p{Cc}\p{Cf}*?\[\]{}]/u;

/** Portable Pi-native path seam; workflow overlays retain their legacy layout. */
export function getAgentDir(): string {
  return resolveAgentDir();
}

/** Retains rpiv-config's XDG behavior until an explicit workflow-path migration. */
export function getLegacyWorkflowConfigDir(): string {
  const home = homedir();
  const configured = process.env.XDG_CONFIG_HOME?.trim();
  const expanded = configured === "~"
    ? home
    : configured?.startsWith("~/")
      ? join(home, configured.slice(2))
      : configured;
  const root = expanded && isAbsolute(expanded) ? expanded : join(home, ".config");
  return join(root, "rpiv-workflow");
}

export function getWorkflowConfigPaths(cwd: string, agentDir = resolveAgentDir()): WorkflowConfigPaths {
  return {
    global: extensionConfigPath("pi-workflow", "config.json", agentDir),
    project: join(resolve(cwd), ".pi", "pi-workflow.json"),
  };
}

/**
 * Load strict global + project settings. Execution fields merge by key;
 * project `skills` and `requiredTools` replace their global arrays, while model
 * maps overlay by stage/skill/preset key and project defaults replace globals.
 */
export function loadWorkflowConfig(cwd: string, options: LoadWorkflowConfigOptions = {}): WorkflowConfig {
  const paths = getWorkflowConfigPaths(cwd, options.agentDir);
  const global = readLayer(paths.global);
  const project = options.projectTrusted === false ? {} : readLayer(paths.project);
  const execution: WorkflowExecutionConfig = {
    ...DEFAULT_WORKFLOW_EXECUTION,
    ...global.execution,
    ...project.execution,
  };
  const skills = project.skills ?? global.skills ?? [];
  const requiredTools = project.requiredTools ?? global.requiredTools ?? [];
  const models = mergeModels(global.models, project.models);
  return Object.freeze({
    execution: Object.freeze({ ...execution }),
    skills: Object.freeze([...skills]),
    requiredTools: Object.freeze([...requiredTools]),
    ...(models !== undefined ? { models } : {}),
  });
}

export function workflowExecutorSettings(config: WorkflowConfig): WorkflowExecutorSettings {
  const { execution } = config;
  return Object.freeze({
    profile: execution.profile ?? "standard",
    ...(execution.backend !== undefined ? { backend: execution.backend } : {}),
    ...(execution.agentType !== undefined ? { agentType: execution.agentType } : {}),
    ...(execution.maxConcurrency !== undefined ? { maxConcurrency: execution.maxConcurrency } : {}),
    ...(execution.maxTurns !== undefined ? { maxTurns: execution.maxTurns } : {}),
    requiredTools: config.requiredTools,
    skills: config.skills,
  });
}

/** Resolve the most-specific workflow model entry and compose that one leaf
 * against defaults. Competing preset/stage/skill tiers never merge fields. */
export function resolveWorkflowModel(
  config: WorkflowConfig,
  id: { workflow: string; stage: string; skill: string },
): ModelSelection | undefined {
  const models = config.models;
  if (!models) return undefined;
  const preset = ownEntry(models.presets, id.workflow);
  const selected = ownEntry(preset?.stages, id.stage)
    ?? ownEntry(models.stages, id.stage)
    ?? ownEntry(models.skills, id.skill);
  const resolved = selected === undefined
    ? models.defaults
    : { ...models.defaults, ...selected };
  if (resolved?.model === undefined && resolved?.thinking === undefined) return undefined;
  return Object.freeze({ ...resolved });
}

function ownEntry<T>(entries: Readonly<Record<string, T>> | undefined, name: string): T | undefined {
  return entries && Object.hasOwn(entries, name) ? entries[name] : undefined;
}

function readLayer(path: string): WorkflowConfigLayer {
  const result = readJsonObjectResult(path);
  if (result.status === "missing") return {};
  if (result.status === "invalid") {
    throw configError(path, i18n.t("config.invalidJson", { error: result.error.message }));
  }
  return parseLayer(result.value, path);
}

function parseLayer(value: JsonObject, path: string): WorkflowConfigLayer {
  rejectUnknown(value, TOP_LEVEL_KEYS, path, "config");
  const baseDirectory = dirname(path);
  const layer: WorkflowConfigLayer = {};
  if (Object.hasOwn(value, "execution")) layer.execution = parseExecution(value.execution, path);
  if (Object.hasOwn(value, "skills")) layer.skills = parseSkills(value.skills, path, baseDirectory);
  if (Object.hasOwn(value, "requiredTools")) layer.requiredTools = parseStringList(value.requiredTools, path, "requiredTools");
  if (Object.hasOwn(value, "models")) layer.models = parseModels(value.models, path);
  return layer;
}

function parseExecution(value: unknown, path: string): Partial<WorkflowExecutionConfig> {
  const object = expectObject(value, path, "execution");
  rejectUnknown(object, EXECUTION_KEYS, path, "execution");
  const execution: Partial<WorkflowExecutionConfig> = {};
  if (Object.hasOwn(object, "executor")) execution.executor = expectNonEmptyString(object.executor, path, "execution.executor");
  if (Object.hasOwn(object, "profile")) {
    if (object.profile !== "standard" && object.profile !== "managed") {
      throw invalidField(path, "execution.profile", i18n.t("config.expectedProfile"));
    }
    execution.profile = object.profile;
  }
  if (Object.hasOwn(object, "backend")) execution.backend = expectBackend(object.backend, path);
  if (Object.hasOwn(object, "agentType")) execution.agentType = expectNonEmptyString(object.agentType, path, "execution.agentType");
  if (Object.hasOwn(object, "maxConcurrency")) {
    execution.maxConcurrency = expectPositiveInteger(object.maxConcurrency, path, "execution.maxConcurrency");
  }
  if (Object.hasOwn(object, "maxTurns")) execution.maxTurns = expectPositiveInteger(object.maxTurns, path, "execution.maxTurns");
  return execution;
}

function parseModels(value: unknown, path: string): WorkflowModelsConfig {
  const object = expectObject(value, path, "models");
  rejectUnknown(object, MODELS_KEYS, path, "models");
  const models: {
    defaults?: Readonly<ModelSelection>;
    stages?: Readonly<Record<string, Readonly<ModelSelection>>>;
    skills?: Readonly<Record<string, Readonly<ModelSelection>>>;
    presets?: Readonly<Record<string, { readonly stages?: Readonly<Record<string, Readonly<ModelSelection>>> }>>;
  } = {};
  if (Object.hasOwn(object, "defaults")) models.defaults = parseModelEntry(object.defaults, path, "models.defaults");
  if (Object.hasOwn(object, "stages")) models.stages = parseModelMap(object.stages, path, "models.stages");
  if (Object.hasOwn(object, "skills")) models.skills = parseModelMap(object.skills, path, "models.skills");
  if (Object.hasOwn(object, "presets")) {
    const presets = expectObject(object.presets, path, "models.presets");
    const parsed: Record<string, { readonly stages?: Readonly<Record<string, Readonly<ModelSelection>>> }> = Object.create(null);
    for (const [workflow, raw] of Object.entries(presets)) {
      const field = `models.presets.${workflow}`;
      const preset = expectObject(raw, path, field);
      rejectUnknown(preset, PRESET_KEYS, path, field);
      parsed[workflow] = Object.freeze({
        ...(Object.hasOwn(preset, "stages")
          ? { stages: parseModelMap(preset.stages, path, `${field}.stages`) }
          : {}),
      });
    }
    models.presets = Object.freeze(parsed);
  }
  return Object.freeze(models);
}

function parseModelMap(
  value: unknown,
  path: string,
  field: string,
): Readonly<Record<string, Readonly<ModelSelection>>> {
  const object = expectObject(value, path, field);
  const parsed: Record<string, Readonly<ModelSelection>> = Object.create(null);
  for (const [name, entry] of Object.entries(object)) {
    parsed[name] = parseModelEntry(entry, path, `${field}.${name}`);
  }
  return Object.freeze(parsed);
}

function parseModelEntry(value: unknown, path: string, field: string): Readonly<ModelSelection> {
  if (typeof value === "string") {
    if (!value.trim()) throw invalidField(path, field, i18n.t("config.expectedString"));
    return Object.freeze({ model: value });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidField(path, field, i18n.t("config.expectedModelEntry"));
  }
  const object = value as JsonObject;
  rejectUnknown(object, MODEL_ENTRY_KEYS, path, field);
  const result: ModelSelection = {};
  if (Object.hasOwn(object, "model")) {
    result.model = expectNonEmptyString(object.model, path, `${field}.model`);
  }
  if (Object.hasOwn(object, "thinking")) {
    if (typeof object.thinking !== "string" || !THINKING_LEVELS.has(object.thinking as ModelSelection["thinking"])) {
      throw invalidField(path, `${field}.thinking`, i18n.t("config.expectedThinking"));
    }
    result.thinking = object.thinking as ModelSelection["thinking"];
  }
  return Object.freeze(result);
}

function mergeModels(
  global: WorkflowModelsConfig | undefined,
  project: WorkflowModelsConfig | undefined,
): WorkflowModelsConfig | undefined {
  if (!global && !project) return undefined;
  const stages = Object.freeze({ ...global?.stages, ...project?.stages });
  const skills = Object.freeze({ ...global?.skills, ...project?.skills });
  const presets: Record<string, { readonly stages?: Readonly<Record<string, Readonly<ModelSelection>>> }> = Object.create(null);
  for (const workflow of new Set([
    ...Object.keys(global?.presets ?? {}),
    ...Object.keys(project?.presets ?? {}),
  ])) {
    const mergedStages = Object.freeze({
      ...global?.presets?.[workflow]?.stages,
      ...project?.presets?.[workflow]?.stages,
    });
    presets[workflow] = Object.freeze({
      ...(Object.keys(mergedStages).length > 0 ? { stages: mergedStages } : {}),
    });
  }
  return Object.freeze({
    ...(project?.defaults !== undefined
      ? { defaults: project.defaults }
      : global?.defaults !== undefined ? { defaults: global.defaults } : {}),
    ...(Object.keys(stages).length > 0 ? { stages } : {}),
    ...(Object.keys(skills).length > 0 ? { skills } : {}),
    ...(Object.keys(presets).length > 0 ? { presets: Object.freeze(presets) } : {}),
  });
}

function parseSkills(value: unknown, path: string, baseDirectory: string): readonly WorkflowExecutorSkillApproval[] {
  if (!Array.isArray(value)) throw invalidField(path, "skills", i18n.t("config.expectedArray"));
  const seen = new Set<string>();
  const skills = value.map((entry, index) => {
    const skill = parseSkill(entry, path, baseDirectory, index);
    if (seen.has(skill.name)) throw invalidField(path, "skills", i18n.t("config.duplicateValue", { value: skill.name }));
    seen.add(skill.name);
    return skill;
  });
  return Object.freeze(skills);
}

function parseSkill(value: unknown, path: string, configDirectory: string, index: number): WorkflowExecutorSkillApproval {
  const field = `skills[${index}]`;
  const object = expectObject(value, path, field);
  rejectUnknown(object, SKILL_KEYS, path, field);
  const name = expectNonEmptyString(object.name, path, `${field}.name`);
  if (name.length > 64 || !SKILL_NAME.test(name)) {
    throw invalidField(path, `${field}.name`, i18n.t("config.expectedSkillName"));
  }
  const filePath = resolveConfigPath(expectNonEmptyString(object.filePath, path, `${field}.filePath`), configDirectory, path, `${field}.filePath`);
  const baseDir = resolveConfigPath(expectNonEmptyString(object.baseDir, path, `${field}.baseDir`), configDirectory, path, `${field}.baseDir`);
  const format = object.format;
  if (format !== "pi" && format !== "positional-v1") {
    throw invalidField(path, `${field}.format`, i18n.t("config.expectedSkillFormat"));
  }
  const requiredTools = Object.hasOwn(object, "requiredTools")
    ? parseStringList(object.requiredTools, path, `${field}.requiredTools`)
    : undefined;
  const expectedSha256 = Object.hasOwn(object, "expectedSha256")
    ? expectNonEmptyString(object.expectedSha256, path, `${field}.expectedSha256`).toLowerCase()
    : undefined;
  if (expectedSha256 !== undefined && !SHA256.test(expectedSha256)) {
    throw invalidField(path, `${field}.expectedSha256`, i18n.t("config.expectedSha256"));
  }
  return Object.freeze({
    name,
    filePath,
    baseDir,
    format,
    ...(requiredTools !== undefined ? { requiredTools } : {}),
    ...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
  });
}

function parseStringList(value: unknown, path: string, field: string): readonly string[] {
  if (!Array.isArray(value)) throw invalidField(path, field, i18n.t("config.expectedArray"));
  const seen = new Set<string>();
  const result = value.map((entry, index) => {
    const text = expectNonEmptyString(entry, path, `${field}[${index}]`);
    if (text.length > 256 || INVALID_TOOL_NAME_CHARACTERS.test(text)) {
      throw invalidField(path, `${field}[${index}]`, i18n.t("config.expectedToolName"));
    }
    if (seen.has(text)) throw invalidField(path, field, i18n.t("config.duplicateValue", { value: text }));
    seen.add(text);
    return text;
  });
  return Object.freeze(result);
}

function expectObject(value: unknown, path: string, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidField(path, field, i18n.t("config.expectedObject"));
  }
  return value as JsonObject;
}

function expectNonEmptyString(value: unknown, path: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidField(path, field, i18n.t("config.expectedString"));
  return value;
}

function expectPositiveInteger(value: unknown, path: string, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw invalidField(path, field, i18n.t("config.expectedPositiveInteger"));
  }
  return value as number;
}

function expectBackend(value: unknown, path: string): WorkflowExecutorBackend {
  if (value !== "embedded" && value !== "terminal") {
    throw invalidField(path, "execution.backend", i18n.t("config.expectedBackend"));
  }
  return value;
}

function rejectUnknown(object: JsonObject, allowed: ReadonlySet<string>, path: string, field: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw invalidField(path, `${field}.${key}`, i18n.t("config.unknownField"));
  }
}

function resolveConfigPath(value: string, configDirectory: string, configPath: string, field: string): string {
  if (INVALID_PATH_CHARACTERS.test(value)) throw invalidField(configPath, field, i18n.t("config.expectedPath"));
  return normalize(isAbsolute(value) ? value : resolve(configDirectory, value));
}

function invalidField(path: string, field: string, reason: string): Error {
  return configError(path, i18n.t("config.invalidField", { field, reason }));
}

function configError(path: string, detail: string): Error {
  return new Error(i18n.t("config.invalid", { path, detail }));
}
