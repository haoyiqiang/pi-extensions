/**
 * workflow-json-schema.test.ts — the validator behind `agent({ schema })`.
 *
 * Uses real validation and catalogs: this decides whether a script-supplied
 * JSON Schema is usable and whether a child's payload matches it. The most
 * important thing it pins is *which* typebox — the repo has both packages
 * installed and only one of them can do this.
 */

import { readFileSync } from "node:fs";
import { Errors } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";

// The shared i18n entry may include TUI utilities, but must not load sessions or models.
vi.mock("@earendil-works/pi-coding-agent", () => {
  throw new Error("JSON Schema validation must not load the Pi agent runtime");
});

beforeEach(() => vi.stubEnv("PI_EXTENSIONS_LOCALE", "en-US"));
afterEach(() => vi.unstubAllEnvs());

/** A schema shaped like the one Claude Code's own example passes. */
const FINDINGS = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { file: { type: "string" }, line: { type: "integer", minimum: 1 } },
        required: ["file"],
      },
    },
  },
  required: ["findings"],
} as const;

const compile = (schema: unknown) => {
  const result = compileJsonSchema(schema);
  if (!result.ok) throw new Error(`expected a compiled schema, got: ${result.message}`);
  return result.compiled;
};

describe("compiling a script-supplied schema", () => {
  it("accepts a plain JSON Schema, with no TypeBox ceremony", () => {
    // The whole feature rests on this: `@sinclair/typebox` throws `Unknown
    // type` on a schema with no Kind symbol, so if this ever regresses to that
    // package every schema call dies at the first validation.
    expect(compileJsonSchema(FINDINGS).ok).toBe(true);
  });

  it("keeps the schema object as given, for the tool and the journal key", () => {
    expect(compile(FINDINGS).schema).toBe(FINDINGS);
  });

  it("refuses anything that cannot be a tool's input schema", () => {
    for (const bad of [5, "x", null, undefined, [], { type: "array" }, { type: "string" }]) {
      const result = compileJsonSchema(bad);
      expect(result.ok, `${JSON.stringify(bad)} should not compile`).toBe(false);
    }
  });

  it("says why a non-object root is refused", () => {
    const result = compileJsonSchema({ type: "array" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/type: "object"/);
  });

  it("refuses a schema too large to be worth sending", () => {
    const huge = { type: "object", properties: { a: { type: "string", description: "x".repeat(70_000) } } };
    const result = compileJsonSchema(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/too large/);
  });

  it("refuses schemas that cannot be serialized without throwing", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    for (const schema of [cyclic, { type: "object", default: 1n }]) {
      expect(compileJsonSchema(schema)).toEqual({ ok: false, message: i18n.t("jsonSchema.serializableRequired") });
    }
  });

  it("refuses a schema it cannot walk, rather than failing at the first call", () => {
    const result = compileJsonSchema({ type: "object", properties: { a: { type: "nonsense" } } });
    // Either rejected here or provably checkable — what must not happen is a
    // compile that succeeds and then throws inside a child's tool handler.
    if (result.ok) expect(() => result.compiled.check({ a: 1 })).not.toThrow();
    else expect(result.message).toMatch(/agent\(\) opts\.schema/);
  });
});

describe("checking a payload", () => {
  it("passes a conforming value", () => {
    expect(compile(FINDINGS).check({ findings: [{ file: "a.ts", line: 3 }] })).toBe(true);
  });

  it("passes when an optional field is absent", () => {
    expect(compile(FINDINGS).check({ findings: [{ file: "a.ts" }] })).toBe(true);
  });

  it("names the missing property at the root", () => {
    const message = compile(FINDINGS).check({});
    expect(message).not.toBe(true);
    expect(message).toMatch(/findings/);
    expect(message).toContain("$:");
  });

  it("names the offending path in JavaScript notation, not JSON Pointer", () => {
    // The model wrote the schema in JavaScript; `$.findings.0.line` is legible
    // to it in a way `/findings/0/line` is not.
    const message = compile(FINDINGS).check({ findings: [{ file: "a.ts", line: 0 }] });
    expect(message).not.toBe(true);
    expect(message).toContain("$.findings.0.line");
    expect(message).not.toContain("/findings/");
  });

  it("names every missing property, so one retry can fix them all", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      required: ["a", "b", "c"],
    };
    const message = String(compile(schema).check({}));
    for (const missing of ["a", "b", "c"]) expect(message).toContain(missing);
  });

  it("reports distinct problems separately, each with its own path", () => {
    const schema = {
      type: "object",
      properties: { n: { type: "integer", minimum: 1 }, s: { type: "string" } },
      required: ["s"],
    };
    const message = String(compile(schema).check({ n: 0 }));
    // A missing property at the root and a bad value below it are two different
    // things to fix; collapsing them would hide one behind the other.
    expect(message).toContain("$: ");
    expect(message).toContain("$.n: ");
    expect(message.split("; ")).toHaveLength(2);
  });

  it("rejects a value of the wrong type entirely", () => {
    expect(compile(FINDINGS).check("not an object")).not.toBe(true);
    expect(compile(FINDINGS).check(null)).not.toBe(true);
  });

  it("bounds diagnostics to five errors without accepting the invalid value", () => {
    const properties = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`n${index}`, { type: "number" }]));
    const value = Object.fromEntries(Object.keys(properties).map((name) => [name, "wrong"]));
    const verdict = compile({ type: "object", properties }).check(value);
    expect(verdict).not.toBe(true);
    expect(String(verdict).split("; ")).toHaveLength(5);
  });

  it("never throws, whatever it is handed", () => {
    const compiled = compile(FINDINGS);
    const cyclic: Record<string, unknown> = { findings: [] };
    cyclic.self = cyclic;
    for (const value of [undefined, Number.NaN, cyclic, new Map(), Symbol("s")]) {
      expect(() => compiled.check(value)).not.toThrow();
    }
  });
});

describe("localized schema diagnostics", () => {
  it.each(["en-US", "zh-CN"])("localizes compilation and validation failures in %s", (locale) => {
    vi.stubEnv("PI_EXTENSIONS_LOCALE", locale);
    expect(compileJsonSchema(null)).toEqual({ ok: false, message: i18n.t("jsonSchema.objectRequired") });
    expect(compileJsonSchema({ type: "array" }))
      .toEqual({ ok: false, message: i18n.t("jsonSchema.objectRootRequired") });
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    expect(compileJsonSchema(cyclic)).toEqual({ ok: false, message: i18n.t("jsonSchema.serializableRequired") });
    const huge = { type: "object", description: "x".repeat(70_000) };
    expect(compileJsonSchema(huge)).toEqual({
      ok: false,
      message: i18n.t("jsonSchema.tooLarge", { size: JSON.stringify(huge).length, limit: 64 * 1024 }),
    });

    const uncheckable = {
      type: "object",
      toJSON: () => ({ type: "object" }),
      get properties(): never { throw new Error("broken schema"); },
    };
    expect(compileJsonSchema(uncheckable)).toEqual({
      ok: false,
      message: i18n.t("jsonSchema.unsupported", { error: "broken schema" }),
    });
    const throwingValue = { get findings(): never { throw new Error("broken value"); } };
    expect(compile(FINDINGS).check(throwingValue))
      .toBe(i18n.t("jsonSchema.validationFailed", { error: "broken value" }));

    const compiled = compile(JSON.parse(JSON.stringify(FINDINGS)));
    expect(compiled.check({})).toBe(i18n.t("jsonSchema.atPath", {
      path: "$",
      error: i18n.t("jsonSchema.validation.required", { requiredProperties: "findings" }),
    }));
    expect(compiled.check({ findings: [{ line: 0 }] })).toContain("$.findings.0.line");
    expect(compiled.check({ findings: [{ file: "good.ts", line: 2 }] })).toBe(true);
  });

  const invalidCases: Array<{ name: string; schema: Record<string, unknown>; value: unknown }> = [
    { name: "additionalProperties", schema: { additionalProperties: false }, value: { extra: 1 } },
    { name: "anyOf", schema: { properties: { x: { anyOf: [{ type: "string" }, { type: "boolean" }] } } }, value: { x: 1 } },
    { name: "boolean", schema: { properties: { x: false } }, value: { x: 1 } },
    { name: "const", schema: { properties: { x: { const: "yes" } } }, value: { x: "no" } },
    { name: "contains", schema: { properties: { x: { type: "array", contains: { type: "number" } } } }, value: { x: ["no"] } },
    { name: "dependencies", schema: { dependencies: { x: ["y"] } }, value: { x: 1 } },
    { name: "dependentRequired", schema: { dependentRequired: { x: ["y"] } }, value: { x: 1 } },
    { name: "enum", schema: { properties: { x: { enum: ["yes", "maybe"] } } }, value: { x: "no" } },
    { name: "exclusiveMaximum", schema: { properties: { x: { type: "number", exclusiveMaximum: 3 } } }, value: { x: 3 } },
    { name: "exclusiveMinimum", schema: { properties: { x: { type: "number", exclusiveMinimum: 3 } } }, value: { x: 3 } },
    { name: "if", schema: { if: { required: ["x"] }, then: { required: ["y"] } }, value: { x: 1 } },
    { name: "maximum", schema: { properties: { x: { type: "number", maximum: 3 } } }, value: { x: 4 } },
    { name: "minimum", schema: { properties: { x: { type: "number", minimum: 3 } } }, value: { x: 2 } },
    { name: "maxItems", schema: { properties: { x: { type: "array", maxItems: 1 } } }, value: { x: [1, 2] } },
    { name: "minItems", schema: { properties: { x: { type: "array", minItems: 1 } } }, value: { x: [] } },
    { name: "maxLength", schema: { properties: { x: { type: "string", maxLength: 1 } } }, value: { x: "ab" } },
    { name: "minLength", schema: { properties: { x: { type: "string", minLength: 2 } } }, value: { x: "a" } },
    { name: "maxProperties", schema: { maxProperties: 0 }, value: { x: 1 } },
    { name: "minProperties", schema: { minProperties: 1 }, value: {} },
    { name: "multipleOf", schema: { properties: { x: { type: "number", multipleOf: 3 } } }, value: { x: 2 } },
    { name: "not", schema: { not: { required: ["x"] } }, value: { x: 1 } },
    { name: "oneOf", schema: { properties: { x: { oneOf: [{ type: "number" }, { minimum: 0 }] } } }, value: { x: 1 } },
    { name: "pattern", schema: { properties: { x: { type: "string", pattern: "^yes$" } } }, value: { x: "no" } },
    { name: "propertyNames", schema: { propertyNames: { pattern: "^yes$" } }, value: { no: 1 } },
    { name: "required", schema: { required: ["x"] }, value: {} },
    { name: "type", schema: { properties: { x: { type: "string" } } }, value: { x: 1 } },
    { name: "type union", schema: { properties: { x: { type: ["string", "boolean"] } } }, value: { x: 1 } },
    { name: "unevaluatedItems", schema: { properties: { x: { type: "array", prefixItems: [{ type: "number" }], unevaluatedItems: false } } }, value: { x: [1, 2] } },
    { name: "unevaluatedProperties", schema: { unevaluatedProperties: false }, value: { x: 1 } },
    { name: "uniqueItems", schema: { properties: { x: { type: "array", uniqueItems: true } } }, value: { x: [1, 1] } },
  ];

  it.each(invalidCases)("localizes $name without changing TypeBox's verdict or global messages", ({ schema, value }) => {
    const root = { type: "object", ...schema };
    const compiled = compile(root);
    const errors = Errors(root, value);
    expect(errors.length).toBeGreaterThan(0);
    const original = errors.map((error) => error.message);
    const expected = errors.slice(0, 5).map((error) => {
      const where = error.instancePath === "" ? "$" : `$${error.instancePath.replace(/\//g, ".")}`;
      return `${where}: ${error.message}`;
    }).join("; ");
    expect(compiled.check(value)).toBe(expected);

    vi.stubEnv("PI_EXTENSIONS_LOCALE", "zh-CN");
    const translated = compiled.check(value);
    expect(translated).not.toBe(true);
    expect(translated).toMatch(/[\u3400-\u9fff]/u);
    expect(translated).not.toContain("jsonSchema.");
    expect(Errors(root, value).map((error) => error.message)).toEqual(original);
  });

  it("keeps both flat catalogs complete, including terminal policy messages", () => {
    const en = JSON.parse(readFileSync(new URL("../locales/en-US.json", import.meta.url), "utf8"));
    const zh = JSON.parse(readFileSync(new URL("../locales/zh-CN.json", import.meta.url), "utf8"));
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const [key, text] of Object.entries(en)) {
      expect(typeof text).toBe("string");
      expect(typeof zh[key]).toBe("string");
      expect(String(zh[key]).match(/\{[A-Za-z0-9_]+\}/g)?.sort() ?? [])
        .toEqual(String(text).match(/\{[A-Za-z0-9_]+\}/g)?.sort() ?? []);
    }
    for (const key of ["wrapUp", "turnLimit", "invalidSchema", "invalidResult"]) {
      expect(en[`terminalPolicy.${key}`]).toBeTruthy();
      expect(zh[`terminalPolicy.${key}`]).toMatch(/[\u3400-\u9fff]/u);
    }
  });
});
