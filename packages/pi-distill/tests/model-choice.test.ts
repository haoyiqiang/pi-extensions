import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processToolResult } from "../src/index.ts";
import {
  buildDistillModelChoices,
  filterDistillModelChoices,
  resolveConfiguredDistillModel,
  resolveDistillRuntimeModel,
} from "../src/model-choice.ts";

process.env.PI_EXTENSIONS_LOCALE = "en-US";

const openRouterFlash = {
  provider: "openrouter",
  id: "deepseek/deepseek-v4-flash",
  name: "DeepSeek: DeepSeek V4 Flash 0423",
};
const nativeFlash = {
  provider: "deepseek",
  id: "deepseek-flash",
  name: "DeepSeek V4.1 Flash",
};

test("模型选择列表以当前会话模型开头，并保留带斜杠的 model ID", () => {
  const choices = buildDistillModelChoices([
    openRouterFlash,
    nativeFlash,
    nativeFlash,
  ], "Current session model");

  assert.deepEqual(choices.map((choice) => choice.value), [
    "",
    "deepseek/deepseek-flash",
    "openrouter/deepseek/deepseek-v4-flash",
  ]);
  assert.equal(choices[2]?.description, openRouterFlash.name);
});

test("过滤可以按模型 ID 中的片段找到 OpenRouter 模型", () => {
  const choices = buildDistillModelChoices([openRouterFlash, nativeFlash], "Current session model");
  const filtered = filterDistillModelChoices(choices, "v4-flash");

  assert.deepEqual(filtered.map((choice) => choice.value), [
    "openrouter/deepseek/deepseek-v4-flash",
  ]);
});

test("唯一的 model ID 可以解析不带 provider 的引用", () => {
  const resolved = resolveConfiguredDistillModel("deepseek/deepseek-v4-flash", [
    openRouterFlash,
    nativeFlash,
  ]);

  assert.equal(resolved, openRouterFlash);
});

test("完整 provider/modelId 优先于另一条相同 model ID", () => {
  const other = { ...openRouterFlash, provider: "proxy" };
  const resolved = resolveConfiguredDistillModel("openrouter/deepseek/deepseek-v4-flash", [
    other,
    openRouterFlash,
  ]);

  assert.equal(resolved, openRouterFlash);
});

test("同一个 model ID 有多个 provider 时不猜测", () => {
  const resolved = resolveConfiguredDistillModel("deepseek/deepseek-v4-flash", [
    openRouterFlash,
    { ...openRouterFlash, provider: "proxy" },
  ]);

  assert.equal(resolved, undefined);
});

test("已配置模型找不到时不回退到会话模型", () => {
  const sessionModel = { provider: "fake", id: "session" };
  const resolved = resolveDistillRuntimeModel(
    "missing/model",
    { find: () => undefined, getAvailable: () => [openRouterFlash] },
    sessionModel,
  );

  assert.equal(resolved, undefined);
});

test("注册表 find 未命中时，仍可用唯一 model ID 解析", () => {
  const resolved = resolveDistillRuntimeModel(
    "deepseek/deepseek-v4-flash",
    {
      find: () => undefined,
      getAvailable: () => [openRouterFlash, nativeFlash],
    },
    { provider: "fake", id: "session" },
  );

  assert.equal(resolved, openRouterFlash);
});

async function withModelConfig<T>(model: string, action: () => Promise<T>): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-distill-model-test-"));
  await mkdir(join(agentDir, "extensions", "pi-distill"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "pi-distill", "config.json"), JSON.stringify({
    enabled: true,
    model,
    minChars: 1,
    maxChars: 10000,
    maxOutputChars: 10000,
    timeoutSeconds: 1,
    timeoutRetryCount: 0,
    errorRetryCount: 0,
  }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  try {
    return await action();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test("配置了不带 provider 的唯一模型 ID 时使用该模型", async () => {
  let seen: { provider?: string; id?: string } | undefined;
  const result = await withModelConfig("deepseek/deepseek-v4-flash", () => processToolResult(
    {
      toolName: "bash",
      toolCallId: "call-1",
      params: { outputRequest: "保留错误" },
      ctx: {
        hasUI: false,
        ui: { notify: () => undefined },
        model: { provider: "fake", id: "session" },
        modelRegistry: {
          find: () => undefined,
          getAvailable: () => [openRouterFlash],
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {}, env: {} }),
        },
        sessionManager: { getSessionId: () => "session-test" },
      },
    } as unknown as Parameters<typeof processToolResult>[0],
    {
      content: [{ type: "text", text: "error: boom" }],
      details: {},
    } as unknown as Parameters<typeof processToolResult>[1],
    0,
    (async (model) => {
      seen = model;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            decision: {
              mode: "SUMMARY",
              reasonCode: "SELECTED_INFORMATION",
              reason: "The request selects the error.",
            },
            summary: "boom",
          }),
        }],
      };
    }) as unknown as NonNullable<Parameters<typeof processToolResult>[3]>,
  ));

  assert.equal(seen?.provider, "openrouter");
  assert.equal(seen?.id, "deepseek/deepseek-v4-flash");
  assert.equal(result.details?.outputSummaryStatus, "summarized");
});

test("配置模型不存在时报告该引用，而不是会话没有模型", async () => {
  const result = await withModelConfig("deepseek/deepseek-v4-flash", () => processToolResult(
    {
      toolName: "bash",
      toolCallId: "call-2",
      params: { outputRequest: "保留错误" },
      ctx: {
        hasUI: true,
        ui: { notify: () => undefined },
        model: undefined,
        modelRegistry: {
          find: () => undefined,
          getAvailable: () => [],
          getApiKeyAndHeaders: async () => ({ ok: true }),
        },
        sessionManager: { getSessionId: () => "session-test" },
      },
    } as unknown as Parameters<typeof processToolResult>[0],
    {
      content: [{ type: "text", text: "error: boom" }],
      details: {},
    } as unknown as Parameters<typeof processToolResult>[1],
    0,
  ));

  assert.match(String(result.details?.outputSummaryError), /deepseek\/deepseek-v4-flash/);
  assert.match(String(result.details?.outputSummaryError), /not available/);
  assert.doesNotMatch(String(result.details?.outputSummaryError), /No model is available in the current session/);
});
