import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatWebSearchResult, resolveCitedText } from "../src/format.ts";
import { callAnthropicStream } from "../src/providers/anthropic.ts";
import { applyCitations, callGoogleStream } from "../src/providers/google.ts";
import { callOpenAIStream } from "../src/providers/openai.ts";
import { readSseEvents } from "../src/providers/sse.ts";
import { classifySearchFailure, webSearch } from "../src/web_search.ts";

const models = {
  google: { id: "gemini-test", provider: "google", api: "google-generative-ai", baseUrl: "https://google.test/v1beta", headers: {} },
  anthropic: { id: "claude-test", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://anthropic.test", headers: {}, maxTokens: 4096 },
  openai: { id: "gpt-test", provider: "openai", api: "openai-responses", baseUrl: "https://openai.test/v1", headers: {} },
  xai: { id: "grok-test", provider: "xai", api: "openai-responses", baseUrl: "https://xai.test/v1", headers: {} },
};

type Provider = keyof typeof models;
function context(model: any, auth = { ok: true, apiKey: "offline-test-key" } as any) {
  return {
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => auth,
      getAvailable: () => [model],
      find: (provider: string, id: string) => model.provider === provider && model.id === id ? model : undefined,
    },
    sessionManager: { getSessionId: () => "offline-session" },
  } as any;
}

function call(provider: Provider, signal?: AbortSignal) {
  const model = models[provider];
  const ctx = context(model);
  return provider === "google"
    ? callGoogleStream(ctx, model as any, { contents: [{ role: "user", parts: [{ text: "test" }] }] }, undefined, signal)
    : provider === "anthropic"
      ? callAnthropicStream(ctx, model as any, "test", undefined, signal)
      : callOpenAIStream(ctx, model as any, "test", undefined, signal);
}

function sse(...events: any[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function byteStream(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); }
  finally { globalThis.fetch = original; }
}

async function withConfig(config: unknown, run: () => Promise<void>) {
  const names = ["PI_WEB_SEARCH_CONFIG", "XDG_CONFIG_HOME", "HOME", "BRAVE_SEARCH_API_KEY"] as const;
  const previous = names.map((name) => process.env[name]);
  const dir = await mkdtemp(join(tmpdir(), "pi-llm-providers-"));
  process.env.PI_WEB_SEARCH_CONFIG = join(dir, "config.json");
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.HOME = join(dir, "home");
  process.env.BRAVE_SEARCH_API_KEY = "offline-brave-key";
  await writeFile(process.env.PI_WEB_SEARCH_CONFIG, JSON.stringify(config));
  try { await run(); }
  finally {
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
    await rm(dir, { recursive: true, force: true });
  }
}

function answerEvent(provider: Provider, text = "离线 answer 🌍") {
  return provider === "google" ? { candidates: [{ content: { parts: [{ text }] } }] }
    : provider === "anthropic" ? { type: "content_block_start", index: 0, content_block: { type: "text", text } }
      : { type: "response.output_text.delta", delta: text };
}

function toolError(code: string, array = false) {
  const content = { type: "web_search_tool_result_error", error_code: code };
  return { type: "content_block_start", index: 1, content_block: {
    type: "web_search_tool_result", tool_use_id: "search-1", content: array ? [content] : content,
  } };
}

const invalidStreams = [
  ["empty", () => new Response("")],
  ["no body", () => new Response(null)],
  ["whitespace", () => new Response(" \r\n\t")],
  ["HTML error page", () => new Response("<!doctype html><h1>Proxy error</h1>", { headers: { "content-type": "text/html" } })],
  ["non-SSE JSON error page", () => new Response('{"error":"proxy error"}')],
  ["malformed JSON", () => new Response("data: {not-json}\n\n")],
  ["truncated JSON", () => new Response('data: {"type":')],
  ["primitive JSON", () => new Response("data: null\n\n")],
  ["array JSON", () => new Response("data: []\n\n")],
  ["empty JSON object", () => sse({})],
  ["only DONE", () => new Response("data: [DONE]\n\n")],
  ["only keepalive", () => new Response(": keepalive\n\n")],
  ["only ping", () => sse({ type: "ping" })],
] as const;

for (const provider of Object.keys(models) as Provider[]) {
  test(`${provider}: HTTP 200 invalid/empty streams never succeed`, async (t) => {
    for (const [name, response] of invalidStreams) {
      await t.test(name, async () => {
        await withFetch(async () => response(), async () => {
          await assert.rejects(call(provider), (error: any) => {
            assert.match(error.message, /^Invalid response:/);
            assert.equal(classifySearchFailure(error), "invalid-response");
            return true;
          });
        });
      });
    }
  });

  test(`${provider}: normal byte-split Unicode stream needs no terminal event`, async () => {
    await withFetch(async () => byteStream(`: keepalive\r\nevent: message\r\ndata: ${JSON.stringify(answerEvent(provider))}\r\n\r\n`), async () => {
      assert.equal((await call(provider)).text, "离线 answer 🌍");
    });
  });

  test(`${provider}: empty/non-string answer fields do not manufacture a successful answer`, async () => {
    for (const text of ["", "   ", { bogus: "text" }]) {
      await withFetch(async () => sse(answerEvent(provider, text as any)), async () => {
        await assert.rejects(call(provider), /Invalid response:/);
      });
    }
  });

  test(`${provider}: malformed data after an answer still fails`, async () => {
    await withFetch(async () => new Response(`data: ${JSON.stringify(answerEvent(provider, "partial"))}\n\ndata: bad-json\n\n`), async () => {
      await assert.rejects(call(provider), /Invalid response: malformed JSON/);
    });
  });
}

test("SSE handles multiline data, CR/LF/CRLF, event reset and EOF without a blank line", async () => {
  const events: any[] = [];
  await readSseEvents(byteStream('event: ignored\r\revent: first\rdata: {\rdata: "text":"中文 🌍"}\r\r: comment\ndata: {"text":"two"}\n\ndata: {"text":"last"}'), undefined, (event) => { events.push(event); });
  assert.deepEqual(events, [
    { event: "first", data: { text: "中文 🌍" } },
    { event: "", data: { text: "two" } },
    { event: "", data: { text: "last" } },
  ]);
});

test("SSE DONE/keepalive events do not disturb ordinary answer events", async () => {
  const events: any[] = [];
  await readSseEvents(byteStream(': keepalive\n\ndata: {"text":"answer"}\n\ndata: [DONE]\n\n'), undefined, (event) => { events.push(event.data); });
  assert.deepEqual(events, [{ text: "answer" }]);
});

test("SSE callback errors propagate and early stop cancels a still-open reader", async () => {
  const failure = new Error("provider failure");
  await assert.rejects(readSseEvents(sse({ type: "error" }), undefined, () => { throw failure; }), (error) => error === failure);
  let canceled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\ndata: invalid\n\n')); },
    cancel() { canceled = true; },
  }));
  await readSseEvents(response, undefined, () => true);
  assert.equal(canceled, true);
  assert.equal(response.body?.locked, false);
});

test("SSE cancellation during a pending read preserves the abort reason", async () => {
  const controller = new AbortController();
  const reason = new DOMException("offline cancellation", "AbortError");
  let canceled = false;
  const response = new Response(new ReadableStream({ cancel() { canceled = true; } }));
  const reading = readSseEvents(response, controller.signal, () => {});
  controller.abort(reason);
  await assert.rejects(reading, (error) => error === reason);
  assert.equal(canceled, true);
  assert.equal(response.body?.locked, false);
});

test("SSE cancellation from a callback cannot turn into successful EOF/early-stop", async () => {
  const controller = new AbortController();
  const reason = new Error("The request was aborted.");
  await assert.rejects(readSseEvents(sse({ type: "text" }), controller.signal, () => {
    controller.abort(reason);
    return true;
  }), (error) => error === reason);
});

for (const code of ["too_many_requests", "max_uses_exceeded", "invalid_input", "unavailable"]) {
  for (const array of [false, true]) {
    test(`Anthropic tool error ${code} (${array ? "array" : "object"}) fails even after partial text`, async () => {
      await withFetch(async () => sse(
        { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "search-1", name: "web_search", input: {} } },
        answerEvent("anthropic", "partial answer"), toolError(code, array),
      ), async () => {
        await assert.rejects(call("anthropic"), (error: any) => {
          assert.match(error.message, new RegExp(code));
          if (code === "too_many_requests") assert.equal(classifySearchFailure(error), "rate-limit");
          if (code === "max_uses_exceeded") assert.notEqual(classifySearchFailure(error), "quota");
          return true;
        });
      });
    });
  }
}

test("Anthropic tool errors after earlier successful results still fail", async () => {
  await withFetch(async () => sse({ type: "content_block_start", content_block: {
    type: "web_search_tool_result", tool_use_id: "search-0", content: [{ type: "web_search_result", title: "Found", url: "https://found.test/" }],
  } }, toolError("too_many_requests")), async () => {
    await assert.rejects(call("anthropic"), /rate limit/);
  });
});

test("Anthropic collects interleaved input_json_delta queries from initially empty input", async () => {
  await withFetch(async () => sse(
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "search-1", name: "web_search", input: {} } },
    { type: "content_block_start", index: 2, content_block: { type: "server_tool_use", id: "search-2", name: "web_search", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"中文 ' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query":"second"}' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '🌍"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 3, content_block: { type: "web_search_tool_result", tool_use_id: "search-1", content: [
      { type: "web_search_result", title: "Example", url: "https://example.test/article" },
    ] } },
    answerEvent("anthropic", "Found it"),
  ), async () => {
    const result = await call("anthropic");
    assert.deepEqual(result.searchQueries, ["中文 🌍", "second"]);
    assert.equal(result.llmSearchCalls?.[0].status, "completed");
    assert.deepEqual(result.llmSearchCalls?.[0].raw.input, { query: "中文 🌍" });
    assert.deepEqual(result.llmSearchCalls?.[1].raw.input, { query: "second" });
    const formatted = formatWebSearchResult(result, { modelId: "claude-test" });
    assert.equal(formatted.details.grounded, true);
    assert.equal(formatted.details.resultCount, 1);
  });
});

test("Anthropic preserves initial complete tool input without deltas and applies citations", async () => {
  await withFetch(async () => sse(
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "search-1", name: "web_search", input: { query: "initial query" } } },
    answerEvent("anthropic", "A fact"),
    { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: {
      type: "web_search_result_location", title: "Fact", url: "https://example.test/fact", cited_text: "fact",
    } } },
  ), async () => {
    const result = await call("anthropic");
    assert.deepEqual(result.searchQueries, ["initial query"]);
    assert.equal(result.text, "A fact[1]");
    assert.deepEqual(result.sources, [{ title: "Fact", url: "https://example.test/fact" }]);
  });
});

test("Anthropic malformed tool input JSON cannot succeed with partial text", async () => {
  await withFetch(async () => sse(
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "search-1", name: "web_search", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":' } },
    answerEvent("anthropic", "partial"),
  ), async () => { await assert.rejects(call("anthropic"), /Invalid response: malformed Anthropic/); });
});

test("formatting legacy Anthropic error metadata does not count it as grounding/results", () => {
  const error = { type: "web_search_tool_result_error", source: "anthropic.web_search_tool_result_error", status: "max_uses_exceeded" };
  const result = formatWebSearchResult({ text: "Failed", providerKind: "anthropic", searchResults: [error] }, { modelId: "claude-test" });
  assert.equal(result.details.grounded, false);
  assert.equal(result.details.resultCount, 0);
  const mixed = formatWebSearchResult({ text: "Answer", searchResults: [error, { title: "OK", url: "https://example.test/ok" }] }, { modelId: "claude-test" });
  assert.equal(mixed.details.resultCount, 1);
});

test("Anthropic explicit Authorization is case-insensitive and suppresses API-key injection", async () => {
  const model = { ...models.anthropic, headers: { AUTHORIZATION: "Bearer offline-token" } };
  await withFetch(async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer offline-token");
    assert.equal(headers.has("x-api-key"), false);
    return sse(answerEvent("anthropic"));
  }, async () => { await callAnthropicStream(context(model), model as any, "test"); });
});

for (const provider of Object.keys(models) as Provider[]) {
  test(`${provider}: SDK null header overrides remove and suppress defaults case-insensitively`, async () => {
    const authHeader = provider === "google" ? "x-goog-api-key" : provider === "anthropic" ? "x-api-key" : "authorization";
    const model = { ...models[provider], headers: { [authHeader.toUpperCase()]: "model-key", "X-Custom": "model-custom" } };
    const ctx = context(model, { ok: true, apiKey: "offline-key", headers: {
      [authHeader]: null, "x-custom": null, "Content-Type": null, ACCEPT: null,
    } });
    await withFetch(async (_input, init) => {
      const headers = new Headers(init?.headers);
      for (const name of [authHeader, "x-custom", "Content-Type", "Accept"]) assert.equal(headers.has(name), false);
      assert.equal([...headers.values()].includes("null"), false);
      return sse(answerEvent(provider));
    }, async () => {
      if (provider === "google") await callGoogleStream(ctx, model as any, {});
      else if (provider === "anthropic") await callAnthropicStream(ctx, model as any, "test");
      else await callOpenAIStream(ctx, model as any, "test");
    });
  });
}

test("Anthropic OAuth null defaults stay suppressed rather than being injected again", async () => {
  const model = models.anthropic;
  const ctx = context(model, { ok: true, apiKey: "sk-ant-oat-offline", headers: {
    Authorization: null, "anthropic-beta": null, "User-Agent": null, "x-app": null,
  } });
  await withFetch(async (_input, init) => {
    const headers = new Headers(init?.headers);
    for (const name of ["authorization", "anthropic-beta", "user-agent", "x-app", "x-api-key"]) assert.equal(headers.has(name), false);
    return sse(answerEvent("anthropic"));
  }, async () => { await callAnthropicStream(ctx, model as any, "test"); });
});

test("Codex null account/originator headers suppress token extraction and default headers", async () => {
  const model = { ...models.openai, provider: "openai-codex", api: "openai-codex-responses" };
  const ctx = context(model, { ok: true, apiKey: "offline-not-jwt", headers: { "chatgpt-account-id": null, Originator: null } });
  await withFetch(async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("chatgpt-account-id"), false);
    assert.equal(headers.has("originator"), false);
    assert.equal(headers.get("Authorization"), "Bearer offline-not-jwt");
    return sse(answerEvent("openai"));
  }, async () => { await callOpenAIStream(ctx, model as any, "test"); });
});

function grounding(redirect = false) {
  return {
    webSearchQueries: ["offline query"],
    groundingChunks: [
      { web: { title: "First", uri: redirect ? "https://vertexaisearch.cloud.google.com/grounding-api-redirect/first" : "https://first.test/article" } },
      { web: { title: "Second", uri: redirect ? "https://vertexaisearch.cloud.google.com/grounding-api-redirect/second" : "https://second.test/article" } },
    ],
    groundingSupports: [{ segment: { text: "中文 fact", endIndex: new TextEncoder().encode("中文 fact").length }, groundingChunkIndices: [1] }],
  };
}

for (const redirect of [false, true]) {
  test(`Google citations retain grounding-chunk source order${redirect ? " after canonical redirects" : ""}`, async () => {
    const heads: string[] = [];
    await withFetch(async (input, init) => {
      if (init?.method === "HEAD") {
        heads.push(String(input));
        return new Response(null, { status: 302, headers: { location: String(input).endsWith("first")
          ? "https://first.test/article?utm_source=google#frag" : "https://second.test/article?utm_source=google#frag" } });
      }
      return sse({ candidates: [{ content: { parts: [{ text: "中文 fact" }] }, groundingMetadata: grounding(redirect) }] });
    }, async () => {
      const result = await call("google");
      assert.deepEqual(result.sources, [
        { title: "First", url: "https://first.test/article" },
        { title: "Second", url: "https://second.test/article" },
      ]);
      assert.equal(result.citations?.[0].url, "https://second.test/article");
      const resolved = resolveCitedText(result);
      assert.equal(resolved.text, "中文 fact[2]");
      assert.equal(resolved.sources[1].url, result.citations?.[0].url);
      const formatted = formatWebSearchResult(result, { modelId: "gemini-test" });
      assert.match((formatted.content[0] as any).text, /2\. \[Second\]\(https:\/\/second.test\/article\)/);
      assert.deepEqual(formatted.details.sources, resolved.sources);
      assert.equal(heads.length, redirect ? 2 : 0);
    });
  });
}

test("Google citation mapping supports non-web chunks, skipped chunks, duplicate URLs and junk filtering", () => {
  const metadata = {
    groundingChunks: [
      { ignored: { uri: "https://ignored.test" } },
      { retrievedContext: { title: "Document", uri: "https://docs.test/doc?utm_campaign=x#frag" } },
      { web: { title: "Junk", uri: "https://files.test/file.zip" } },
      { maps: { title: "Place", uri: "https://maps.test/place" } },
      { web: { title: "Document", uri: "https://docs.test/doc" } },
    ],
    groundingSupports: [{ segment: { endIndex: 4 }, groundingChunkIndices: [0, 1, 2, 3, 4, 99] }],
  };
  const result = applyCitations("Fact", metadata);
  assert.equal(result.text, "Fact[1][2]");
  assert.deepEqual(result.sources, [
    { title: "Document", url: "https://docs.test/doc" },
    { title: "Place", url: "https://maps.test/place" },
  ]);
  // A caller-supplied citations-first list must not overwrite the marker mapping.
  assert.deepEqual(resolveCitedText({ text: "Fact", groundingMetadata: metadata, sources: [...result.sources].reverse() }), result);
});

test("Google non-web retrievedContext is collected as grounding in streamed results", async () => {
  await withFetch(async () => sse({ candidates: [{ content: { parts: [{ text: "Fact" }] }, groundingMetadata: {
    groundingChunks: [{ retrievedContext: { title: "Document", uri: "https://docs.test/doc" } }],
    groundingSupports: [{ segment: { text: "Fact", endIndex: 4 }, groundingChunkIndices: [0] }],
  } }] }), async () => {
    const result = await call("google");
    assert.equal(result.searchResults?.[0].type, "retrievedContext");
    assert.equal(result.llmSearchUsed, true);
    assert.equal(resolveCitedText(result).text, "Fact[1]");
  });
});

test("Google redirect network errors keep original sources, but AbortError is rethrown", async () => {
  for (const abort of [false, true]) {
    const error = abort ? new DOMException("offline abort", "AbortError") : new Error("offline network failure");
    await withFetch(async (_input, init) => {
      if (init?.method === "HEAD") throw error;
      return sse({ candidates: [{ content: { parts: [{ text: "Fact" }] }, groundingMetadata: grounding(true) }] });
    }, async () => {
      if (abort) await assert.rejects(call("google"), (failure) => failure === error);
      else assert.match((await call("google")).sources![0].url, /grounding-api-redirect\/first/);
    });
  }
});

test("Google HEAD redirect cancellation preserves custom abort reason", async () => {
  const controller = new AbortController();
  const reason = new Error("The request was aborted during HEAD.");
  await withFetch(async (_input, init) => {
    if (init?.method === "HEAD") {
      assert.equal(init.signal, controller.signal);
      controller.abort(reason);
      throw new Error("transport canceled");
    }
    return sse({ candidates: [{ content: { parts: [{ text: "Fact" }] }, groundingMetadata: grounding(true) }] });
  }, async () => { await assert.rejects(call("google", controller.signal), (error) => error === reason); });
});

for (const provider of ["openai", "xai"] as const) {
  test(`${provider}: sources and search query metadata remain usable without a terminal event`, async () => {
    await withFetch(async () => sse({ type: "response.output_item.done", item: {
      type: "web_search_call", id: "search-1", status: "completed", action: {
        type: "search", query: "offline query", sources: [{ title: "Found", url: "https://found.test/" }],
      },
    } }), async () => {
      const result = await call(provider);
      assert.deepEqual(result.searchQueries, ["offline query"]);
      assert.equal(result.llmSearchUsed, true);
      assert.equal(result.llmSearchCalls?.[0].status, "completed");
      assert.deepEqual(result.sources, [{ title: "Found", url: "https://found.test/" }]);
    });
  });

  test(`${provider}: completed-only output snapshot is an answer, not empty success`, async () => {
    await withFetch(async () => sse({ type: "response.completed", response: { output: [{ type: "message", content: [
      { type: "output_text", text: "Fact", annotations: [{ type: "url_citation", title: "Fact", url: "https://facts.test/article", end_index: 4 }] },
    ] }] } }), async () => {
      const result = await call(provider);
      assert.equal(result.text, provider === "xai" ? "Fact" : "Fact[1]");
      assert.equal(result.sources?.[0].url, "https://facts.test/article");
    });
  });

  test(`${provider}: completed snapshot does not duplicate streamed text`, async () => {
    await withFetch(async () => sse(answerEvent(provider, "Fact"), {
      type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "Fact" }] }] },
    }), async () => { assert.equal((await call(provider)).text, "Fact"); });
  });
}

test("OpenAI Codex completed event cancels an open stream without requiring EOF", async () => {
  const model = { ...models.openai, provider: "openai-codex", api: "openai-codex-responses", headers: { "chatgpt-account-id": "offline-account" } };
  let canceled = false;
  await withFetch(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response: { output: [
        { type: "message", content: [{ type: "output_text", text: "Codex answer" }] },
      ] } })}\n\n`));
    },
    cancel() { canceled = true; },
  })), async () => {
    const result = await callOpenAIStream(context(model), model as any, "test");
    assert.equal(result.text, "Codex answer");
    assert.equal(canceled, true);
  });
});

for (const provider of Object.keys(models) as Provider[]) {
  test(`${provider}: auto mode falls back from HTTP 200 HTML to offline API`, async () => {
    await withConfig({ mode: "auto", fallbackOn: ["invalid-response"], api: { provider: "brave" } }, async () => {
      let requests = 0;
      await withFetch(async (input) => {
        requests++;
        if (String(input).includes("api.search.brave.com")) {
          return new Response(JSON.stringify({ web: { results: [{ title: "Fallback", url: "https://fallback.test/", description: "offline" }] } }));
        }
        return new Response("<html>Proxy error</html>");
      }, async () => {
        const result = await webSearch("id", { query: "test" }, new AbortController().signal, undefined, context(models[provider]), "off");
        assert.equal(result.details.modeUsed, "api");
        assert.equal(result.details.fallback.reason, "invalid-response");
        assert.equal(requests, 2);
      });
    });
  });
}

test("Anthropic too_many_requests triggers fallback; max_uses_exceeded is not global quota", async () => {
  for (const code of ["too_many_requests", "max_uses_exceeded"]) {
    await withConfig({ mode: "auto", fallbackOn: ["rate-limit", "quota"], api: { provider: "brave" } }, async () => {
      let apiRequests = 0;
      await withFetch(async (input) => {
        if (String(input).includes("api.search.brave.com")) {
          apiRequests++;
          return new Response(JSON.stringify({ web: { results: [] } }));
        }
        return sse(toolError(code));
      }, async () => {
        const result = await webSearch("id", { query: "test" }, new AbortController().signal, undefined, context(models.anthropic), "off");
        if (code === "too_many_requests") {
          assert.equal(result.details.fallback.reason, "rate-limit");
          assert.equal(apiRequests, 1);
        } else {
          assert.ok(result.details.error);
          assert.notEqual(result.details.error.kind, "quota");
          assert.equal(apiRequests, 0);
        }
      });
    });
  }
});

test("aborted Google grounding HEAD cannot trigger API fallback", async () => {
  await withConfig({ mode: "auto", fallbackOn: ["invalid-response", "network"], api: { provider: "brave" } }, async () => {
    const controller = new AbortController();
    let apiRequests = 0;
    await withFetch(async (input, init) => {
      if (String(input).includes("api.search.brave.com")) { apiRequests++; throw new Error("unexpected API fallback"); }
      if (init?.method === "HEAD") { controller.abort(); throw controller.signal.reason; }
      return sse({ candidates: [{ content: { parts: [{ text: "partial" }] }, groundingMetadata: grounding(true) }] });
    }, async () => {
      const result = await webSearch("id", { query: "test" }, controller.signal, undefined, context(models.google), "off");
      assert.equal(result.details.error.kind, "aborted");
      assert.equal(apiRequests, 0);
    });
  });
});

test("explicit LLM mode reports invalid-response without API fallback", async () => {
  await withConfig({ fallbackOn: ["invalid-response"], api: { provider: "brave" } }, async () => {
    let requests = 0;
    await withFetch(async () => { requests++; return new Response(""); }, async () => {
      const result = await webSearch("id", { query: "test", mode: "llm" }, new AbortController().signal, undefined, context(models.google), "off");
      assert.equal(result.details.error.kind, "invalid-response");
      assert.equal(requests, 1);
    });
  });
});
