import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  extensionConfigPath,
  readJsonObjectResult,
  resolveAgentDir,
  type JsonObject,
} from "pi-extensions-config";
import { i18n } from "./i18n.js";
import type {
  WorkflowExecutorBackend,
  WorkflowExecutorSettings,
  WorkflowExecutorSkillApproval,
} from "./pi-protocol.js";

export const DEFAULT_WORKFLOW_EXECUTION = Object.freeze({
  executor: "pi-subagents",
  backend: "embedded" as const,
  agentType: "general-purpose",
  maxConcurrency: 4,
});

export interface WorkflowExecutionConfig {
  executor: string;
  backend: WorkflowExecutorBackend;
  agentType?: string;
  maxConcurrency?: number;
  maxTurns?: number;
}

export interface WorkflowConfig {
  execution: WorkflowExecutionConfig;
  skills: readonly WorkflowExecutorSkillApproval[];
  requiredTools: readonly string[];
}

interface WorkflowConfigLayer {
  execution?: Partial<WorkflowExecutionConfig>;
  skills?: readonly WorkflowExecutorSkillApproval[];
  requiredTools?: readonly string[];
}

export interface WorkflowConfigPaths {
  global: string;
  project: string;
}

export interface LoadWorkflowConfigOptions {
  agentDir?: string;
}

const TOP_LEVEL_KEYS = new Set(["execution", "skills", "requiredTools"]);
const EXECUTION_KEYS = new Set(["executor", "backend", "agentType", "maxConcurrency", "maxTurns"]);
const SKILL_KEYS = new Set(["name", "filePath", "baseDir", "format", "requiredTools", "expectedSha256"]);
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
 * project `skills` and `requiredTools` replace their global arrays when present.
 */
export function loadWorkflowConfig(cwd: string, options: LoadWorkflowConfigOptions = {}): WorkflowConfig {
  const paths = getWorkflowConfigPaths(cwd, options.agentDir);
  const global = readLayer(paths.global);
  const project = readLayer(paths.project);
  const execution: WorkflowExecutionConfig = {
    ...DEFAULT_WORKFLOW_EXECUTION,
    ...global.execution,
    ...project.execution,
  };
  const skills = project.skills ?? global.skills ?? [];
  const requiredTools = project.requiredTools ?? global.requiredTools ?? [];
  return Object.freeze({
    execution: Object.freeze({ ...execution }),
    skills: Object.freeze([...skills]),
    requiredTools: Object.freeze([...requiredTools]),
  });
}

export function workflowExecutorSettings(config: WorkflowConfig): WorkflowExecutorSettings {
  const { execution } = config;
  return Object.freeze({
    backend: execution.backend,
    ...(execution.agentType !== undefined ? { agentType: execution.agentType } : {}),
    ...(execution.maxConcurrency !== undefined ? { maxConcurrency: execution.maxConcurrency } : {}),
    ...(execution.maxTurns !== undefined ? { maxTurns: execution.maxTurns } : {}),
    requiredTools: config.requiredTools,
    skills: config.skills,
  });
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
  return layer;
}

function parseExecution(value: unknown, path: string): Partial<WorkflowExecutionConfig> {
  const object = expectObject(value, path, "execution");
  rejectUnknown(object, EXECUTION_KEYS, path, "execution");
  const execution: Partial<WorkflowExecutionConfig> = {};
  if (Object.hasOwn(object, "executor")) execution.executor = expectNonEmptyString(object.executor, path, "execution.executor");
  if (Object.hasOwn(object, "backend")) execution.backend = expectBackend(object.backend, path);
  if (Object.hasOwn(object, "agentType")) execution.agentType = expectNonEmptyString(object.agentType, path, "execution.agentType");
  if (Object.hasOwn(object, "maxConcurrency")) {
    execution.maxConcurrency = expectPositiveInteger(object.maxConcurrency, path, "execution.maxConcurrency");
  }
  if (Object.hasOwn(object, "maxTurns")) execution.maxTurns = expectPositiveInteger(object.maxTurns, path, "execution.maxTurns");
  return execution;
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
