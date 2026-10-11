import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadWebSearchConfig, saveWebSearchConfig } from "../src/config.ts";
import { resolveProviderCredentials } from "../src/api_search.ts";
import { getWebSearchModel } from "../src/utils.ts";

async function withConfigEnvironment(run: (paths: {
  dir: string;
  current: string;
  legacy: string;
  homeLegacy: string;
}) => Promise<void>) {
  const previousConfig = process.env.PI_WEB_SEARCH_CONFIG;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "pi-web-search-config-test-"));
  const current = join(dir, "current", "web-search.json");
  const legacy = join(dir, "xdg", "rpiv-web-tools", "config.json");
  const homeLegacy = join(dir, "home", ".config", "rpiv-web-tools", "config.json");
  process.env.PI_WEB_SEARCH_CONFIG = current;
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.HOME = join(dir, "home");
  try {
    await run({ dir, current, legacy, homeLegacy });
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

test("loads the legacy rpiv-web-tools API config without rewriting it", async () => {
  await withConfigEnvironment(async ({ legacy }) => {
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, JSON.stringify({
      provider: "tavily",
      apiKey: "legacy-brave-key",
      apiKeys: { tavily: "tavily-key", unknown: "ignored" },
      baseUrls: { searxng: "https://search.example.test" },
      interceptors: { github: { enabled: true, maxRepoSizeMB: 200 } },
    }));

    const loaded = loadWebSearchConfig();
    assert.equal(loaded.config.api?.provider, "tavily");
    assert.equal(loaded.config.api?.apiKeys?.brave, "legacy-brave-key");
    assert.equal(loaded.config.api?.apiKeys?.tavily, "tavily-key");
    assert.equal(loaded.config.api?.baseUrls?.searxng, "https://search.example.test");
    assert.deepEqual(loaded.config.interceptors?.github, { enabled: true, maxRepoSizeMB: 200 });
  });
});

test("malformed XDG legacy config falls back to the home-directory legacy config", async () => {
  await withConfigEnvironment(async ({ legacy, homeLegacy }) => {
    await mkdir(dirname(legacy), { recursive: true });
    await mkdir(dirname(homeLegacy), { recursive: true });
    await writeFile(legacy, "{ malformed json");
    await writeFile(homeLegacy, JSON.stringify({
      provider: "tavily",
      apiKeys: { tavily: "home-tavily-key" },
    }));

    const loaded = loadWebSearchConfig();
    assert.equal(loaded.config.api?.provider, "tavily");
    assert.equal(loaded.config.api?.apiKeys?.tavily, "home-tavily-key");
  });
});

test("legacy native config loads as llm and saves only the llm shape", async () => {
  await withConfigEnvironment(async ({ current }) => {
    await mkdir(dirname(current), { recursive: true });
    await writeFile(current, JSON.stringify({
      mode: "llm",
      native: { provider: "google", model: "gemini-test", transport: "vertex-express" },
    }));

    const loaded = loadWebSearchConfig();
    assert.deepEqual(loaded.config.llm, {
      provider: "google",
      model: "gemini-test",
      transport: "vertex-express",
    });
    assert.equal(saveWebSearchConfig(loaded.config).ok, true);
    const saved = JSON.parse(await readFile(current, "utf8"));
    assert.deepEqual(saved.llm, loaded.config.llm);
    assert.equal(saved.native, undefined);
    assert.equal((await stat(current)).mode & 0o777, 0o600);
  });
});

test("the unified config overrides matching legacy API fields and keeps the rest", async () => {
  await withConfigEnvironment(async ({ current, legacy }) => {
    await mkdir(dirname(legacy), { recursive: true });
    await mkdir(dirname(current), { recursive: true });
    await writeFile(legacy, JSON.stringify({
      provider: "tavily",
      apiKeys: { tavily: "legacy-tavily", brave: "legacy-brave" },
      interceptors: { github: true },
    }));
    await writeFile(current, JSON.stringify({
      api: { provider: "brave", apiKeys: { brave: "current-brave" } },
      interceptors: { github: false },
    }));

    const loaded = loadWebSearchConfig();
    assert.equal(loaded.config.api?.provider, "brave");
    assert.equal(loaded.config.api?.apiKeys?.brave, "current-brave");
    assert.equal(loaded.config.api?.apiKeys?.tavily, "legacy-tavily");
    assert.equal(loaded.config.interceptors?.github, false);
  });
});

test("legacy modelId selects the configured model and saves the modern model field", async () => {
  await withConfigEnvironment(async ({ current }) => {
    await mkdir(dirname(current), { recursive: true });
    await writeFile(current, JSON.stringify({ provider: "google", modelId: "gemini-fixed" }));
    const configured = { provider: "google", id: "gemini-fixed", api: "google-generative-ai" } as any;
    const session = { provider: "anthropic", id: "claude-current", api: "anthropic-messages" } as any;
    const config = loadWebSearchConfig().config;
    const selected = await getWebSearchModel({
      model: session,
      modelRegistry: { find: (provider: string, id: string) => {
        assert.equal(provider, configured.provider);
        assert.equal(id, configured.id);
        return configured;
      } },
    } as any, config);
    assert.equal(selected, configured);
    assert.equal(saveWebSearchConfig(config).ok, true);
    const saved = JSON.parse(await readFile(current, "utf8"));
    assert.equal(saved.llm.model, "gemini-fixed");
    assert.equal(saved.modelId, undefined);
  });
});

test("incomplete model overrides are rejected instead of using the session model", async () => {
  await withConfigEnvironment(async ({ current }) => {
    await mkdir(dirname(current), { recursive: true });
    for (const config of [{ provider: "google" }, { modelId: "gemini-fixed" }, { llm: { model: "gemini-fixed" } }]) {
      await writeFile(current, JSON.stringify(config));
      assert.throws(() => loadWebSearchConfig(), /configured together/);
    }
    await writeFile(current, JSON.stringify({ llm: { transport: "vertex-express" } }));
    assert.equal(loadWebSearchConfig().config.llm?.transport, "vertex-express");
  });
});

test("explicit clears survive legacy merging and repeated saves", async () => {
  await withConfigEnvironment(async ({ current, legacy }) => {
    await mkdir(dirname(legacy), { recursive: true });
    await mkdir(dirname(current), { recursive: true });
    const legacyText = JSON.stringify({
      provider: "tavily",
      apiKeys: { tavily: "legacy-key", brave: "other-key" },
      baseUrls: { searxng: "http://legacy.invalid:8888" },
    });
    await writeFile(legacy, legacyText);
    await writeFile(current, JSON.stringify({ api: { apiKeys: { tavily: null }, baseUrls: { searxng: null } } }));
    for (let round = 0; round < 2; round += 1) {
      const config = loadWebSearchConfig().config;
      assert.equal(config.api?.apiKeys?.tavily, null);
      assert.equal(config.api?.apiKeys?.brave, "other-key");
      assert.equal(config.api?.baseUrls?.searxng, null);
      assert.equal(saveWebSearchConfig(config).ok, true);
    }
    assert.equal(await readFile(legacy, "utf8"), legacyText);
    const saved = JSON.parse(await readFile(current, "utf8"));
    assert.equal(saved.api.apiKeys.tavily, null);
    assert.equal(saved.api.baseUrls.searxng, null);
  });
});

test("cleared legacy credentials remain unset but explicit environment credentials still win", async () => {
  const previous = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  try {
    assert.equal(resolveProviderCredentials({ api: { apiKeys: { tavily: null } } }, "tavily").apiKey, undefined);
    process.env.TAVILY_API_KEY = "environment-key";
    assert.equal(resolveProviderCredentials({ api: { apiKeys: { tavily: null } } }, "tavily").apiKey, "environment-key");
  } finally {
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
  }
});

test("invalid-shaped XDG legacy config does not mask valid home-directory config", async () => {
  await withConfigEnvironment(async ({ legacy, homeLegacy }) => {
    await mkdir(dirname(legacy), { recursive: true });
    await mkdir(dirname(homeLegacy), { recursive: true });
    await writeFile(homeLegacy, JSON.stringify({ provider: "tavily" }));
    for (const value of [null, [], {}]) {
      await writeFile(legacy, JSON.stringify(value));
      assert.equal(loadWebSearchConfig().config.api?.provider, "tavily");
    }
  });
});
