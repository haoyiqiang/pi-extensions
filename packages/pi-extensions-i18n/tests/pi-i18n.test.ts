import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { withTempAgentDir } from "@maplezzk/pi-test-utils";
import piI18n, {
  applyLocale,
  createTranslator,
  getLocale,
  getLocaleConfigPath,
  I18N_STATE_KEY,
  loadCatalog,
  parseLocalePreference,
  registerStrings,
  resetLocaleState,
  saveLocalePreference,
  scope,
} from "../src/index.ts";
import { registerLocalesFromDir } from "../src/loader.ts";

async function withAgentDir(run: (agentDir: string) => void | Promise<void>): Promise<void> {
  const previousLocale = process.env.PI_EXTENSIONS_LOCALE;
  await withTempAgentDir(async (agentDir) => {
    delete process.env.PI_EXTENSIONS_LOCALE;
    resetLocaleState();
    try {
      await run(agentDir);
    } finally {
      resetLocaleState();
      if (previousLocale === undefined) delete process.env.PI_EXTENSIONS_LOCALE;
      else process.env.PI_EXTENSIONS_LOCALE = previousLocale;
    }
  }, "pi-extensions-i18n-");
}

test("compatibility catalogs follow persisted and environment locale changes", async () => {
  await withAgentDir((agentDir) => {
    assert.equal(parseLocalePreference("zh"), "zh-CN");
    assert.equal(parseLocalePreference("en-US"), "en-US");
    assert.equal(parseLocalePreference("auto"), "auto");
    assert.equal(parseLocalePreference("fr"), undefined);
    assert.equal(getLocale(), "zh-CN");

    const translator = createTranslator({
      greeting: { "zh-CN": "你好，{name}", "en-US": "Hello, {name}" },
    });
    assert.equal(translator.t("greeting", { name: "Pi" }), "你好，Pi");

    const configPath = saveLocalePreference("en-US");
    assert.equal(configPath, getLocaleConfigPath(agentDir));
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).locale, "en-US");
    assert.equal(translator.t("greeting", { name: "Pi" }), "Hello, Pi");

    process.env.PI_EXTENSIONS_LOCALE = "zh-CN";
    assert.equal(getLocale(), "zh-CN");
  });
});

test("namespaced registry switches at render time and falls back to English", async () => {
  await withAgentDir(() => {
    registerStrings("example", {
      "en-US": { greeting: "Hello {name}", englishOnly: "English only" },
      "zh-CN": { greeting: "你好 {name}" },
    });
    const t = scope("example");
    applyLocale("zh-CN");
    assert.equal(t("greeting", "fallback", { name: "Pi" }), "你好 Pi");
    assert.equal(t("englishOnly", "fallback"), "English only");

    const snapshot = (globalThis as unknown as { [I18N_STATE_KEY]: { locale: string; namespaces: Record<string, unknown> } })[I18N_STATE_KEY];
    assert.equal(snapshot.locale, "zh-CN");
    assert.ok(snapshot.namespaces.example);
  });
});

test("locale directory loader registers flat locale files and reports missing files", async () => {
  await withAgentDir((agentDir) => {
    const localeDir = join(agentDir, "locales");
    mkdirSync(localeDir, { recursive: true });
    writeFileSync(join(localeDir, "en-US.json"), JSON.stringify({ saved: "Saved" }));
    const result = registerLocalesFromDir("loader-example", pathToFileURL(`${localeDir}/`));
    assert.deepEqual(result.loaded, ["en-US"]);
    assert.equal(result.diagnostics.length, 1);
    applyLocale("zh-CN");
    assert.equal(scope("loader-example")("saved", "fallback"), "Saved");
  });
});

test("extension registers locale flag, aliases, and applies the startup override", async () => {
  await withAgentDir(async (agentDir) => {
    const commands = new Map<string, any>();
    const handlers = new Map<string, any>();
    const flags = new Map<string, unknown>([["locale", "en-US"]]);
    const registeredFlags: string[] = [];
    piI18n({
      registerFlag(name: string) {
        registeredFlags.push(name);
      },
      getFlag(name: string) {
        return flags.get(name);
      },
      on(name: string, handler: unknown) {
        handlers.set(name, handler);
      },
      registerCommand(name: string, options: unknown) {
        commands.set(name, options);
      },
      registerEntryRenderer() {},
      appendEntry() {},
    } as any);

    assert.deepEqual(registeredFlags, ["locale"]);
    assert.ok(commands.has("config:language"));
    assert.ok(commands.has("languages"));
    assert.ok(commands.has("pi-language"));

    handlers.get("session_start")({}, {
      hasUI: true,
      ui: { notify() {} },
    });
    assert.equal(getLocale(), "en-US");

    await commands.get("config:language").handler("zh-CN", {
      hasUI: true,
      ui: { select: async () => undefined, notify() {} },
    });
    assert.equal(JSON.parse(readFileSync(getLocaleConfigPath(agentDir), "utf8")).locale, "zh-CN");
    assert.equal(getLocale(), "en-US", "startup flag remains the highest-priority override");
  });
});

test("package export keeps compatibility catalog validation", async () => {
  await withAgentDir(async (agentDir) => {
    const packageModule = await import("pi-extensions-i18n");
    assert.equal(typeof packageModule.createTranslator, "function");
    const catalogPath = join(agentDir, "test-catalog.json");
    writeFileSync(catalogPath, JSON.stringify({ request: { "zh-CN": "请求", "en-US": "Request" } }));
    const catalog = loadCatalog(catalogPath);
    assert.equal(createTranslator(catalog).t("request"), "请求");

    const invalidCatalogPath = join(agentDir, "invalid-catalog.json");
    writeFileSync(invalidCatalogPath, JSON.stringify({ incomplete: { "zh-CN": "only one locale" } }));
    assert.throws(() => loadCatalog(invalidCatalogPath), /Invalid i18n catalog entry incomplete/);
  });
});
