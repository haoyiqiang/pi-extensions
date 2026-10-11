import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { openWebSearchConfigPanel } from "../src/config-panel.ts";
import { loadWebSearchConfig, saveWebSearchConfig } from "../src/config.ts";

async function withPanelEnvironment(run: (path: string) => Promise<void>) {
  const previousConfig = process.env.PI_WEB_SEARCH_CONFIG;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "pi-web-search-panel-test-"));
  const path = join(dir, "agent", "web-search.json");
  process.env.PI_WEB_SEARCH_CONFIG = path;
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.HOME = join(dir, "home");
  try {
    await run(path);
  } finally {
    if (previousConfig === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
    else process.env.PI_WEB_SEARCH_CONFIG = previousConfig;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
}

function panelContext(select: (title: string, choices: string[]) => Promise<string | undefined>, input?: (title: string, placeholder: string) => Promise<string | undefined>) {
  const notices: Array<{ message: string; level?: string }> = [];
  return {
    notices,
    ctx: {
      hasUI: true,
      mode: "rpc",
      model: {
        provider: "google",
        id: "gemini-test",
        api: "google-generative-ai",
        baseUrl: "https://example.invalid",
      },
      modelRegistry: {
        getAvailable() {
          return [];
        },
      },
      ui: {
        select,
        input: input ?? (async () => undefined),
        notify(message: string, level?: string) {
          notices.push({ message, level });
        },
      },
    } as any,
  };
}

test("configuration panel changes mode and persists the modern config", async () => {
  await withPanelEnvironment(async (path) => {
    let call = 0;
    const { ctx, notices } = panelContext(async (_title, choices) => {
      call += 1;
      if (call === 1) return choices[0];
      if (call === 2) return choices[2];
      return choices.at(-1);
    });
    let saved = 0;
    await openWebSearchConfigPanel(ctx, { onSaved: () => { saved += 1; } });

    const config = JSON.parse(await readFile(path, "utf8"));
    assert.equal(config.mode, "api");
    assert.equal(config.native, undefined);
    assert.equal(saved, 1);
    assert.ok(notices.some((notice) => notice.level === "info"));
  });
});

test("configuration panel toggles the GitHub repository interceptor", async () => {
  await withPanelEnvironment(async (path) => {
    let call = 0;
    const { ctx } = panelContext(async (_title, choices) => {
      call += 1;
      if (call === 1) return choices.find((choice) => choice.includes("GitHub"));
      return choices.at(-1);
    });
    await openWebSearchConfigPanel(ctx);

    const config = JSON.parse(await readFile(path, "utf8"));
    assert.equal(config.interceptors.github, true);
  });
});

test("configuration panel selects an API provider and stores its credential", async () => {
  await withPanelEnvironment(async (path) => {
    let call = 0;
    const { ctx } = panelContext(
      async (_title, choices) => {
        call += 1;
        if (call === 1) return choices[3];
        if (call === 2) return choices.find((choice) => choice.includes("Tavily"));
        if (call === 3) return choices[4];
        return choices.at(-1);
      },
      async () => "tavily-panel-key",
    );
    await openWebSearchConfigPanel(ctx);

    const config = JSON.parse(await readFile(path, "utf8"));
    assert.equal(config.api.provider, "tavily");
    assert.equal(config.api.apiKeys.tavily, "tavily-panel-key");
  });
});

test("clearing a legacy API key in the panel remains cleared after reload and another save", async () => {
  await withPanelEnvironment(async (path) => {
    const legacy = join(process.env.XDG_CONFIG_HOME!, "rpiv-web-tools", "config.json");
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, JSON.stringify({ provider: "tavily", apiKeys: { tavily: "legacy-key" } }));
    let calls = 0;
    const { ctx } = panelContext(async (_title, choices) => {
      if (++calls === 1) return choices.find((choice) => choice.startsWith("API credential:"));
      return choices.at(-1);
    }, async () => "-");
    await openWebSearchConfigPanel(ctx);
    assert.equal(loadWebSearchConfig().config.api?.apiKeys?.tavily, null);
    assert.equal(saveWebSearchConfig({ ...loadWebSearchConfig().config, mode: "api" }).ok, true);
    assert.equal(loadWebSearchConfig().config.api?.apiKeys?.tavily, null);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.api.apiKeys.tavily, null);
  });
});

test("clearing a legacy base URL restores the default instead of the legacy URL", async () => {
  await withPanelEnvironment(async (path) => {
    const legacy = join(process.env.XDG_CONFIG_HOME!, "rpiv-web-tools", "config.json");
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, JSON.stringify({ provider: "searxng", baseUrls: { searxng: "http://legacy.invalid:8888" } }));
    let calls = 0;
    const { ctx } = panelContext(async (_title, choices) => {
      if (++calls === 1) return choices.find((choice) => choice.startsWith("API base URL:"));
      assert.ok(choices.some((choice) => choice === "API base URL: http://localhost:8080"));
      return choices.at(-1);
    }, async () => "-");
    await openWebSearchConfigPanel(ctx);
    assert.equal(loadWebSearchConfig().config.api?.baseUrls?.searxng, null);
    assert.equal(JSON.parse(await readFile(path, "utf8")).api.baseUrls.searxng, null);
  });
});
