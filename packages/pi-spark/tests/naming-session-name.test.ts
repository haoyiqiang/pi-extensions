import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionNamePrompt,
  getSessionUserMessages,
  normalizeSessionName,
  requestSessionName,
  requestSessionNameWithTimeout,
  type SessionNameCompletion,
  type SessionNameRequest,
  type SessionNameRequester,
} from "../src/features/naming/session-name.ts";

import { parseConfig } from "../src/features/naming/config.ts";
import { registerSessionResourceCleanup, type AssistantMessage } from "@earendil-works/pi-ai";

/** 构造最小化的用户消息 session 条目，供提取逻辑测试使用。 */
function userEntry(id: string, content: unknown): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "user",
      content,
      timestamp: 0,
    },
  } as SessionEntry;
}

test("getSessionUserMessages 只提取用户消息中的文本", () => {
  const entries = [
    userEntry("user-1", "实现自动命名"),
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "好的" }],
      },
    },
    userEntry("user-2", [
      { type: "text", text: "补充" },
      { type: "image", data: "ignored" },
      { type: "text", text: "测试要求" },
    ]),
  ] as SessionEntry[];

  assert.deepEqual(getSessionUserMessages(entries), ["实现自动命名", "补充测试要求"]);
});

test("buildSessionNamePrompt 为用户消息添加边界", () => {
  const prompt = buildSessionNamePrompt(["修复登录超时", "补充回归测试"]);

  assert.match(prompt, /<user-messages>/);
  assert.match(prompt, /<user-message index="1">\n修复登录超时/);
  assert.match(prompt, /<user-message index="2">\n补充回归测试/);
  assert.match(prompt, /<\/user-messages>/);
});

test("normalizeSessionName 收敛模型的标题格式并限制长度", () => {
  assert.equal(normalizeSessionName('```text\n"修复登录超时"\n```'), "修复登录超时");
  assert.equal(normalizeSessionName("标题：  Fix timeout\n补充说明"), "Fix timeout");
  assert.equal(normalizeSessionName("- Add tests"), "Add tests");
  assert.equal(normalizeSessionName("12345678901234567890"), "123456789012345");
});

test("requestSessionName 使用当前模型单独请求标题", async () => {
  let receivedPrompt = "";
  let receivedSystem = "";
  let receivedMaxTokens: number | undefined;
  let receivedEffort: string | undefined;
  /** 返回固定标题并记录请求参数的 completion 测试替身。 */
  const completion: SessionNameCompletion = async (_model, context, options) => {
    receivedMaxTokens = options?.maxTokens;
    receivedEffort = options?.reasoning;
    receivedSystem = context.systemPrompt ?? "";
    receivedPrompt = context.messages[0]?.content instanceof Array
      ? context.messages[0].content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("")
      : "";
    return {
      role: "assistant",
      content: [{ type: "text", text: '"修复登录超时"' }],
      api: "test-api",
      provider: "test-provider",
      model: "title-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
  };
  const ctx = {
    model: { provider: "test-provider", id: "title-model", maxTokens: 4096 },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: "test-key",
        headers: { "x-test": "1" },
        env: {},
      }),
    },
    sessionManager: { getSessionId: () => "session-abc" },
  } as unknown as SessionNameRequest["ctx"];

  const name = await requestSessionName({
    userMessages: ["修复登录超时"],
    ctx,
    completion,
  });

  assert.equal(name, "修复登录超时");
  assert.match(receivedPrompt, /修复登录超时/);
  assert.equal(receivedMaxTokens, 2048);
  assert.equal(receivedEffort, "low");
  assert.match(receivedSystem, /15/);
  const title = parseConfig({ title: { maxLength: 4, preferredLength: 3, language: "Japanese", instructions: "Keep API names", effort: "high" } }).title;
  const custom = await requestSessionName({ userMessages: ["任务"], ctx, completion, title });
  assert.equal(receivedEffort, "high");
  assert.equal(custom, "修复登录");
  assert.match(receivedSystem, /Japanese/);
  assert.match(receivedSystem, /Keep API names/);
  assert.match(receivedSystem, /4/);
  assert.match(receivedSystem, /3/);
  await requestSessionName({ userMessages: ["任务"], ctx, completion,
    title: parseConfig({ title: { maxTokens: 600 } }).title });
  assert.equal(receivedMaxTokens, 600);
  await requestSessionName({ userMessages: ["任务"], ctx, completion,
    title: parseConfig({ title: { maxTokens: 99999 } }).title });
  assert.equal(receivedMaxTokens, 4096);
});

test("requestSessionName 显式报告鉴权、模型和空标题错误", async () => {
  const noModelContext = {
    model: undefined,
    modelRegistry: {},
  } as unknown as SessionNameRequest["ctx"];
  await assert.rejects(
    requestSessionName({ userMessages: ["任务"], ctx: noModelContext }),
    /No model|没有可用模型/,
  );

  const authContext = {
    model: { provider: "test-provider", id: "title-model", maxTokens: 4096 },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: false as const, error: "missing auth" }),
    },
  } as unknown as SessionNameRequest["ctx"];
  await assert.rejects(
    requestSessionName({ userMessages: ["任务"], ctx: authContext }),
    /authentication|鉴权/,
  );

  const emptyCompletion: SessionNameCompletion = async () => ({
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "test-provider",
    model: "title-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  });
  const validContext = {
    model: { provider: "test-provider", id: "title-model", maxTokens: 4096 },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    },
    sessionManager: { getSessionId: () => "session-abc" },
  } as unknown as SessionNameRequest["ctx"];
  await assert.rejects(
    requestSessionName({ userMessages: ["任务"], ctx: validContext, completion: emptyCompletion }),
    /valid title|有效标题/,
  );
});

test("requestSessionNameWithTimeout 超时后中止请求", async () => {
  let signal: AbortSignal | undefined;
  const requestName: SessionNameRequester = async (request) => {
    signal = request.signal;
    return new Promise<string>(() => undefined);
  };
  const ctx = {} as SessionNameRequest["ctx"];

  await assert.rejects(
    requestSessionNameWithTimeout({
      userMessages: ["超时任务"],
      ctx,
      requestName,
      title: parseConfig({ title: { timeoutMs: 5 } }).title,
    }),
    /timed out|超时/,
  );
  assert.equal(signal?.aborted, true);
});

test("标题按 Unicode 字符截断，不切断代理对", () => {
  assert.equal(normalizeSessionName("😀".repeat(16)), "😀".repeat(15));
});


test("自定义标题长度支持较长英文标题与 Unicode", () => {
  const name = "Investigate session naming configuration";
  assert.equal(normalizeSessionName(name, 60), name);
  assert.equal(normalizeSessionName("😀".repeat(8), 4), "😀".repeat(4));
});

function response(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: '"Registry title"' }],
    api: "openai-responses", provider: "test", model: "title-model", stopReason,
    errorMessage: stopReason === "stop" ? undefined : "provider failure",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 0,
  };
}

test("production title requests use the active model registry and preserve request settings", async () => {
  const calls: string[] = [];
  const model = { api: "openai-responses", provider: "test", id: "title-model", baseUrl: "https://example.com/v1", maxTokens: 4096 };
  const controller = new AbortController();
  const ctx = {
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async (requestedModel: unknown) => {
        assert.equal(requestedModel, model);
        calls.push("auth");
        return { ok: true, apiKey: "test-key", headers: { "x-test": "1" }, env: {} };
      },
      streamSimple: (requestedModel: unknown, context: Parameters<SessionNameCompletion>[1], options: Parameters<SessionNameCompletion>[2]) => {
        calls.push("streamSimple");
        assert.equal(requestedModel, model);
        assert.equal(options?.sessionId, undefined);
        assert.equal(options?.signal, controller.signal);
        assert.equal(options?.maxTokens, 600);
        assert.equal(options?.reasoning, "minimal");
        assert.match(context.systemPrompt ?? "", /English/);
        assert.match(context.systemPrompt ?? "", /Keep API names/);
        return { result: async () => { calls.push("result"); return response(); } };
      },
    },
  } as unknown as SessionNameRequest["ctx"];
  const title = parseConfig({ title: { maxTokens: 600, effort: "minimal", language: "English", instructions: "Keep API names" } }).title;
  assert.equal(await requestSessionName({ userMessages: ["Main task", "Actually fix API retries", "Continue"], ctx, title, signal: controller.signal }), "Registry title");
  assert.deepEqual(calls, ["auth", "streamSimple", "result"]);
});

test("Codex title calls use unique uuidv7 sessions and always clean them up", async () => {
  const used: string[] = [];
  const cleaned: Array<string | undefined> = [];
  const dispose = registerSessionResourceCleanup((sessionId) => { cleaned.push(sessionId); });
  try {
    for (const outcome of ["success", "error", "aborted", "throw", "stream-throw"] as const) {
      const ctx = {
        model: { api: "openai-codex-responses", provider: "openai-codex", id: "title-model", maxTokens: 4096 },
        sessionManager: { getSessionId: () => "main-session" },
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "oauth-test-token" }),
          streamSimple: (_model: unknown, _context: unknown, options: { sessionId: string }) => {
            used.push(options.sessionId);
            assert.notEqual(options.sessionId, "main-session");
            assert.match(options.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            if (outcome === "stream-throw") throw new Error("stream startup failed");
            return { result: async () => {
              if (outcome === "throw") throw new Error("transport failed");
              return response(outcome === "success" ? "stop" : outcome);
            } };
          },
        },
      } as unknown as SessionNameRequest["ctx"];
      const request = requestSessionName({ userMessages: ["Task"], ctx });
      if (outcome === "success") assert.equal(await request, "Registry title");
      else await assert.rejects(request, /provider failure|transport failed|stream startup failed/);
      assert.deepEqual(cleaned, used);
    }
    assert.equal(new Set(used).size, used.length);
  } finally {
    dispose();
  }
});

test("Codex timeout aborts the registry request and cleans its isolated session", async () => {
  let session: string | undefined;
  let signal: AbortSignal | undefined;
  const cleaned: Array<string | undefined> = [];
  const dispose = registerSessionResourceCleanup((id) => { cleaned.push(id); });
  try {
    const ctx = {
      model: { api: "openai-codex-responses", provider: "openai-codex", id: "title-model", maxTokens: 4096 },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "oauth-test-token" }),
        streamSimple: (_model: unknown, _context: unknown, options: { sessionId: string; signal: AbortSignal }) => {
          session = options.sessionId;
          signal = options.signal;
          return { result: () => new Promise<AssistantMessage>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(response("aborted")), { once: true });
          }) };
        },
      },
    } as unknown as SessionNameRequest["ctx"];
    await assert.rejects(requestSessionNameWithTimeout({ userMessages: ["Task"], ctx, timeoutMs: 5 }), /timed out|超时/);
    assert.equal(signal?.aborted, true);
    assert.equal(typeof session, "string");
    assert.deepEqual(cleaned, [session]);
  } finally {
    dispose();
  }
});

test("auth failures and missing user messages never reach the registry transport", async () => {
  const ctx = {
    model: { api: "openai-responses", provider: "test", id: "title-model", maxTokens: 4096 },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: false, error: "missing key" }),
      streamSimple: () => assert.fail("transport must not run"),
    },
  } as unknown as SessionNameRequest["ctx"];
  await assert.rejects(requestSessionName({ userMessages: ["Task"], ctx }), /missing key/);
  await assert.rejects(requestSessionName({ userMessages: [], ctx }), /no user messages|没有可用于/);
});
