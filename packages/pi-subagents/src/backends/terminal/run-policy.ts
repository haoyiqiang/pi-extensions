import type { BoundaryResult } from "@earendil-works/pi-coding-agent";
import { i18n } from "../../i18n.js";
import { compileJsonSchema, type CompiledSchema } from "../../workflow/json-schema.js";

/** JSON-only policy: validators/closures never cross the process boundary. */
export function compileTerminalSchema(schema: unknown): CompiledSchema {
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(schema, (_key, value) => {
      if (value === undefined || typeof value === "function" || typeof value === "symbol"
        || (typeof value === "number" && !Number.isFinite(value))) throw new Error();
      return value;
    }));
  } catch {
    throw new Error(i18n.t("terminalPolicy.invalidSchema", { error: i18n.t("terminalBackend.invalidConfig") }));
  }
  const result = compileJsonSchema(copy);
  if (!result.ok) throw new Error(i18n.t("terminalPolicy.invalidSchema", { error: result.message }));
  freezeJson(result.compiled.schema);
  return result.compiled;
}

function freezeJson(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

export function validTurnBudget(maxTurns: unknown, graceTurns: unknown): boolean {
  if (maxTurns === undefined) return graceTurns === undefined;
  return typeof maxTurns === "number" && Number.isFinite(maxTurns) && maxTurns >= 1
    && typeof graceTurns === "number" && Number.isFinite(graceTurns) && graceTurns >= 1
    && maxTurns + graceTurns <= Number.MAX_SAFE_INTEGER;
}

/** A bounded continuation rather than a concurrent session.prompt() from an event handler. */
export function policyContinuation(content: string): BoundaryResult {
  return {
    entries: [{ type: "custom_message", customType: "pi-subagents-policy", content, display: false }],
    continue: true,
  };
}
