import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerExtension, { createModelScopedToolManager } from "../src/index.ts";
import { urlContext } from "../src/url_context.ts";
import { webSearch } from "../src/web_search.ts";

const googleModel = {
  id: "gemini-test",
  provider: "google",
  api: "google-generative-ai",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  headers: {},
};

const anthropicModel = {
  id: "claude-test",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  headers: {},
  maxTokens: 4096,
};

function context(model: any = googleModel, models: any[] = model ? [model] : []) {
  return {
    model,
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "test-key" };
      },
      getAvailable() {
        return models;
      },
      find(provider: string, id: string) {
        return models.find((candidate) => candidate.provider === provider && candidate.id === id);
      },
    },
    sessionManager: { getSessionId: () => "session-test" },
  } as any;
}

function sse(...chunks: any[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function textOf(result: any): string {
  return result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}

async function withConfig(config: unknown, run: () => Promise<void>) {
  const previous = process.env.PI_WEB_SEARCH_CONFIG;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "pi-web-search-test-"));
  const path = join(dir, "web-search.json");
  process.env.PI_WEB_SEARCH_CONFIG = path;
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.HOME = join(dir, "home");
  await writeFile(path, JSON.stringify(config));
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
    else process.env.PI_WEB_SEARCH_CONFIG = previous;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
}

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("registers exactly three tools and the web-search config command", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const handlers: Record<string, Function[]> = {};
  const pi = {
    registerTool(tool: any) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
    on(name: string, handler: Function) { (handlers[name] ??= []).push(handler); },
    getActiveTools() { return [...tools]; },
    setActiveTools() {},
    getThinkingLevel() { return "off"; },
  } as any;
  registerExtension(pi);
  assert.deepEqual(tools.sort(), ["url_context", "web_fetch", "web_search"]);
  assert.deepEqual(commands, ["config:web-search"]);
});

test("url_context stays active when the configured LLM is Google", async () => {
  await withConfig({ llm: { provider: "google", model: "gemini-test", transport: "vertex-express" } }, async () => {
    let active = ["web_search", "url_context", "web_fetch"];
    const manager = createModelScopedToolManager({
      getActiveTools: () => [...active],
      setActiveTools: (tools: string[]) => { active = tools; },
    } as any);
    manager.sync(anthropicModel as any, {
      modelRegistry: {
        find(provider: string, id: string) {
          return provider === "google" && id === "gemini-test" ? googleModel : undefined;
        },
      },
    } as any);
    assert.ok(active.includes("url_context"));
  });
});

test("llm mode returns the discriminated LLM schema", async () => {
  await withConfig({ mode: "llm" }, async () => {
    await withFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.tools, [{ google_search: {} }]);
      return sse({ candidates: [{ content: { parts: [{ text: "Grounded answer" }] } }] });
    }, async () => {
      const result = await webSearch("id", { query: "hello", mode: "llm" }, new AbortController().signal, undefined, context(), "off");
      assert.equal(result.details.modeRequested, "llm");
      assert.equal(result.details.modeUsed, "llm");
      assert.equal(result.details.providerKind, "google");
      assert.equal(result.details.model, "gemini-test");
      assert.equal(result.details.llmSearchUsed, false);
      assert.equal("nativeSearchUsed" in result.details, false);
      assert.match(textOf(result), /Grounded answer/);
    });
  });
});

test("explicit Google transports do not disable Anthropic LLM search", async () => {
  for (const transport of ["google-developer", "vertex-express"]) {
    await withConfig({ mode: "llm", llm: { transport } }, async () => {
      await withFetch(async (input, init) => {
        assert.equal(String(input), "https://api.anthropic.com/v1/messages");
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }]);
        return sse({
          type: "content_block_start",
          content_block: { type: "text", text: `Anthropic answer via ${transport}` },
        });
      }, async () => {
        const result = await webSearch(
          "id",
          { query: "hello", mode: "llm" },
          new AbortController().signal,
          undefined,
          context(anthropicModel),
          "off",
        );
        assert.equal(result.details.modeUsed, "llm");
        assert.equal(result.details.providerKind, "anthropic");
        assert.match(textOf(result), new RegExp(`Anthropic answer via ${transport}`));
      });
    });
  }
});

test("api mode returns title, URL, snippet, sources, and backend", async () => {
  const previous = process.env.BRAVE_SEARCH_API_KEY;
  process.env.BRAVE_SEARCH_API_KEY = "brave-key";
  try {
    await withConfig({ mode: "api", api: { provider: "brave" } }, async () => {
      await withFetch(async (input, init) => {
        assert.match(String(input), /api\.search\.brave\.com/);
        assert.equal((init?.headers as Record<string, string>)["X-Subscription-Token"], "brave-key");
        return new Response(JSON.stringify({
          web: { results: [{ title: "Example", url: "https://example.com", description: "Snippet" }] },
        }), { status: 200 });
      }, async () => {
        const result = await webSearch("id", { query: "hello", mode: "api" }, new AbortController().signal, undefined, context(), "off");
        assert.deepEqual(result.details, {
          query: "hello",
          modeRequested: "api",
          modeUsed: "api",
          backend: "brave",
          resultCount: 1,
          results: [{ title: "Example", url: "https://example.com", snippet: "Snippet" }],
          sources: [{ title: "Example", url: "https://example.com" }],
        });
      });
    });
  } finally {
    if (previous === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = previous;
  }
});

test("auto falls back from unsupported LLM search to one API provider", async () => {
  const previous = process.env.BRAVE_SEARCH_API_KEY;
  process.env.BRAVE_SEARCH_API_KEY = "brave-key";
  try {
    await withConfig({ mode: "auto", fallbackOn: ["unsupported"], api: { provider: "brave" } }, async () => {
      await withFetch(async () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }), async () => {
        const result = await webSearch("id", { query: "hello" }, new AbortController().signal, undefined, context(null, []), "off");
        assert.equal(result.details.modeRequested, "auto");
        assert.equal(result.details.modeUsed, "api");
        assert.equal(result.details.backend, "brave");
        assert.equal(result.details.fallback.reason, "unsupported");
      });
    });
  } finally {
    if (previous === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = previous;
  }
});

test("explicit llm mode never falls back", async () => {
  await withConfig({ mode: "auto", fallbackOn: ["unsupported"], api: { provider: "brave" } }, async () => {
    let calls = 0;
    await withFetch(async () => { calls += 1; throw new Error("unexpected"); }, async () => {
      const result = await webSearch("id", { query: "hello", mode: "llm" }, new AbortController().signal, undefined, context(null, []), "off");
      assert.equal(result.details.error.kind, "unsupported");
      assert.equal(calls, 0);
    });
  });
});

test("failed API fallback reports both attempts and the resolved backend", async () => {
  const previous = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    await withConfig({ mode: "auto", fallbackOn: ["unsupported"], api: { provider: "brave" } }, async () => {
      const result = await webSearch("id", { query: "hello" }, new AbortController().signal, undefined, context(null, []), "off");
      assert.equal(result.details.error.stage, "fallback");
      assert.equal(result.details.attempts[0].mode, "llm");
      assert.equal(result.details.attempts[1].backend, "brave");
      assert.match(textOf(result), /brave/);
      assert.match(textOf(result), /BRAVE_SEARCH_API_KEY/);
    });
  } finally {
    if (previous === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = previous;
  }
});

test("Vertex Express URL context uses the raw Vertex SSE endpoint", async () => {
  await withConfig({
    llm: { provider: "google", model: "gemini-test", transport: "vertex-express" },
  }, async () => {
    await withFetch(async (input, init) => {
      assert.equal(String(input), "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-test:streamGenerateContent?alt=sse");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-goog-api-key"], "test-key");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.tools, [{ urlContext: {} }]);
      assert.match(body.contents[0].parts.at(-1).text, /https:\/\/example\.com/);
      return sse({ candidates: [{ content: { parts: [{ text: "Vertex URL answer" }] }, urlContextMetadata: {
        urlMetadata: [{ retrievedUrl: "https://example.com", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }],
      } }] });
    }, async () => {
      const result = await urlContext("id", { query: "read", urls: ["https://example.com"] }, new AbortController().signal, undefined, context());
      assert.match(textOf(result), /Vertex URL answer/);
      assert.deepEqual(result.details.retrieved, ["https://example.com"]);
    });
  });
});

test("Vertex Express refuses to route a non-Google model to the Vertex endpoint", async () => {
  await withConfig({ llm: { transport: "vertex-express" } }, async () => {
    let calls = 0;
    await withFetch(async () => { calls += 1; throw new Error("unexpected"); }, async () => {
      const result = await urlContext("id", { query: "read", urls: ["https://example.com"] }, new AbortController().signal, undefined, context(anthropicModel));
      assert.equal(result.details.error, "unsupported_provider");
      assert.equal(calls, 0);
    });
  });
});

test("Vertex Express URL context sends YouTube as fileData", async () => {
  await withConfig({
    llm: { provider: "google", model: "gemini-test", transport: "vertex-express" },
  }, async () => {
    await withFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.contents[0].parts[0], {
        fileData: {
          fileUri: "https://www.youtube.com/watch?v=tUPPVhBBcoM",
          mimeType: "video/mp4",
        },
      });
      return sse({ candidates: [{ content: { parts: [{ text: "Video answer" }] } }] });
    }, async () => {
      const result = await urlContext("id", {
        query: "summarize",
        urls: ["https://www.youtube.com/watch?v=tUPPVhBBcoM"],
      }, new AbortController().signal, undefined, context());
      assert.match(textOf(result), /Video answer/);
    });
  });
});

test("URL context rejects multiple YouTube videos before making a request", async () => {
  await withConfig({
    llm: { provider: "google", model: "gemini-test", transport: "vertex-express" },
  }, async () => {
    let calls = 0;
    await withFetch(async () => { calls += 1; throw new Error("unexpected"); }, async () => {
      const result = await urlContext("id", {
        query: "compare",
        urls: [
          "https://www.youtube.com/watch?v=tUPPVhBBcoM",
          "https://youtu.be/dQw4w9WgXcQ",
        ],
      }, new AbortController().signal, undefined, context());
      assert.equal(result.details.error, "invalid_request");
      assert.equal(result.details.youtubeUrlCount, 2);
      assert.equal(calls, 0);
    });
  });
});
