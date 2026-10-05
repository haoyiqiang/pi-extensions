import { isAbsolute } from "node:path";
import type { PersistentSessionReference } from "../backends/session-reference.js";
import { snapshotRequiredTools } from "../backends/tool-requirements.js";
import { i18n } from "../i18n.js";

export const MAX_PREPARED_PROMPT_BYTES = 512 * 1024;
export const MAX_PROMPT_RESOURCES = 64;

export interface WorkflowPromptResource {
  readonly kind: "skill";
  readonly name: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly sha256: string;
  readonly format: "pi" | "positional-v1";
}

export interface PreparedWorkflowPrompt {
  readonly text: string;
  /** Minimum required tools, never a request to enable tools or change saved policy. */
  readonly requiredTools?: readonly string[];
  readonly resources?: readonly WorkflowPromptResource[];
}

export interface WorkflowPromptPreparationContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** Undefined for fresh creation. Never substitute the launcher/record ID for an unknown child ID. */
  readonly session?: PersistentSessionReference;
}

/** Explicit owner-supplied preparation; no discovery, extension hooks, shell or network is implied.
 * Callable metadata never binds a host implicitly: the owner must also pass promptBinding.
 */
export type WorkflowPromptPreparer = (
  input: string,
  context: WorkflowPromptPreparationContext,
) => PreparedWorkflowPrompt | Promise<PreparedWorkflowPrompt>;

/** Snapshot before passing prepared data to any asynchronous backend preparation. */
export function snapshotPreparedPrompt(value: PreparedWorkflowPrompt): PreparedWorkflowPrompt {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalidPreparation");
  const { text, requiredTools: tools, resources } = value;
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > MAX_PREPARED_PROMPT_BYTES) fail("invalidPreparation");
  if (text.trimStart().startsWith("/")) fail("unexpandedCommand");
  const requiredTools = snapshotRequiredTools(tools);
  let frozen: WorkflowPromptResource[] | undefined;
  if (resources !== undefined) {
    if (!Array.isArray(resources)) fail("invalidPreparation");
    const count = resources.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_PROMPT_RESOURCES) fail("invalidPreparation");
    frozen = [];
    // Indexed bounds do not invoke a caller-controlled array iterator or skip sparse entries.
    for (let index = 0; index < count; index++) {
      const resource = resources[index];
      if (!resource || typeof resource !== "object" || Array.isArray(resource)) fail("invalidPreparation");
      const { kind, name, filePath, baseDir, sha256, format } = resource;
      if (kind !== "skill" || typeof name !== "string" || !validSkillName(name)
        || !validPath(filePath) || !validPath(baseDir) || typeof sha256 !== "string" || sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(sha256)
        || (format !== "pi" && format !== "positional-v1")) fail("invalidPreparation");
      frozen.push(Object.freeze({ kind, name, filePath, baseDir, sha256, format }));
    }
  }
  return Object.freeze({ text,
    ...(requiredTools !== undefined ? { requiredTools } : {}),
    ...(frozen !== undefined ? { resources: Object.freeze(frozen) } : {}),
  });
}

export function validSkillName(name: string): boolean {
  return name.length <= 64 && name.trim() === name && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function validPath(path: unknown): path is string {
  return typeof path === "string" && isAbsolute(path) && !/[\u0000-\u001f\u007f]/.test(path);
}

function fail(key: string): never {
  throw new Error(i18n.t(`workflowResources.${key}`));
}
