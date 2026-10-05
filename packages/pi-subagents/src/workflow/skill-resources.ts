import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { isAbsolute } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { snapshotRequiredTools } from "../backends/tool-requirements.js";
import { snapshotPromptBinding, type PromptBinding } from "../backends/prompt-binding.js";
import { i18n } from "../i18n.js";
import { MAX_PREPARED_PROMPT_BYTES, MAX_PROMPT_RESOURCES, snapshotPreparedPrompt, validSkillName,
  type WorkflowPromptPreparer, type WorkflowPromptResource } from "./prompt-preparation.js";
import { expandWorkflowSkillArguments } from "./skill-arguments.js";

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_TOTAL_SKILL_BYTES = 2 * 1024 * 1024;

/** Bump when command parsing, wrapping or local argument semantics change. */
export const WORKFLOW_SKILL_RESOLVER_ID = "pi-subagents/workflow-skills@1";

export interface WorkflowSkillResourceSnapshot extends WorkflowPromptResource {
  readonly requiredTools: readonly string[];
}

/** Callable compatibility plus immutable identity of the complete approved set, not just one input. */
export type WorkflowSkillPreparer = WorkflowPromptPreparer & {
  readonly promptBinding: PromptBinding;
  readonly resources: readonly WorkflowSkillResourceSnapshot[];
};

export interface WorkflowSkillApproval {
  name: string;
  filePath: string;
  baseDir: string;
  format: "pi" | "positional-v1";
  requiredTools?: readonly string[];
  expectedSha256?: string;
}

interface SkillSnapshot {
  readonly resource: WorkflowPromptResource;
  readonly body: string;
  readonly requiredTools?: readonly string[];
}

function fail(key: string, params?: { name: string }): never {
  throw new Error(i18n.t(`workflowResources.${key}`, params));
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function sameIdentity(actual: BigIntStats, expected: BigIntStats): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.mode === expected.mode;
}

function sameFile(actual: BigIntStats, expected: BigIntStats): boolean {
  return actual.isFile() && sameIdentity(actual, expected) && actual.size === expected.size
    && actual.mtimeNs === expected.mtimeNs && actual.ctimeNs === expected.ctimeNs && actual.nlink === expected.nlink;
}

/** Resolve only explicitly approved paths; assets and discovery directories are never read. */
function readApprovedFile(approvedFile: string, approvedBase: string) {
  let fd: number | undefined;
  try {
    const filePath = realpathSync(approvedFile);
    const baseDir = realpathSync(approvedBase);
    if (!validPath(filePath) || !validPath(baseDir)) fail("invalidSkillFile");
    const base = lstatSync(baseDir, { bigint: true });
    const before = lstatSync(filePath, { bigint: true });
    if (!base.isDirectory() || !before.isFile() || before.size > BigInt(MAX_SKILL_BYTES)) fail("invalidSkillFile");
    // A path switched to a FIFO must not block; a final-component symlink swap must not be followed.
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!sameFile(fstatSync(fd, { bigint: true }), before)) fail("invalidSkillFile");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length !== Number(before.size) || !sameFile(fstatSync(fd, { bigint: true }), before)
      || !sameFile(lstatSync(filePath, { bigint: true }), before)
      || !sameIdentity(lstatSync(baseDir, { bigint: true }), base)
      || realpathSync(approvedFile) !== filePath || realpathSync(approvedBase) !== baseDir) fail("invalidSkillFile");
    const raw = buffer.subarray(0, length);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return { filePath, baseDir, raw, text };
  } catch {
    return fail("invalidSkillFile");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseBody(text: string, name: string): string {
  try {
    const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    // Pi's parser tolerates an unclosed header and prefix-only delimiters; approvals do not.
    if (normalized.startsWith("---")) {
      const end = normalized.indexOf("\n---", 3);
      if (!normalized.startsWith("---\n") || end < 0
        || (end + 4 !== normalized.length && normalized[end + 4] !== "\n")) fail("invalidSkillContent", { name });
    }
    const { frontmatter, body } = parseFrontmatter(normalized);
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)
      || (Object.hasOwn(frontmatter, "name") && frontmatter.name !== name)
      || !body.trim()) fail("invalidSkillContent", { name });
    return body.trim();
  } catch {
    return fail("invalidSkillContent", { name });
  }
}

function xmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

/** Construction synchronously snapshots instruction files, not their supporting assets or tool grants. */
export function createWorkflowSkillPreparer(approvals: readonly WorkflowSkillApproval[]): WorkflowSkillPreparer {
  if (!Array.isArray(approvals)) fail("invalidApproval");
  if (approvals.length > MAX_PROMPT_RESOURCES) fail("resourceLimit");
  const skills = new Map<string, SkillSnapshot>();
  let total = 0;
  const length = approvals.length;
  for (let index = 0; index < length; index++) {
    const approval = approvals[index];
    if (!approval || typeof approval !== "object") fail("invalidApproval");
    const { name, filePath: approvedFile, baseDir: approvedBase, format, expectedSha256 } = approval;
    if (typeof name !== "string" || !validSkillName(name) || name.trim() !== name || !validPath(approvedFile) || !validPath(approvedBase)
      || (format !== "pi" && format !== "positional-v1")
      || (expectedSha256 !== undefined && (typeof expectedSha256 !== "string" || expectedSha256.length !== 64
        || !/^[a-f\d]{64}$/i.test(expectedSha256)))) fail("invalidApproval");
    if (skills.has(name)) fail("duplicateSkill", { name });
    const requiredTools = snapshotRequiredTools(approval.requiredTools);
    const { filePath, baseDir, raw, text } = readApprovedFile(approvedFile, approvedBase);
    total += raw.length;
    if (total > MAX_TOTAL_SKILL_BYTES) fail("resourceLimit");
    const sha256 = createHash("sha256").update(raw).digest("hex");
    if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== sha256) fail("digestMismatch", { name });
    const body = parseBody(text, name);
    if (format === "positional-v1" && (body.includes("!`") || /`{3,}[ \t]*!/.test(body) || body.includes("${SESSION_ID}"))) {
      fail("unsupportedSkillSyntax", { name });
    }
    const resource = Object.freeze({ kind: "skill" as const, name, filePath, baseDir, sha256, format });
    skills.set(name, Object.freeze({ resource, body, requiredTools }));
  }

  // Locale-independent name/tool ordering makes approval order irrelevant to identity.
  const resources = Object.freeze([...skills.values()]
    .sort((a, b) => a.resource.name < b.resource.name ? -1 : a.resource.name > b.resource.name ? 1 : 0)
    .map(({ resource, requiredTools }) => Object.freeze({ ...resource,
      requiredTools: Object.freeze([...(requiredTools ?? [])].sort()),
    })));
  const canonical = { version: 1, resolverId: WORKFLOW_SKILL_RESOLVER_ID, assetMode: "live" as const, resources };
  const promptBinding = snapshotPromptBinding({ resolverId: canonical.resolverId, assetMode: canonical.assetMode,
    resourceSetDigest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  });
  const prepare: WorkflowPromptPreparer = (input, context) => {
    context.signal.throwIfAborted();
    if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > MAX_PREPARED_PROMPT_BYTES) fail("invalidPreparation");
    const command = input.trimStart();
    if (!command.startsWith("/")) return snapshotPreparedPrompt({ text: input });
    const match = /^\/skill:([^\s]+)(?:[ \t\r\n]+([\s\S]*))?$/.exec(command);
    if (!match || !validSkillName(match[1])) fail("unsupportedCommand");
    const skill = skills.get(match[1]);
    if (!skill) fail("unknownSkill", { name: match[1] });
    const { resource, requiredTools } = skill;
    const { name, filePath, baseDir, sha256, format } = resource;
    const args = (match[2] ?? "").trim();
    const body = format === "pi" ? skill.body : expandWorkflowSkillArguments(skill.body, args, baseDir);
    const references = i18n.t("workflowResources.skillReferences", { baseDir });
    const provenance = i18n.t("workflowResources.skillProvenance", { sha256, format });
    const block = `<skill name="${xmlAttribute(name)}" location="${xmlAttribute(filePath)}">\n${references}\n${provenance}\n\n${body}\n</skill>`;
    const suffix = !args ? "" : format === "pi" ? `\n\n${args}` : `\n\n${i18n.t("workflowResources.skillInput")}\n${args}`;
    return snapshotPreparedPrompt({ text: block + suffix, requiredTools, resources: [resource] });
  };
  return Object.freeze(Object.assign(prepare, { promptBinding, resources }));
}
