import { i18n } from "../i18n.js";

const MAX_REQUIRED_TOOLS = 256;
const MAX_TOOL_NAME_LENGTH = 256;
const INVALID_NAME_CHARACTERS = /[\s\p{Cc}\p{Cf}*?\[\]{}]/u;

/** Invocation preconditions only: exact active names, never tool selectors or grants. */
export function snapshotRequiredTools(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const invalid: () => never = () => { throw new Error(i18n.t("toolRequirements.invalid", {
    maxTools: MAX_REQUIRED_TOOLS, maxNameLength: MAX_TOOL_NAME_LENGTH,
  })); };
  if (!Array.isArray(value) || value.length > MAX_REQUIRED_TOOLS) invalid();
  const names = new Set<string>();
  // Index the bounded array rather than trusting a caller-supplied iterator.
  const length = value.length;
  for (let index = 0; index < length; index++) {
    const name: unknown = value[index];
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH
      || INVALID_NAME_CHARACTERS.test(name)) invalid();
    names.add(name);
  }
  return Object.freeze([...names]);
}

/** Check only the invocation's requirements; do not resolve or alter agent defaults. */
export function assertRequiredTools(required: readonly string[] | undefined, available: Iterable<string>): void {
  const names = snapshotRequiredTools(required);
  if (!names?.length) return;
  const active = new Set(available);
  const missing = names.filter(name => !active.has(name));
  if (missing.length) throw new Error(i18n.t("toolRequirements.missing", { tools: missing.join(", ") }));
}
