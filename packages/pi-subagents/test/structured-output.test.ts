/**
 * structured-output.test.ts — the synthetic tool behind `agent({ schema })`.
 *
 * The contract this pins: the caller's schema reaches the provider verbatim,
 * a bad payload becomes Pi's native failed tool result rather than being silently accepted, and the box
 * says enough afterwards to tell "never answered" from "answered wrongly".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.js";
import {
  createStructuredCapture,
  createStructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
  structuredFailure,
  structuredRetryPrompt,
} from "../src/structured-output.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";

beforeEach(() => vi.stubEnv("PI_EXTENSIONS_LOCALE", "en-US"));
afterEach(() => vi.unstubAllEnvs());

const SCHEMA = {
  type: "object",
  properties: { file: { type: "string" }, line: { type: "integer", minimum: 1 } },
  required: ["file"],
};

function build() {
  const compilation = compileJsonSchema(SCHEMA);
  if (!compilation.ok) throw new Error(compilation.message);
  const capture = createStructuredCapture();
  return { tool: createStructuredOutputTool(compilation.compiled, capture), capture };
}

const call = (tool: ReturnType<typeof build>["tool"], params: unknown) =>
  (tool as unknown as {
    execute(id: string, params: unknown): Promise<{ content: { text: string }[] }>;
  }).execute("tc-1", params);

describe("the StructuredOutput tool", () => {
  it("carries Claude Code's name, so a ported prompt stays true", () => {
    expect(STRUCTURED_OUTPUT_TOOL_NAME).toBe("StructuredOutput");
    expect(build().tool.name).toBe("StructuredOutput");
  });

  it("uses the caller's schema as its own parameters, verbatim", () => {
    // This is what makes the provider fill the fields; a copy or a conversion
    // would be a second place for the shape to drift.
    expect(build().tool.parameters).toBe(SCHEMA);
  });

  it("asks the provider to constrain sampling, but does not require it", () => {
    // "require" would fail the call outright on a provider that cannot do it,
    // where we would rather fall through to validate-and-retry.
    expect(build().tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });

  it("captures a conforming payload as canonical JSON", async () => {
    const { tool, capture } = build();
    const result = await call(tool, { file: "a.ts", line: 3 });

    expect(result.content[0].text).toBe("Recorded.");
    expect(capture.called).toBe(true);
    expect(JSON.parse(capture.json as string)).toEqual({ file: "a.ts", line: 3 });
    expect(capture.lastError).toBeUndefined();
  });

  it("throws a native tool error for a bad payload, so the model can correct itself", async () => {
    const { tool, capture } = build();

    await expect(call(tool, { line: 0 })).rejects.toThrow(/did not match the required schema[\s\S]*file/);
    // The reason has to reach the model, or the retry is a guess.
    expect(capture.json).toBeUndefined();
    expect(capture.called).toBe(true);
    expect(capture.lastError).toBeDefined();
  });

  it("lets a corrected second call win", async () => {
    const { tool, capture } = build();
    await expect(call(tool, { line: 0 })).rejects.toThrow(/did not match/);
    await call(tool, { file: "a.ts" });

    expect(JSON.parse(capture.json as string)).toEqual({ file: "a.ts" });
    // Cleared, or the retry prompt would report a problem already fixed.
    expect(capture.lastError).toBeUndefined();
  });

  it("takes the last valid call when a model answers twice", async () => {
    const { tool, capture } = build();
    await call(tool, { file: "first.ts" });
    await call(tool, { file: "second.ts" });

    expect(JSON.parse(capture.json as string)).toEqual({ file: "second.ts" });
  });

  it("preserves a valid capture when a later call fails", async () => {
    const { tool, capture } = build();
    await call(tool, { file: "valid.ts" });
    await expect(call(tool, { line: 0 })).rejects.toThrow();

    expect(JSON.parse(capture.json as string)).toEqual({ file: "valid.ts" });
    expect(capture.lastError).toBeDefined();
    expect(structuredFailure(capture)).toBeUndefined();
  });

  it("recovers a payload sent as a JSON string", async () => {
    // A common model slip; parsing it here saves a whole retry.
    const { tool, capture } = build();
    const prepared = tool.prepareArguments?.(JSON.stringify({ file: "a.ts" }));
    await call(tool, prepared);

    expect(JSON.parse(capture.json as string)).toEqual({ file: "a.ts" });
  });

  it("leaves an unparseable string alone for validation to reject", async () => {
    const { tool } = build();
    expect(tool.prepareArguments?.("not json at all")).toBe("not json at all");
  });
});

describe("the structured failure", () => {
  it("reports missing output separately from a rejected call", () => {
    expect(structuredFailure(createStructuredCapture()))
      .toBe("The agent did not report its answer through StructuredOutput.");
    expect(structuredFailure({ called: true, lastError: "$.file: must be string" }))
      .toBe("The agent's StructuredOutput call did not match the required schema: $.file: must be string");
  });

  it("succeeds only when JSON has been captured, not merely when a tool was called", () => {
    expect(structuredFailure({ called: true })).toBeDefined();
    expect(structuredFailure({ called: true, json: "{}" })).toBeUndefined();
  });
});

describe("bilingual structured-output helpers", () => {
  it.each(["en-US", "zh-CN"])("uses the %s catalog for every tool-facing surface", async (locale) => {
    vi.stubEnv("PI_EXTENSIONS_LOCALE", locale);
    const { tool, capture } = build();
    const params = { tool: STRUCTURED_OUTPUT_TOOL_NAME };
    expect(tool.label).toBe(locale === "en-US" ? "Structured Output" : "结构化输出");
    expect(tool.description).toBe(i18n.t("structuredOutput.description"));
    expect(tool.promptSnippet).toBe(i18n.t("structuredOutput.snippet"));
    expect(tool.promptGuidelines).toEqual([i18n.t("structuredOutput.guideline", params)]);

    const missing = i18n.t("structuredOutput.retryMissing", params);
    expect(structuredRetryPrompt(capture)).toBe(i18n.t("structuredOutput.retry", { ...params, reason: missing }));
    expect(structuredFailure(capture)).toBe(i18n.t("structuredOutput.failureMissing", params));

    const rejected = await call(tool, { line: 0 }).catch((error: Error) => error);
    expect(rejected).toBeInstanceOf(Error);
    const invalid = { ...params, error: capture.lastError! };
    expect((rejected as Error).message).toBe(i18n.t("structuredOutput.invalid", invalid));
    expect(structuredRetryPrompt(capture)).toBe(i18n.t("structuredOutput.retry", {
      ...params,
      reason: i18n.t("structuredOutput.retryInvalid", invalid),
    }));
    expect(structuredFailure(capture)).toBe(i18n.t("structuredOutput.failureInvalid", invalid));

    const result = await call(tool, { file: "fixed.ts" });
    expect(result.content[0].text).toBe(locale === "en-US" ? "Recorded." : "已记录。");
    expect(capture.lastError).toBeUndefined();
    expect(structuredFailure(capture)).toBeUndefined();
  });
});

describe("the retry prompt", () => {
  it("distinguishes never answering from answering wrongly", () => {
    const silent = createStructuredCapture();
    expect(structuredRetryPrompt(silent)).toMatch(/did not call/i);

    const wrong = { called: true, lastError: "$: must have required properties file" };
    const prompt = structuredRetryPrompt(wrong);
    expect(prompt).toMatch(/did not match the required schema/);
    // Telling a model it got the shape wrong when it never answered would send
    // it hunting for a mistake it did not make.
    expect(prompt).not.toMatch(/did not call/i);
    expect(prompt).toContain("must have required properties file");
  });

  it("always ends by asking for the call", () => {
    for (const capture of [createStructuredCapture(), { called: true, lastError: "x" }]) {
      expect(structuredRetryPrompt(capture)).toMatch(/Call StructuredOutput now/);
    }
  });
});
