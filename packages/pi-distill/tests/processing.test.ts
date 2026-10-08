import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { extendDistillToolParameters, processToolResult } from "../src/index.ts";
import { loadDistillConfig } from "../src/summary-utils.ts";
import { processingConfig } from "../src/processing-config.ts";

type Context = Parameters<typeof processToolResult>[0];
type Result = Parameters<typeof processToolResult>[1];
type Completion = NonNullable<Parameters<typeof processToolResult>[3]>;
const body = `${"PASS routine test\n".repeat(1000)}FAIL tests/login.test.ts\nExpected: 200\nReceived: 401\nTests: 1 failed, 37 passed, 38 total\n`;
const failure = "FAIL tests/login.test.ts\nExpected: 200\nReceived: 401";
const counts = "Tests: 1 failed, 37 passed, 38 total";

async function configured<T>(action: (directory: string, configPath: string) => Promise<T>, config: Record<string, unknown> = {}): Promise<T> {
  const old = process.env.PI_CODING_AGENT_DIR;
  const locale = process.env.PI_EXTENSIONS_LOCALE;
  const directory = await mkdtemp(join(tmpdir(), "pi-distill-pipeline-"));
  const configPath = join(directory, "extensions/pi-distill/config.json");
  await mkdir(join(directory, "extensions/pi-distill"), { recursive: true });
  await writeFile(configPath, JSON.stringify({ enabled: true, model: "fake/model", minChars: 1, maxChars: 10000, maxOutputChars: 10000, timeoutSeconds: 1, errorRetryCount: 0, timeoutRetryCount: 0, summarizeErrors: true, evidence: { enabled: true, fusion: true }, ...config }));
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  try { return await action(directory, configPath); }
  finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    if (locale === undefined) delete process.env.PI_EXTENSIONS_LOCALE; else process.env.PI_EXTENSIONS_LOCALE = locale;
    await rm(directory, { recursive: true, force: true });
  }
}

function context(toolName = "bash", params: Record<string, unknown> = { command: "npm run test", outputRequest: "Keep failing assertions and totals" }): Context {
  const model = { id: "model", provider: "fake", api: "openai-completions", maxTokens: 8192, input: ["text"] };
  return {
    toolName, params, toolCallId: "pipeline-test",
    ctx: { cwd: process.cwd(), hasUI: false, mode: "print", ui: { notify() {} }, model,
      modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true }) },
      sessionManager: { getSessionId: () => "pipeline-session" },
    },
  } as unknown as Context;
}
const result = (text = body, isError = true): Result => ({ content: [{ type: "text", text }], isError, details: { sentinel: "keep" } });
const evidenceResponse = (quote = failure) => JSON.stringify({ schema: "pi-distill-evidence/v1", uncertain: false, evidence: [{ kind: "failure", quote }, { kind: "summary", quote: counts }] });
const response = (text: string): Completion => async () => ({ content: [{ type: "text", text }], stopReason: "stop", usage: { input: 100, output: 20, totalTokens: 120 } } as Awaited<ReturnType<Completion>>);
function source(output: Result): { path: string; sha256: string; lines: number; kind: string } {
  return (output.details?.distill as { source: { path: string; sha256: string; lines: number; kind: string } }).source;
}

test("diagnostics use one evidence request; archive precedes model and native read supports one-call tail", async () => {
  await configured(async (directory) => {
    let calls = 0;
    const complete: Completion = async (...args) => {
      calls++;
      const files = await readdir(join(directory, "extensions/pi-distill/artifacts"), { recursive: true });
      assert.ok(files.some((path) => path.endsWith(".txt")), "archive must exist before sending source to model");
      const prompt = JSON.stringify(args[1]);
      assert.match(prompt, /Keep failing assertions/);
      assert.match(prompt, /pi-distill-evidence\/v1/);
      assert.equal(args[2]?.cacheRetention, "none");
      return response(evidenceResponse())(...args);
    };
    const original = result();
    const output = await processToolResult(context(), original, 7, complete);
    assert.equal(calls, 1);
    assert.equal(output.isError, true);
    assert.equal(output.details?.sentinel, "keep");
    assert.equal(output.details?.outputSummaryStatus, "evidence-verified");
    assert.equal(output.details?.summaryTotalTokens, 120);
    assert.equal(output.usage?.totalTokens, 120, "nested processing usage must reach Pi session accounting");
    assert.match(output.content[0].text!, /^\[distill:evidence\]/);
    assert.match(output.content[0].text!, /tool_status=error/);
    assert.match(output.content[0].text!, /coverage|coverage and evidence labels/i);
    const artifact = source(output);
    assert.equal(await readFile(artifact.path, "utf8"), body);
    assert.equal(artifact.sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(artifact.lines, body.split("\n").length);
    const read = createReadToolDefinition(directory);
    const tail = await read.execute("read-tail", { path: artifact.path, offset: artifact.lines - 6 + 1, limit: 6 }, undefined, undefined, context().ctx);
    assert.match(JSON.stringify(tail.content), /Tests: 1 failed/);
    const raw = await processToolResult(context("read", { path: artifact.path, outputRequest: "RAW" }), tail as Result, 0, async () => { assert.fail("readback RAW must not call a model"); });
    assert.deepEqual(raw.content, tail.content);
    const replay = await processToolResult(context(), output, 0, async () => { assert.fail("receipt must not be processed twice"); });
    assert.equal(replay, output);
  });
});

test("fabricated evidence is rejected once without JSON repair, retry or generic summary", async () => {
  await configured(async () => {
    let calls = 0;
    const original = result();
    const output = await processToolResult(context(), original, 0, async (...args) => {
      calls++;
      return response(evidenceResponse("FAIL invented.ts"))(...args);
    });
    assert.equal(calls, 1);
    assert.deepEqual(output.content, original.content);
    assert.equal(output.isError, true);
    assert.equal(output.details?.outputSummaryStatus, "evidence-failed");
    assert.match(String(output.details?.outputSummaryError), /evidence-rejected/);
    assert.equal(output.details?.summaryTotalTokens, 120);
    assert.equal(output.usage?.totalTokens, 120, "a rejected receipt still incurred processing cost");
  }, { timeoutRetryCount: 5, errorRetryCount: 5 });
});

test("ordinary output retains dynamic summary and cites archived source without claiming verification", async () => {
  await configured(async () => {
    let calls = 0;
    const complete: Completion = async (...args) => {
      calls++;
      assert.doesNotMatch(JSON.stringify(args[1]), /pi-distill-evidence\/v1/);
      return response(JSON.stringify({ decision: { mode: "SUMMARY", reasonCode: "SELECTED_INFORMATION", reason: "Selected information." }, summary: "The diff updates token validation." }))(...args);
    };
    const output = await processToolResult(context("bash", { command: "git diff", outputRequest: "Summarize changed modules" }), result(body, false), 0, complete);
    assert.equal(calls, 1);
    assert.equal(output.details?.outputSummaryStatus, "summarized");
    assert.match(output.content[0].text!, /^\[distill:summary\]/);
    assert.match(output.content[0].text!, /not locally verified/);
    assert.equal(await readFile(source(output).path, "utf8"), body);
    assert.equal((output.details?.distill as { verification: string }).verification, "none");
  });
});

for (const scenario of ["raw", "disabled", "errors-disabled", "non-text", "too-small", "over-budget", "secret", "preview"] as const) {
  test(`${scenario} bypasses model and does not archive or truncate`, async () => {
    await configured(async (directory, path) => {
      const ctx = context();
      const input = result();
      const config = JSON.parse(await readFile(path, "utf8"));
      config.maxOutputChars = 10;
      if (scenario === "raw") { ctx.params.outputRequest = "RAW"; input.details!.fullOutputPath = "/not/a/real/file"; }
      if (scenario === "disabled") config.enabled = false;
      if (scenario === "errors-disabled") config.summarizeErrors = false;
      if (scenario === "non-text") input.content.push({ type: "image" });
      if (scenario === "too-small") input.content[0].text = "FAIL short";
      if (scenario === "over-budget") config.archive = { maxSourceBytes: 100 };
      if (scenario === "secret") input.content[0].text += "\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz123456";
      if (scenario === "preview") input.details!.truncation = { truncated: true };
      await writeFile(path, JSON.stringify(config));
      const output = await processToolResult(ctx, input, 0, async () => { assert.fail("must bypass model"); });
      assert.deepEqual(output.content, input.content);
      assert.equal(output.isError, input.isError);
      assert.equal(output.details?.outputTruncated, undefined);
      const files = await readdir(join(directory, "extensions/pi-distill"));
      assert.equal(files.includes("artifacts"), false);
    });
  });
}

test("archive failure/quota exhaustion prevents remote calls and retains all original content", async () => {
  await configured(async () => {
    const original = result();
    const output = await processToolResult(context(), original, 0, async () => { assert.fail("archive must precede model"); });
    assert.equal(output.details?.outputSummaryStatus, "archive-failed");
    assert.deepEqual(output.content, original.content);
  }, { archive: { maxSessionBytes: 1 } });
});

test("processing usage adds to existing tool usage without changing RAW accounting", async () => {
  await configured(async () => {
    const input = result();
    input.usage = { input: 8, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
    const output = await processToolResult(context(), input, 0, response(evidenceResponse()));
    assert.equal(output.usage?.totalTokens, 140);
    assert.equal(output.usage?.input, 108);
    assert.equal(output.usage?.output, 32);
    assert.equal(output.usage?.cost.total, 0.01);
    const raw = await processToolResult(context("bash", { command: "npm test", outputRequest: "RAW" }), input, 0, async () => { assert.fail("RAW bypasses"); });
    assert.equal(raw.usage, input.usage);
  });
});

test("receipt cost and output budget can reject an otherwise valid reduction", async () => {
  await configured(async () => {
    const input = result();
    const output = await processToolResult(context(), input, 0, response(evidenceResponse()));
    assert.equal(output.details?.outputSummaryStatus, "summary-fallback");
    assert.deepEqual(output.content, input.content);
    assert.equal(output.details?.outputTruncated, undefined);
  }, { maxOutputChars: 100 });
});

for (const failed of [false, true]) {
  test(`Fusion ${failed ? "failure" : "success"} only replaces command log, preserving confirmation/details/error`, async () => {
    await configured(async () => {
      const prefix = "Successfully replaced 1 block(s) in file.ts.";
      const marker = failed ? "[then_run:failed]" : "[then_run:succeeded]";
      const original: Result = {
        content: failed ? [{ type: "text", text: `${prefix}\n\n${marker}\n\n${body}` }] : [{ type: "text", text: prefix }, { type: "text", text: `${marker}\n${body}` }],
        isError: failed,
        details: failed ? {} : { patch: "patch unchanged", diff: "diff unchanged", firstChangedLine: 1, actionFusion: { command: "npm run test", status: "succeeded" } },
      };
      const ctx = context("edit", { path: "file.ts", then_run: { command: "npm run test" } });
      const output = await processToolResult(ctx, original, 0, response(evidenceResponse()));
      assert.equal(output.details?.outputSummaryStatus, "evidence-verified");
      assert.equal(output.isError, failed);
      assert.ok(output.content[0].text!.startsWith(prefix));
      assert.match(output.content.at(-1)!.text!, /\[then_run:(?:failed|succeeded)\]/);
      assert.equal(output.details?.patch, original.details?.patch);
      assert.equal(output.details?.diff, original.details?.diff);
      const archived = await readFile(source(output).path, "utf8");
      assert.ok(archived.includes(body));
      assert.ok(!archived.includes(prefix));
      assert.ok(!archived.includes(marker));
    });
  });
}

for (const scenario of ["no-command", "skipped", "nondiagnostic", "explicit-off", "fusion-off"] as const) {
  test(`Fusion ${scenario} remains untouched`, async () => {
    await configured(async (_directory, path) => {
      const params: Record<string, unknown> = { path: "x", outputRequest: "Summarize", then_run: { command: "npm test" } };
      const input = result(`[then_run:skipped] ${body}`);
      if (scenario === "no-command") delete params.then_run;
      if (scenario === "nondiagnostic") params.then_run = { command: "git diff" };
      if (scenario === "explicit-off" || scenario === "fusion-off") {
        const config = JSON.parse(await readFile(path, "utf8"));
        if (scenario === "explicit-off") config.tools = { write: { enabled: false } };
        else config.evidence.fusion = false;
        await writeFile(path, JSON.stringify(config));
      }
      const output = await processToolResult(context("write", params), input, 0, async () => { assert.fail("must not summarize mutations"); });
      assert.deepEqual(output.content, input.content);
    });
  });
}

test("Fusion compound diagnostics never automatically send unrelated output", async () => {
  await configured(async () => {
    const command = "npm test; cat confidential.txt";
    const input: Result = { content: [{ type: "text", text: "confirmed edit" }, { type: "text", text: `[then_run:succeeded]\n${body}` }], details: { actionFusion: { status: "succeeded", command } }, isError: false };
    const output = await processToolResult(context("write", { then_run: { command } }), input, 0, async () => { assert.fail("compound output is not eligible for automatic evidence"); });
    assert.deepEqual(output.content, input.content);
    assert.equal(output.details?.distill, undefined);
  });
});

test("new configuration is explicit, validates nested fields and adds only optional Fusion outputRequest", async () => {
  await configured(async (_directory, path) => {
    assert.equal(processingConfig().evidence.enabled, false);
    const tools = [
      { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "edit", parameters: { type: "object", properties: { path: { type: "string" }, then_run: { type: "object" } }, required: ["path"] } },
      { name: "write", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    ];
    const api = { getAllTools: () => tools } as unknown as Parameters<typeof extendDistillToolParameters>[0];
    assert.equal(extendDistillToolParameters(api), 2);
    assert.ok(tools[0].parameters.required.includes("outputRequest"));
    assert.ok(!tools[1].parameters.required.includes("outputRequest"));
    assert.ok("outputRequest" in tools[1].parameters.properties);
    assert.ok(!("outputRequest" in tools[2].parameters.properties));
    for (const invalid of [{ evidence: { enabled: "true" } }, { evidence: { minBytes: 0 } }, { evidence: { commands: [""] } }, { archive: { maxSourceBytes: Infinity } }, { archive: { typo: 12 } }]) {
      await writeFile(path, JSON.stringify(invalid));
      const loaded = loadDistillConfig();
      assert.equal(loaded.config, undefined);
      assert.ok(loaded.warnings.length);
    }
  });
});

test("parent abort cancels evidence even when a provider ignores AbortSignal", { timeout: 3000 }, async () => {
  await configured(async () => {
    const controller = new AbortController();
    const ctx = { ...context(), signal: controller.signal };
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    let release!: (result: Awaited<ReturnType<Completion>>) => void;
    let calls = 0;
    const complete: Completion = async () => { calls++; start(); return new Promise((resolve) => { release = resolve; }); };
    const pending = processToolResult(ctx, result(), 0, complete);
    await started;
    controller.abort();
    try {
      const output = await pending;
      assert.equal(calls, 1);
      assert.deepEqual(output.content, result().content);
    } finally { release(await response(evidenceResponse())({} as never, {} as never)); }
  });
});
