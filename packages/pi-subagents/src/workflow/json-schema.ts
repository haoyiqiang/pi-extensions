/**
 * json-schema.ts — validating a script-supplied JSON Schema.
 *
 * `agent(prompt, { schema })` hands us a raw JSON Schema written by a model, to
 * be used two ways: as a tool's `parameters` (so the provider fills the fields)
 * and as the check that decides whether what came back is usable.
 *
 * ## Which typebox
 *
 * **`typebox`, not `@sinclair/typebox`.** They are different packages and both
 * are installed here. `@sinclair/typebox` (0.34) dispatches on a `Kind` symbol
 * that a schema arriving over the wire does not carry, so `Value.Check` throws
 * `Unknown type` on a plain JSON Schema — and `Type.Unsafe` does not help, it
 * stamps a `Kind` that is not registered. `typebox` v1 is a standards JSON
 * Schema validator and takes the schema as-is. It is also the package pi itself
 * types `ToolDefinition.parameters` against, so the same schema object serves
 * both roles with no conversion.
 *
 * ## Why we validate at all
 *
 * Nothing in pi checks a tool call's arguments against the tool's `parameters`.
 * `validateToolCall`/`validateToolArguments` exist in `pi-ai` but are never
 * called from either shipped package, so a schema on a tool is a *prompt to the
 * provider*, not an enforcement point. Every guarantee the script gets about
 * the shape of its result is made here.
 *
 * Uses the shared locale catalog, but no Pi session/model runtime, so
 * `runtime.ts` can validate serialized schemas without starting an agent.
 */

import type { TLocalizedValidationError, TValidationError } from "typebox/error";
import { Check, Errors } from "typebox/value";
import { i18n } from "../i18n.js";

/** Largest schema we will accept, serialized. */
const MAX_SCHEMA_BYTES = 64 * 1024;

/** How many validation errors are quoted back to the model. */
const MAX_REPORTED_ERRORS = 5;

export interface CompiledSchema {
  /** The schema as given, for the tool's `parameters` and the journal key. */
  readonly schema: Record<string, unknown>;
  /** `true`, or a human-readable account of what is wrong. */
  check(value: unknown): true | string;
}

export type SchemaCompilation =
  | { ok: true; compiled: CompiledSchema }
  | { ok: false; message: string };

/**
 * Turn a script-supplied schema into something we can check against.
 *
 * Rejects up front rather than at the first tool call. A schema whose root is
 * not an object cannot be a tool's input schema at all, so it would break every
 * request the child makes rather than just the last one — and the author should
 * hear about that before a model is paid to discover it.
 */
export function compileJsonSchema(schema: unknown): SchemaCompilation {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { ok: false, message: i18n.t("jsonSchema.objectRequired") };
  }
  const root = schema as Record<string, unknown>;
  if (root.type !== "object") {
    return {
      ok: false,
      message: i18n.t("jsonSchema.objectRootRequired"),
    };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(root);
  } catch {
    return { ok: false, message: i18n.t("jsonSchema.serializableRequired") };
  }
  if (serialized.length > MAX_SCHEMA_BYTES) {
    return {
      ok: false,
      message: i18n.t("jsonSchema.tooLarge", { size: serialized.length, limit: MAX_SCHEMA_BYTES }),
    };
  }

  // Smoke-tested here so a schema the validator cannot walk fails at the call
  // that wrote it, with the schema in hand, rather than inside a child's tool
  // handler where the only symptom is an agent that never returns.
  try {
    Check(root, {});
  } catch (error) {
    return {
      ok: false,
      message: i18n.t("jsonSchema.unsupported", {
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  return { ok: true, compiled: { schema: root, check: value => checkAgainst(root, value) } };
}

function checkAgainst(schema: Record<string, unknown>, value: unknown): true | string {
  let valid: boolean;
  try {
    valid = Check(schema, value);
  } catch (error) {
    // Reported rather than thrown: a schema that compiled but trips on a
    // particular value must fail that call, not the run.
    return i18n.t("jsonSchema.validationFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (valid) return true;

  const reported: string[] = [];
  try {
    for (const error of Errors(schema, value)) {
      // `instancePath` is JSON Pointer (`/a/b`); the model wrote the schema in
      // JavaScript, so it reads `$.a.b` far more easily.
      const path = String(error.instancePath ?? "");
      const where = path === "" ? "$" : `$${path.replace(/\//g, ".")}`;
      reported.push(i18n.t("jsonSchema.atPath", { path: where, error: validationMessage(error) }));
      if (reported.length >= MAX_REPORTED_ERRORS) break;
    }
  } catch {
    // Errors() can trip where Check() merely returned false. A vaguer message
    // still names the right problem.
  }
  return reported.length > 0 ? reported.join("; ") : i18n.t("jsonSchema.mismatch");
}

// Format TypeBox diagnostics locally; changing its global locale would affect
// unrelated validators in the parent or child process.
const VALIDATION_KEYS: Record<TValidationError["keyword"], string> = {
  additionalProperties: "jsonSchema.validation.additionalProperties",
  anyOf: "jsonSchema.validation.anyOf",
  boolean: "jsonSchema.validation.boolean",
  const: "jsonSchema.validation.const",
  contains: "jsonSchema.validation.contains",
  dependencies: "jsonSchema.validation.dependencies",
  dependentRequired: "jsonSchema.validation.dependencies",
  enum: "jsonSchema.validation.enum",
  exclusiveMaximum: "jsonSchema.validation.comparison",
  exclusiveMinimum: "jsonSchema.validation.comparison",
  format: "jsonSchema.validation.format",
  if: "jsonSchema.validation.if",
  maximum: "jsonSchema.validation.comparison",
  maxItems: "jsonSchema.validation.maxItems",
  maxLength: "jsonSchema.validation.maxLength",
  maxProperties: "jsonSchema.validation.maxProperties",
  minimum: "jsonSchema.validation.comparison",
  minItems: "jsonSchema.validation.minItems",
  minLength: "jsonSchema.validation.minLength",
  minProperties: "jsonSchema.validation.minProperties",
  multipleOf: "jsonSchema.validation.multipleOf",
  not: "jsonSchema.validation.not",
  oneOf: "jsonSchema.validation.oneOf",
  pattern: "jsonSchema.validation.pattern",
  propertyNames: "jsonSchema.validation.propertyNames",
  "~refine": "jsonSchema.validation.refine",
  required: "jsonSchema.validation.required",
  type: "jsonSchema.validation.type",
  unevaluatedItems: "jsonSchema.validation.unevaluatedItems",
  unevaluatedProperties: "jsonSchema.validation.unevaluatedProperties",
  uniqueItems: "jsonSchema.validation.uniqueItems",
};

function validationMessage(error: TLocalizedValidationError): string {
  if (error.keyword === "type" && Array.isArray(error.params.type)) {
    return i18n.t("jsonSchema.validation.typeUnion", {
      types: error.params.type.join(i18n.t("jsonSchema.validation.or")),
    });
  }
  const key = VALIDATION_KEYS[error.keyword];
  if (key === undefined) {
    return i18n.t("jsonSchema.validation.unknown", { error: error.message });
  }
  const params = Object.fromEntries(Object.entries(error.params).map(([name, value]) => [
    name,
    Array.isArray(value) ? value.map(String).join(", ") : String(value),
  ]));
  return i18n.t(key, params);
}
