import { registerSessionResourceCleanup, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { buildSessionEntries, createMockCtx, createMockPi, makeAssistantMessage, makeUserMessage } from "@maplezzk/pi-test-utils/rpiv";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, buildSessionContext: vi.fn() };
});

import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { registerAdvisorTool, setAdvisorEffort, setAdvisorModel } from "./advisor-test-state.js";

const usage: Usage = {
  input: 10,
  output: 4,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 14,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function response(text = "advice", stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-responses",
    provider: "test",
    model: "reviewer",
    usage,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function setupStream(responses: Array<AssistantMessage | Error>) {
  const calls: Array<{ model: unknown; context: unknown; options: unknown }> = [];
  const streamSimple = vi.fn((model: unknown, context: unknown, options: unknown) => {
    calls.push({ model, context, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { result: async () => next };
  });
  return { calls, streamSimple };
}

beforeEach(() => {
  vi.mocked(buildSessionContext).mockReset();
  vi.mocked(buildSessionContext).mockImplementation((entries) => ({
    messages: ((entries ?? []) as Array<{ type?: string; message?: unknown }>)
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message),
    thinkingLevel: "off",
    model: null,
  }) as ReturnType<typeof buildSessionContext>);
});

async function executeWith(
  streamSimple: ReturnType<typeof vi.fn>,
  model = { provider: "a", id: "m", api: "openai-responses" },
  signal?: AbortSignal,
) {
  setAdvisorModel(model as never);
  const { pi, captured } = createMockPi();
  registerAdvisorTool(pi);
  const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("q"), makeAssistantMessage({ text: "working" })]) });
  const getApiKeyAndHeaders = vi.fn(async () => ({ ok: false, error: "unexpected advisor auth preflight" }));
  ctx.modelRegistry = { ...ctx.modelRegistry, getApiKeyAndHeaders, streamSimple } as never;
  const result = await captured.tools.get("advisor")?.execute?.("tc", {}, signal as never, undefined as never, ctx);
  return { result, ctx, pi, getApiKeyAndHeaders };
}

describe("executeAdvisor", () => {
  it("uses the public modelRegistry.streamSimple(...).result() path without a separate auth preflight", async () => {
    const stream = setupStream([response("public advice")]);
    const { result, getApiKeyAndHeaders } = await executeWith(stream.streamSimple);
    expect(result?.content[0]).toMatchObject({ type: "text", text: "public advice" });
    expect(result?.details).toMatchObject({ advisorModel: "a:m", stopReason: "stop" });
    expect(stream.streamSimple).toHaveBeenCalledTimes(1);
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it("forwards compacted effective context instead of raw branch history", async () => {
    vi.mocked(buildSessionContext).mockReturnValueOnce({
      messages: [
        { role: "compactionSummary", summary: "COMPACTED SUMMARY", tokensBefore: 100, timestamp: Date.now() },
        makeUserMessage("kept user"),
        makeAssistantMessage({ text: "kept assistant" }),
      ],
      thinkingLevel: "off",
      model: null,
    } as ReturnType<typeof buildSessionContext>);
    const stream = setupStream([response()]);
    await executeWith(stream.streamSimple);
    const serialized = JSON.stringify((stream.calls[0]?.context as { messages: unknown[] }).messages);
    expect(serialized).toContain("COMPACTED SUMMARY");
    expect(serialized).toContain("kept user");
    expect(serialized).not.toContain("OLD RAW");
  });

  it("strips the in-flight advisor call from the snapshotted branch", async () => {
    setAdvisorModel({ provider: "a", id: "m", api: "openai-responses" } as never);
    const { pi, captured } = createMockPi();
    registerAdvisorTool(pi);
    vi.mocked(buildSessionContext).mockReturnValueOnce({
      messages: [makeUserMessage("q"), makeAssistantMessage({ toolCalls: [{ id: "call", name: "advisor", arguments: {} }] })],
      thinkingLevel: "off",
      model: null,
    } as ReturnType<typeof buildSessionContext>);
    const stream = setupStream([response()]);
    const ctx = createMockCtx();
    ctx.modelRegistry = { ...ctx.modelRegistry, streamSimple: stream.streamSimple } as never;
    await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
    expect(JSON.stringify((stream.calls[0]?.context as { messages: unknown[] }).messages)).not.toContain('"name":"advisor"');
  });

  it("forwards cancellation to streamSimple and maps an aborted response without retrying", async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = setupStream([response("", "aborted")]);
    const { result } = await executeWith(stream.streamSimple, undefined, controller.signal);
    expect(stream.streamSimple).toHaveBeenCalledTimes(1);
    expect(stream.calls[0]?.options).toMatchObject({ signal: controller.signal });
    expect(result?.details).toMatchObject({ stopReason: "aborted" });
  });

  it("maps native auth errors from streamSimple without retrying or preflighting", async () => {
    const stream = setupStream([response("", "error", "bad auth")]);
    const { result, getApiKeyAndHeaders } = await executeWith(stream.streamSimple);
    expect(stream.streamSimple).toHaveBeenCalledTimes(1);
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(result?.details).toMatchObject({ advisorModel: "a:m", stopReason: "error", errorMessage: "bad auth" });
    expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("bad auth") });
  });

  it("retries an empty normal response exactly once using the same snapshot objects", async () => {
    setAdvisorEffort("high");
    const stream = setupStream([response(""), response("recovered")]);
    const { result } = await executeWith(stream.streamSimple);
    expect(result?.content[0]).toMatchObject({ text: "recovered" });
    expect(stream.streamSimple).toHaveBeenCalledTimes(2);
    expect(stream.calls[1]?.model).toBe(stream.calls[0]?.model);
    expect(stream.calls[1]?.context).toBe(stream.calls[0]?.context);
    expect(stream.calls[1]?.options).toBe(stream.calls[0]?.options);
    expect(stream.calls[0]?.options).toMatchObject({ reasoning: "high", toolChoice: "none" });
    const cumulative = {
      input: 20,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 28,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    expect(result?.usage).toMatchObject(cumulative);
    expect(result?.details).toMatchObject({ usage: cumulative });
  });

  it("surfaces a bounded empty-response envelope after the retry", async () => {
    const stream = setupStream([response(""), response("   ")]);
    const { result } = await executeWith(stream.streamSimple);
    expect(stream.streamSimple).toHaveBeenCalledTimes(2);
    expect(result?.details).toMatchObject({ errorMessage: "empty response" });
  });

  it("returns nested model usage at both tool-result and details levels", async () => {
    const stream = setupStream([response()]);
    const { result } = await executeWith(stream.streamSimple);
    expect(result?.usage).toEqual(usage);
    expect(result?.details).toMatchObject({ usage });
  });

  it("wraps transport throws as a normal tool result", async () => {
    const stream = setupStream([new Error("boom")]);
    const { result } = await executeWith(stream.streamSimple);
    expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("boom") });
    expect(result?.details).toMatchObject({ errorMessage: "boom" });
  });

  it("returns the no-model envelope before starting a request", async () => {
    const { pi, captured } = createMockPi();
    registerAdvisorTool(pi);
    const noModel = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, createMockCtx());
    expect(noModel?.details).toMatchObject({ errorMessage: "no advisor model selected" });
  });

  it("allows OAuth-style resolved auth without a literal apiKey", async () => {
    const stream = setupStream([response("oauth advice")]);
    setAdvisorModel({ provider: "oauth", id: "m", api: "openai-responses" } as never);
    const { pi, captured } = createMockPi();
    registerAdvisorTool(pi);
    const ctx = createMockCtx();
    const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true }));
    ctx.modelRegistry = {
      ...ctx.modelRegistry,
      getApiKeyAndHeaders,
      streamSimple: stream.streamSimple,
    } as never;
    const result = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
    expect(result?.content[0]).toMatchObject({ text: "oauth advice" });
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it("uses isolated uuidv7 sessions for Codex and always cleans them up", async () => {
    const used: string[] = [];
    const cleaned: Array<string | undefined> = [];
    const release = registerSessionResourceCleanup((sessionId) => cleaned.push(sessionId));
    try {
      for (const outcome of [response("codex"), new Error("transport")]) {
        const streamSimple = vi.fn((_model: unknown, _context: unknown, options: { sessionId: string }) => {
          used.push(options.sessionId);
          if (outcome instanceof Error) throw outcome;
          return { result: async () => outcome };
        });
        await executeWith(streamSimple, { provider: "openai-codex", id: "reviewer", api: "openai-codex-responses" });
      }
    } finally {
      release();
    }
    expect(used).toHaveLength(2);
    expect(new Set(used).size).toBe(2);
    for (const sessionId of used) expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(cleaned).toEqual(used);
  });
});
