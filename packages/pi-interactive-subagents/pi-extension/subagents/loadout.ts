import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
export const SPAWNING_TOOLS = ["subagent", "subagent_message", "subagents_list", "subagent_status"] as const;
const strings = Type.Array(Type.String({ minLength: 1 }));
const nullableText = Type.Union([Type.String(), Type.Null()]);
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const schema = Type.Object({
  version: Type.Literal(1),
  agent: Type.String({ minLength: 1 }),
  toolAllowlist: Type.String({ minLength: 1 }),
  extensions: Type.Record(Type.String(), Type.String({ minLength: 1 })),
  model: Type.String({ minLength: 1 }),
  thinking: Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level))),
  systemPromptMode: Type.Union([Type.Literal("append"), Type.Literal("replace"), Type.Literal("task")]),
  identity: nullableText,
  spawnable: strings,
  autoExit: Type.Boolean(),
  interactive: Type.Boolean(),
  cwd: Type.String({ minLength: 1 }),
  agentDir: Type.String({ minLength: 1 }),
  skills: Type.Array(Type.Object({ name: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) })),
  isolation: Type.Object({ skills: Type.Boolean(), promptTemplates: Type.Boolean(), contextFiles: Type.Boolean() }),
  source: Type.Object({ kind: Type.Union([Type.Literal("project"), Type.Literal("global"), Type.Literal("package"), Type.Literal("legacy")]), path: nullableText, root: Type.String({ minLength: 1 }) }),
  sessionMode: Type.Union([Type.Literal("standalone"), Type.Literal("lineage-only"), Type.Literal("fork")]),
});

/** Actual resolved launch inputs; never a request to rediscover parent defaults. */
export type SubagentLoadout = Static<typeof schema>;

function resource(path: string, directory = false): void {
  if (!isAbsolute(path)) throw new Error(`Loadout resource must be absolute: ${path}`);
  accessSync(path, constants.R_OK);
  if (directory ? !statSync(path).isDirectory() : !statSync(path).isFile()) {
    throw new Error(`Unavailable loadout resource: ${path}`);
  }
}

export function validateLoadout(value: unknown): SubagentLoadout {
  if (!Value.Check(schema, value)) throw new Error("Invalid or unsupported loadout snapshot; delegate a fresh named role");
  const loadout = value;
  const tools = loadout.toolAllowlist.split(",");
  if (!tools.includes("ask_question") || tools.some((tool) => !/^[a-zA-Z0-9_-]+$/.test(tool))) {
    throw new Error("Invalid loadout tool allowlist");
  }
  if (!loadout.model.includes("/")) throw new Error("Loadout model must include its provider");
  if (loadout.spawnable.some((name) => !name.trim() || name === loadout.agent)) throw new Error("Invalid delegation policy");
  for (const tool of SPAWNING_TOOLS) {
    // Old validated snapshots remain pinned; do not silently add a new capability.
    if (tool === "subagent_status" && !tools.includes(tool)) continue;
    if (tools.includes(tool) !== (loadout.spawnable.length > 0)) throw new Error("Loadout delegation grant does not match its tools");
  }
  for (const tool of tools) {
    if (!BUILTIN_TOOLS.has(tool) && !Object.hasOwn(loadout.extensions, tool)) throw new Error(`Missing pinned extension for tool: ${tool}`);
  }
  for (const [tool, path] of Object.entries(loadout.extensions)) {
    if (!tools.includes(tool) || BUILTIN_TOOLS.has(tool)) throw new Error(`Unapproved loadout extension: ${tool}`);
    resource(path);
  }
  resource(loadout.cwd, true);
  resource(loadout.agentDir, true);
  for (const skill of loadout.skills) resource(skill.path);
  return loadout;
}

/** Only restrictive legacy records with fully pinned core inputs can migrate.
 * Legacy custom extensions, spawning grants, or inherited defaults cannot be verified.
 */
export function readCompatibleLoadout(value: any, controlExtension: string): SubagentLoadout {
  if (value?.version !== undefined) return validateLoadout(value);
  const fields = ["agent", "toolAllowlist", "model", "thinking", "systemPromptMode", "identity", "spawnable", "autoExit", "cwd", "agentDir"];
  if (!value || !fields.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !fields.includes(key)) || typeof value.toolAllowlist !== "string" ||
      value.toolAllowlist.split(",").some((tool: string) => !BUILTIN_TOOLS.has(tool) && tool !== "ask_question") ||
      (value.spawnable !== null && (!Array.isArray(value.spawnable) || value.spawnable.length !== 0)) ||
      (value.systemPromptMode !== null && value.systemPromptMode !== "append" && value.systemPromptMode !== "replace")) {
    throw new Error("Legacy loadout cannot be verified; delegate a fresh named role");
  }
  return validateLoadout({
    ...value, version: 1, toolAllowlist: [...new Set([...value.toolAllowlist.split(","), "ask_question"])].join(","),
    extensions: { ask_question: controlExtension }, spawnable: [],
    systemPromptMode: value.systemPromptMode ?? "task", interactive: !value.autoExit,
    skills: [], isolation: { skills: true, promptTemplates: true, contextFiles: true },
    source: { kind: "legacy", path: null, root: value.agentDir }, sessionMode: "standalone",
  });
}
