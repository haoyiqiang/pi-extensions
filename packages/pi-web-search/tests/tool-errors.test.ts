import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerExtension from "../src/index.ts";

function registeredTools() {
  const tools = new Map<string, any>();
  registerExtension({
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    on() {},
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
    getThinkingLevel: () => "off",
  } as any);
  return tools;
}

async function withEnvironment(config: unknown, run: () => Promise<void>) {
  const names = ["PI_WEB_SEARCH_CONFIG", "XDG_CONFIG_HOME", "HOME", "PI_WEB_SEARCH_API_PROVIDER", "WEB_SEARCH_PROVIDER"];
  const previous = names.map((name) => process.env[name]);
  const dir = await mkdtemp(join(tmpdir(), "pi-web-search-tool-errors-"));
  process.env.PI_WEB_SEARCH_CONFIG = join(dir, "web-search.json");
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.HOME = join(dir, "home");
  delete process.env.PI_WEB_SEARCH_API_PROVIDER;
  delete process.env.WEB_SEARCH_PROVIDER;
  await writeFile(process.env.PI_WEB_SEARCH_CONFIG, JSON.stringify(config));
  try {
    await run();
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    await rm(dir, { recursive: true, force: true });
  }
}

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}

const signal = () => new AbortController().signal;

test("registered web_fetch rejects invalid targets so Pi records a failed tool", async () => {
  const tool = registeredTools().get("web_fetch");
  await assert.rejects(() => tool.execute("id", { url: "http://127.0.0.1/private" }, signal(), undefined, {}), /private\/loopback/);
});

test("registered web_search rejects unsupported models and invalid API requests", async () => {
  await withEnvironment({ fallbackOn: [] }, async () => {
    const tool = registeredTools().get("web_search");
    await assert.rejects(() => tool.execute("id", { query: "test" }, signal(), undefined, {}), /does not support LLM web search/);
    await assert.rejects(() => tool.execute("id", { query: "test", mode: "api", urls: ["https://example.com"] }, signal(), undefined, {}), /API search does not support urls/);
  });
});

test("registered url_context rejects unsupported models instead of returning success", async () => {
  await withEnvironment({}, async () => {
    const tool = registeredTools().get("url_context");
    await assert.rejects(() => tool.execute("id", { query: "test", urls: ["https://example.com"] }, signal(), undefined, {}), /url_context requires/);
  });
});

test("registered tools surface invalid config as an execution failure", async () => {
  await withEnvironment({ llm: { provider: "google" } }, async () => {
    const tools = registeredTools();
    await assert.rejects(() => tools.get("web_search").execute("id", { query: "test" }, signal(), undefined, {}), /configured together/);
    await assert.rejects(() => tools.get("url_context").execute("id", { query: "test", urls: ["https://example.com"] }, signal(), undefined, {}), /configured together/);
  });
});

test("registered web_fetch preserves successful direct HTTP output", async () => {
  await withEnvironment({ api: { provider: "brave" } }, async () => {
    await withFetch(async () => new Response("<p>page text</p>", { headers: { "content-type": "text/html" } }), async () => {
      const result = await registeredTools().get("web_fetch").execute("id", { url: "http://93.184.216.34/page" }, signal(), undefined, {});
      assert.equal(result.details.backend, "http");
      assert.match(result.content[0].text, /page text/);
    });
  });
});

test("Tavily extraction failure throws without silently falling back to direct HTTP", async () => {
  await withEnvironment({ api: { provider: "tavily", apiKeys: { tavily: "test-key" } } }, async () => {
    let calls = 0;
    await withFetch(async (url) => {
      calls += 1;
      assert.equal(String(url), "https://api.tavily.com/extract");
      return new Response(JSON.stringify({ failed_results: [{ error: "Failed to fetch url" }] }));
    }, async () => {
      await assert.rejects(() => registeredTools().get("web_fetch").execute("id", { url: "http://93.184.216.34/page" }, signal(), undefined, {}), /Tavily failed to extract/);
      assert.equal(calls, 1);
    });
  });
});

test("web_search renderer shows thrown tool errors even without error details", () => {
  const tool = registeredTools().get("web_search");
  const text = tool.renderResult(
    { content: [{ type: "text", text: "Search failed: provider unavailable" }], details: undefined },
    { expanded: false, isPartial: false },
    { fg: (_color: string, value: string) => value },
    { isError: true },
  );
  assert.match(text.render(100).join("\n"), /provider unavailable/);
});
