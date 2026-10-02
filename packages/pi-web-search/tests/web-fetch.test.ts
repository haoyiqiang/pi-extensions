import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { lookupPublicAddress } from "../src/url_safety.ts";
import { webFetch } from "../src/web_fetch.ts";

function context() {
  return {} as any;
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

async function withDirectFetch(mock: typeof fetch, run: () => Promise<void>) {
  await withConfig({ api: { provider: "brave" } }, () => withFetch(mock, run));
}

async function withConfig(config: unknown, run: () => Promise<void>) {
  const previous = process.env.PI_WEB_SEARCH_CONFIG;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "pi-web-search-fetch-test-"));
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

test("socket lookup rejects DNS names that resolve to loopback", async () => {
  await new Promise<void>((resolve, reject) => {
    lookupPublicAddress("localhost", { all: false } as any, (error) => {
      try {
        assert.ok(error);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
});

test("web_fetch rejects literal loopback URLs before network access", async () => {
  let calls = 0;
  await withFetch(async () => { calls += 1; throw new Error("unexpected"); }, async () => {
    const result = await webFetch("id", { url: "http://127.0.0.1/private" }, new AbortController().signal, undefined, context());
    assert.equal(calls, 0);
    assert.match((result.details as any).error, /127\.0\.0\.1/);
  });
});

test("web_fetch rejects mapped IPv6 and multicast literals", async () => {
  let calls = 0;
  await withFetch(async () => { calls += 1; throw new Error("unexpected"); }, async () => {
    for (const url of ["http://[::ffff:127.0.0.1]/", "http://[ff02::1]/"]) {
      const result = await webFetch("id", { url }, new AbortController().signal, undefined, context());
      assert.ok((result.details as any).error);
    }
    assert.equal(calls, 0);
  });
});

test("web_fetch follows validated redirects, disposes their bodies, and blocks private targets", async () => {
  let calls = 0;
  let cancelled = 0;
  await withDirectFetch(async () => {
    calls += 1;
    return new Response(new ReadableStream({ cancel() { cancelled += 1; } }), {
      status: 302,
      headers: { location: "http://127.0.0.1/metadata" },
    });
  }, async () => {
    const result = await webFetch("id", { url: "http://93.184.216.34/start" }, new AbortController().signal, undefined, context());
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
    assert.match((result.details as any).error, /127\.0\.0\.1/);
  });
});

test("web_fetch disposes a public redirect body before following it", async () => {
  let calls = 0;
  let cancelled = 0;
  await withDirectFetch(async (input) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(String(input), "http://93.184.216.34/start");
      return new Response(new ReadableStream({ cancel() { cancelled += 1; } }), {
        status: 302,
        headers: { location: "/final" },
      });
    }
    assert.equal(String(input), "http://93.184.216.34/final");
    return new Response("redirected content", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }, async () => {
    const result = await webFetch("id", { url: "http://93.184.216.34/start" }, new AbortController().signal, undefined, context());
    assert.equal(calls, 2);
    assert.equal(cancelled, 1);
    assert.match((result.content[0] as any).text, /redirected content/);
  });
});

test("web_fetch converts HTML to text through the built-in fetch path", async () => {
  await withDirectFetch(async () => new Response(
    "<html><head><title>Example</title><style>x{}</style></head><body><h1>Hello</h1><script>bad()</script><p>World</p></body></html>",
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  ), async () => {
    const result = await webFetch("id", { url: "http://93.184.216.34/page" }, new AbortController().signal, undefined, context());
    const text = (result.content[0] as any).text;
    assert.match(text, /Example/);
    assert.match(text, /Hello/);
    assert.match(text, /World/);
    assert.doesNotMatch(text, /bad\(\)/);
    assert.equal((result.details as any).backend, "http");
  });
});

test("web_fetch rejects an oversized declared response and disposes its body", async () => {
  let cancelled = 0;
  await withDirectFetch(async () => new Response(new ReadableStream({ cancel() { cancelled += 1; } }), {
    status: 200,
    headers: { "content-type": "text/plain", "content-length": String(10 * 1024 * 1024 + 1) },
  }), async () => {
    const result = await webFetch("id", { url: "http://93.184.216.34/oversized" }, new AbortController().signal, undefined, context());
    assert.equal(cancelled, 1);
    assert.match((result.details as any).error, /10485760/);
  });
});

test("web_fetch disposes non-OK and unsupported-content response bodies", async () => {
  let cancelled = 0;
  await withDirectFetch(async (input) => new Response(new ReadableStream({ cancel() { cancelled += 1; } }), {
    status: String(input).endsWith("/error") ? 500 : 200,
    headers: { "content-type": String(input).endsWith("/error") ? "text/plain" : "image/png" },
  }), async () => {
    const errorResult = await webFetch("id", { url: "http://93.184.216.34/error" }, new AbortController().signal, undefined, context());
    const binaryResult = await webFetch("id", { url: "http://93.184.216.34/image" }, new AbortController().signal, undefined, context());
    assert.ok((errorResult.details as any).error);
    assert.ok((binaryResult.details as any).error);
    assert.equal(cancelled, 2);
  });
});

test("web_fetch uses Ollama's original local extraction endpoint", async () => {
  const previousProvider = process.env.PI_WEB_SEARCH_API_PROVIDER;
  process.env.PI_WEB_SEARCH_API_PROVIDER = "ollama";
  try {
    await withConfig({ api: { provider: "ollama", baseUrls: { ollama: "http://localhost:11434" } } }, async () => {
      await withFetch(async (input, init) => {
        assert.equal(String(input), "http://localhost:11434/api/experimental/web_fetch");
        assert.deepEqual(JSON.parse(String(init?.body)), { url: "http://93.184.216.34/page" });
        return new Response(JSON.stringify({ title: "Ollama page", content: "extracted by Ollama" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }, async () => {
        const result = await webFetch("id", { url: "http://93.184.216.34/page" }, new AbortController().signal, undefined, context());
        assert.equal((result.details as any).backend, "ollama");
        assert.match((result.content[0] as any).text, /extracted by Ollama/);
      });
    });
  } finally {
    if (previousProvider === undefined) delete process.env.PI_WEB_SEARCH_API_PROVIDER;
    else process.env.PI_WEB_SEARCH_API_PROVIDER = previousProvider;
  }
});

test("web_fetch spills truncated content to a private temp file", async () => {
  const body = Array.from({ length: 2100 }, (_, index) => `line ${index}`).join("\n");
  await withDirectFetch(async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain", "content-length": String(body.length) },
  }), async () => {
    const result = await webFetch("id", { url: "http://93.184.216.34/large" }, new AbortController().signal, undefined, context());
    const path = (result.details as any).fullOutputPath as string;
    assert.ok(path);
    assert.equal(await readFile(path, "utf8"), body);
    await rm(dirname(path), { recursive: true, force: true });
  });
});
