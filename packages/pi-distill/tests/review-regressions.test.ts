import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildDistillAuditLines, createDistillAuditComponent } from "../src/fallback-renderer.ts";
import distill, { extendDistillToolParameters, processToolResult } from "../src/index.ts";
import { loadDistillConfig } from "../src/summary-utils.ts";

type Context = Parameters<typeof processToolResult>[0];
type Completion = NonNullable<Parameters<typeof processToolResult>[3]>;
const text = "repeated exact diagnostic context\n".repeat(500);
async function fixture(action: (path: string) => Promise<void>, extra: Record<string, unknown> = {}) {
  const old = process.env.PI_CODING_AGENT_DIR;
  const locale = process.env.PI_EXTENSIONS_LOCALE;
  const directory = await mkdtemp(join(tmpdir(), "distill-review-"));
  const path = join(directory, "extensions/pi-distill/config.json");
  await mkdir(join(directory, "extensions/pi-distill"), { recursive: true });
  await writeFile(path, JSON.stringify({ enabled: true, model: "fake/model", minChars: 1, maxChars: 10000, maxOutputChars: 10000, timeoutSeconds: 1, errorRetryCount: 0, timeoutRetryCount: 1, ...extra }));
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  try { await action(path); }
  finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    if (locale === undefined) delete process.env.PI_EXTENSIONS_LOCALE; else process.env.PI_EXTENSIONS_LOCALE = locale;
    await rm(directory, { recursive: true, force: true });
  }
}
function context(contextWindow?: number): Context {
  const model = { id: "model", provider: "fake", input: ["text"], maxTokens: 8192, contextWindow };
  return { toolName: "custom", toolCallId: "review-call", params: { outputRequest: "Summarize" }, ctx: {
    cwd: process.cwd(), hasUI: false, ui: { notify() {} }, model,
    modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true }) },
    sessionManager: { getSessionId: () => "review-session" },
  } } as unknown as Context;
}
function harness(tools: any[]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
  const api = {
    getAllTools: () => tools, on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerCommand: (name: string, value: any) => commands.set(name, value),
    registerEntryRenderer() {}, appendEntry() {}, registerTool() {},
  } as unknown as ExtensionAPI;
  distill(api);
  return { api, handlers, commands };
}

test("native outputRequest collisions are never overwritten or stripped and are not processed", async () => {
  await fixture(async () => {
    const native = { type: "string", enum: ["business-value"] };
    const tools = [{ name: "custom", parameters: { type: "object", properties: { outputRequest: native }, required: ["outputRequest"] } }];
    const { api, handlers } = harness(tools);
    const warnings: string[] = [];
    assert.equal(extendDistillToolParameters(api, loadDistillConfig(), (message) => warnings.push(message)), 0);
    assert.equal(tools[0].parameters.properties.outputRequest, native);
    assert.ok(warnings.length);
    assert.equal(await handlers.get("before_agent_start")!({ prompt: "run business tool", systemPrompt: "native prompt" }, context().ctx), undefined, "do not apply Distill's prompt contract to a native business field");
    const input = { outputRequest: "business-value" };
    await handlers.get("tool_call")!({ toolName: "custom", toolCallId: "native", input }, context().ctx);
    assert.equal(input.outputRequest, "business-value");
    const output = await handlers.get("tool_result")!({ toolName: "custom", toolCallId: "native", input, content: [{ type: "text", text }], details: {}, isError: false }, context().ctx);
    assert.deepEqual(output.content, [{ type: "text", text }]);
    assert.equal(output.details.outputSummaryStatus, undefined);
  });
});

test("a mid-turn disable strips only the still-owned handling field without processing results", async () => {
  await fixture(async (path) => {
    const tools = [{ name: "custom", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }];
    const { api, handlers } = harness(tools);
    extendDistillToolParameters(api);
    await writeFile(path, JSON.stringify({ enabled: false }));
    const input = { value: "business", outputRequest: "Summarize" };
    await handlers.get("tool_call")!({ toolName: "custom", toolCallId: "disabled-inflight", input }, context().ctx);
    assert.equal(input.outputRequest, undefined);
    assert.equal(input.value, "business");
    const output = await handlers.get("tool_result")!({ toolName: "custom", toolCallId: "disabled-inflight", input, content: [{ type: "text", text }], details: {}, isError: false }, context().ctx);
    assert.deepEqual(output.content, [{ type: "text", text }]);
    assert.equal(output.details.outputSummaryStatus, undefined);
  });
});

test("schema restore removes only Distill fields and preserves later extension requirements", async () => {
  await fixture(async () => {
    const tools = [{ name: "custom", parameters: { type: "object", properties: { value: { type: "string" } } as Record<string, unknown>, required: ["value"] } }];
    const { api } = harness(tools);
    const loaded = loadDistillConfig();
    assert.equal(extendDistillToolParameters(api, loaded), 1);
    tools[0].parameters.properties.external = { type: "string" };
    tools[0].parameters.required.push("external");
    extendDistillToolParameters(api, { ...loaded, enabled: false });
    assert.deepEqual(tools[0].parameters.required, ["value", "external"]);
    assert.ok(tools[0].parameters.properties.external);
    assert.equal(tools[0].parameters.properties.outputRequest, undefined);
  });
});

test("externally required optional Fusion field is handed off without leaving an invalid schema", async () => {
  await fixture(async () => {
    const tools = [{ name: "edit", parameters: { type: "object", properties: { path: { type: "string" }, then_run: { type: "object" } } as Record<string, unknown>, required: ["path"] } }];
    const { api, handlers } = harness(tools);
    const loaded = loadDistillConfig();
    assert.equal(extendDistillToolParameters(api, loaded), 1);
    tools[0].parameters.required.push("outputRequest");
    const property = tools[0].parameters.properties.outputRequest;
    extendDistillToolParameters(api, { ...loaded, enabled: false });
    assert.equal(tools[0].parameters.properties.outputRequest, property);
    assert.ok(tools[0].parameters.required.includes("outputRequest"));
    const input = { path: "file.ts", outputRequest: "now owned elsewhere" };
    await handlers.get("tool_call")!({ toolName: "edit", toolCallId: "handoff", input }, context().ctx);
    assert.equal(input.outputRequest, "now owned elsewhere");
  }, { evidence: { enabled: true, fusion: true } });
});

test("invalid tool opt-outs fail closed rather than activating default processing", async () => {
  await fixture(async (path) => {
    for (const tools of ["bad", { bash: { enabled: "false" } }, { edit: { enabled: null } }]) {
      await writeFile(path, JSON.stringify({ evidence: { enabled: true, fusion: true }, tools }));
      const loaded = loadDistillConfig();
      assert.equal(loaded.config, undefined);
      assert.ok(loaded.warnings.length);
      const original = { content: [{ type: "text", text }], details: {} };
      const output = await processToolResult(context(), original, 0, async () => { assert.fail("critical configuration cannot send logs"); });
      assert.deepEqual(output.content, original.content);
    }
  });
});

test("UI switches effective mutation state in one click and preserves nested metadata", async () => {
  await fixture(async (path) => {
    const tools = [{ name: "edit", parameters: { type: "object", properties: { path: { type: "string" }, then_run: { type: "object" } }, required: ["path"] } }];
    const { commands } = harness(tools);
    const choices = ["Tool outputRequest", "edit:", undefined, undefined];
    await commands.get("config:distill")!.handler("", { hasUI: true, ui: {
      notify() {},
      select: async (_title: string, entries: string[]) => { const prefix = choices.shift(); return prefix ? entries.find((entry) => entry.startsWith(prefix)) : undefined; },
    } });
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.tools.edit.enabled, false);
    assert.equal(saved.tools.edit.note, "keep-native-metadata");
    assert.equal(saved.render.futureOption, "keep-render-option");
    assert.equal(saved.topLevelFuture, "keep-top-level");
  }, { evidence: { enabled: true, fusion: true }, tools: { edit: { enabled: true, note: "keep-native-metadata" } }, render: { futureOption: "keep-render-option" }, topLevelFuture: "keep-top-level" });
  // Also cover default effective mutation permission without a stored override.
  await fixture(async (path) => {
    const { commands } = harness([{ name: "edit", parameters: { type: "object", properties: { then_run: { type: "object" } } } }]);
    const choices = ["Tool outputRequest", "edit:", undefined, undefined];
    await commands.get("config:distill")!.handler("", { hasUI: true, ui: { notify() {}, select: async (_title: string, entries: string[]) => { const prefix = choices.shift(); return prefix ? entries.find((entry) => entry.startsWith(prefix)) : undefined; } } });
    assert.equal(JSON.parse(await readFile(path, "utf8")).tools.edit.enabled, false);
  }, { evidence: { enabled: true, fusion: true } });
});

test("critical unknown future config is preserved and requires manual repair", async () => {
  await fixture(async (path) => {
    const original = JSON.stringify({ evidence: { enabled: true, futureOption: "do-not-delete" } });
    await writeFile(path, original);
    const { commands } = harness([]);
    await commands.get("config:distill")!.handler("", { hasUI: true, ui: { notify() {}, select() { assert.fail("invalid config is not normalized and saved"); } } });
    assert.equal(await readFile(path, "utf8"), original);
  });
});

test("unconfirmed timeout cancellation never starts another billable request", { timeout: 4000 }, async () => {
  await fixture(async () => {
    let calls = 0;
    let release!: (value: Awaited<ReturnType<Completion>>) => void;
    const completion: Completion = async () => { calls++; return new Promise((resolve) => { release = resolve; }); };
    try {
      const original = { content: [{ type: "text", text }], details: {} };
      const output = await processToolResult(context(), original, 0, completion);
      assert.equal(calls, 1);
      assert.deepEqual(output.content, original.content);
      assert.match(String(output.details?.outputSummaryError), /cancellation-unconfirmed/);
    } finally { release({ content: [{ type: "text", text: "{}" }], stopReason: "stop" } as Awaited<ReturnType<Completion>>); }
  }, { timeoutRetryCount: 5 });
});

test("failed JSON repair retains both requests' reported usage and does not rerun summary", async () => {
  await fixture(async () => {
    let calls = 0;
    const completion: Completion = async () => ({ content: [{ type: "text", text: "not valid json" }], stopReason: "stop", usage: { input: ++calls * 10, output: 1, totalTokens: calls * 10 + 1, cost: { total: calls * 0.01 } } } as unknown as Awaited<ReturnType<Completion>>);
    const original = { content: [{ type: "text", text }], details: {} };
    const output = await processToolResult(context(), original, 0, completion);
    assert.equal(calls, 2);
    assert.deepEqual(output.content, original.content);
    assert.equal(output.details?.summaryJsonRepairSucceeded, false);
    assert.equal(output.details?.summaryAttempts, 1);
    assert.equal(output.details?.summaryTotalTokens, 32);
    assert.equal(output.usage?.totalTokens, 32);
    assert.equal(output.usage?.cost.total, 0.03);
  }, { errorRetryCount: 5 });
});

test("oversized JSON repair is refused before a second request while initial usage is retained", async () => {
  await fixture(async () => {
    let calls = 0;
    const completion: Completion = async () => {
      calls++;
      return { content: [{ type: "text", text: "invalid ".repeat(5000) }], stopReason: "stop", usage: { input: 100, output: 10, totalTokens: 110 } } as Awaited<ReturnType<Completion>>;
    };
    const original = { content: [{ type: "text", text: "exact input\n".repeat(100) }], details: {} };
    const output = await processToolResult(context(12000), original, 0, completion);
    assert.equal(calls, 1);
    assert.deepEqual(output.content, original.content);
    assert.equal(output.usage?.totalTokens, 110);
    assert.match(String(output.details?.outputSummaryError), /over-context-budget/);
  });
});

for (const cancellation of ["deadline", "parent-abort"] as const) {
  test(`reported initial usage survives an unresponsive JSON repair (${cancellation})`, { timeout: 4000 }, async () => {
    await fixture(async () => {
      let calls = 0;
      let repairStarted!: () => void;
      const started = new Promise<void>((resolve) => { repairStarted = resolve; });
      let release!: (value: Awaited<ReturnType<Completion>>) => void;
      const controller = new AbortController();
      const execution = context();
      if (cancellation === "parent-abort") execution.signal = controller.signal;
      const completion: Completion = async () => {
        calls++;
        if (calls === 1) return { content: [{ type: "text", text: "invalid JSON" }], stopReason: "stop", usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 0.02 } } } as Awaited<ReturnType<Completion>>;
        return new Promise((resolve) => { release = resolve; repairStarted(); });
      };
      const original = { content: [{ type: "text", text }], details: {}, usage: { input: 8, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.01 } } };
      const pending = processToolResult(execution, original, 0, completion);
      try {
        await started;
        if (cancellation === "parent-abort") controller.abort();
        const result = await pending;
        assert.equal(calls, 2, "unconfirmed repair cancellation must not restart the summary");
        assert.deepEqual(result.content, original.content);
        assert.equal(result.details?.summaryTotalTokens, 110);
        assert.equal(result.details?.summaryCost, 0.02);
        assert.equal(result.usage?.totalTokens, 130);
        assert.equal(result.usage?.cost.total, 0.03);
        assert.equal(result.details?.summaryJsonRepairAttempted, true);
        assert.equal(result.details?.summaryJsonRepairSucceeded, false);
        release({ content: [{ type: "text", text: "{}" }], stopReason: "stop" } as Awaited<ReturnType<Completion>>);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(result.usage?.totalTokens, 130, "late settlement cannot mutate returned accounting");
      } finally {
        release?.({ content: [{ type: "text", text: "{}" }], stopReason: "stop" } as Awaited<ReturnType<Completion>>);
        await pending;
      }
    }, { timeoutRetryCount: 5, errorRetryCount: 5 });
  });
}

test("production requests delegate authentication once to the model registry", async () => {
  await fixture(async () => {
    const execution = context();
    let requests = 0;
    execution.ctx.modelRegistry.getApiKeyAndHeaders = async () => { assert.fail("standalone authentication precheck must not run"); };
    execution.ctx.modelRegistry.streamSimple = (() => ({ result: async () => {
      requests++;
      return { content: [{ type: "text", text: JSON.stringify({ decision: { mode: "SUMMARY", reasonCode: "SELECTED_INFORMATION", reason: "Selected facts." }, summary: "short result" }) }], stopReason: "stop", usage: { input: 100, output: 10, totalTokens: 110 } };
    } })) as unknown as typeof execution.ctx.modelRegistry.streamSimple;
    const result = await processToolResult(execution, { content: [{ type: "text", text }], details: {} }, 0);
    assert.equal(requests, 1);
    assert.equal(result.details?.outputSummaryStatus, "summarized");
    assert.equal(result.usage?.totalTokens, 110);
  });
});

test("registry authentication failures retain original output without a precheck", async () => {
  await fixture(async () => {
    const execution = context();
    execution.ctx.modelRegistry.getApiKeyAndHeaders = async () => { assert.fail("authentication belongs to streamSimple"); };
    execution.ctx.modelRegistry.streamSimple = (() => ({ result: async () => { throw new Error("credential unavailable"); } })) as unknown as typeof execution.ctx.modelRegistry.streamSimple;
    const original = { content: [{ type: "text", text }], details: {} };
    const result = await processToolResult(execution, original, 0);
    assert.deepEqual(result.content, original.content);
    assert.match(String(result.details?.outputSummaryError), /credential unavailable/);
  });
});

test("Pi peer minimum and lockfile match the tested registry API baseline", async () => {
  const pkg = JSON.parse(await readFile(join(import.meta.dirname, "../package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(import.meta.dirname, "../../../package-lock.json"), "utf8"));
  for (const peer of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    assert.equal(pkg.peerDependencies[peer], ">=0.87.1");
    assert.equal(lock.packages["packages/pi-distill"].peerDependencies[peer], pkg.peerDependencies[peer]);
  }
});

test("partial cache-only or cost-only provider usage still reaches Pi accounting", async () => {
  for (const usage of [{ cacheRead: 42, cacheWrite: 3, cacheWrite1h: 1, cost: { total: 0.2 } }, { cost: { total: 0.2 } }]) {
    await fixture(async () => {
      const completion: Completion = async () => ({ content: [{ type: "text", text: JSON.stringify({ decision: { mode: "SUMMARY", reasonCode: "SELECTED_INFORMATION", reason: "Selected facts." }, summary: "short result" }) }], stopReason: "stop", usage } as unknown as Awaited<ReturnType<Completion>>);
      const output = await processToolResult(context(), { content: [{ type: "text", text }], details: {} }, 0, completion);
      assert.equal(output.usage?.cost.total, 0.2);
      if ("cacheRead" in usage) {
        assert.equal(output.usage?.cacheRead, 42);
        assert.equal(output.usage?.totalTokens, 45);
        assert.equal(output.usage?.cacheWrite1h, 1);
      }
    });
  }
});

test("expanded source receipts fit narrow UI widths without prefix overflow", async () => {
  await fixture(async () => {
    const view = buildDistillAuditLines("bash", {
      outputSummaryStatus: "evidence-verified", outputSummaryPrompt: "Retain 中文 evidence\nsecond focus line",
      summaryText: "FAIL 中文 ⚠️ assertion\nExpected: 200\nReceived: 401",
      distill: { source: { path: `/archive/${"长路径".repeat(20)}/source.txt` } },
    }, true)!;
    const component = createDistillAuditComponent(view, { fg: (_color, value) => value, bold: (value) => value });
    for (const width of [1, 2, 3, 4, 8, 12, 20, 80]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
  });
});

test("model context budget prevents predictably oversized remote requests before archival", async () => {
  await fixture(async () => {
    const original = { content: [{ type: "text", text }], details: {} };
    const output = await processToolResult(context(2048), original, 0, async () => { assert.fail("oversized model request must not start"); });
    assert.equal(output.details?.outputSummaryStatus, "input-over-budget");
    assert.deepEqual(output.content, original.content);
  });
});
