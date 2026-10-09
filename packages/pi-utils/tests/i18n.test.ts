import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { withTempAgentDir } from "../index.ts";
import piI18n, {
  applyLocale,
  applyLocaleForOwner,
  createLocaleOverrideOwner,
  createTranslator,
  getLocale,
  getLocaleConfigPath,
  I18N_STATE_KEY,
  inheritLocaleForOwner,
  loadCatalog,
  parseLocalePreference,
  registerStrings,
  releaseLocaleOverrideOwner,
  resetLocaleState,
  saveLocalePreference,
  scope,
} from "../src/i18n/index.ts";
import { registerLocalesFromDir } from "../src/i18n/loader.ts";

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
  }, "pi-utils-");
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

test("persisted locale falls back to the retired pi-extensions-i18n directory", async () => {
  await withAgentDir((agentDir) => {
    const legacyDirectory = join(agentDir, "extensions", "pi-extensions-i18n");
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(join(legacyDirectory, "config.json"), JSON.stringify({ locale: "en-US" }));
    assert.equal(getLocale(), "en-US");

    const configPath = saveLocalePreference("zh-CN", agentDir);
    assert.equal(configPath, getLocaleConfigPath(agentDir));
    assert.ok(configPath.includes(join("extensions", "pi-utils")));
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).locale, "zh-CN");
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

test("child locale owners explicitly inherit without clearing the root override", async () => {
  await withAgentDir(() => {
    const root = createLocaleOverrideOwner();
    const child = createLocaleOverrideOwner();

    applyLocaleForOwner(root, "en-US");
    assert.equal(getLocale(), "en-US");

    inheritLocaleForOwner(child);
    assert.equal(getLocale(), "en-US", "a child without --locale inherits the root owner");

    applyLocaleForOwner(child, "zh-CN");
    assert.equal(getLocale(), "zh-CN");
    releaseLocaleOverrideOwner(child);
    releaseLocaleOverrideOwner(child);
    assert.equal(getLocale(), "en-US", "child cleanup restores the still-live root owner");

    releaseLocaleOverrideOwner(root);
    assert.equal(getLocale(), "zh-CN");
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

test("a child extension runtime without a locale flag inherits the root startup owner", async () => {
  await withAgentDir(() => {
    const createRuntime = (flag: string | undefined) => {
      const handlers = new Map<string, (...args: any[]) => any>();
      piI18n({
        events: createEventBus(),
        registerFlag() {},
        getFlag() { return flag; },
        on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
        registerCommand() {},
        registerEntryRenderer() {},
        appendEntry() {},
      } as any);
      return handlers;
    };

    const root = createRuntime("en-US");
    const child = createRuntime(undefined);
    root.get("session_start")?.({}, { mode: "rpc", sessionManager: {}, ui: { notify() {} } });
    assert.equal(getLocale(), "en-US");
    child.get("session_start")?.({}, { mode: "rpc", sessionManager: {}, ui: { notify() {} } });
    assert.equal(getLocale(), "en-US", "child startup must not clear the root CLI override");

    child.get("session_shutdown")?.();
    assert.equal(getLocale(), "en-US");
    root.get("session_shutdown")?.();
    assert.equal(getLocale(), "zh-CN");
  });
});

test("extension registers locale flag, aliases, and applies the startup override", async () => {
  await withAgentDir(async (agentDir) => {
    const commands = new Map<string, any>();
    const handlers = new Map<string, any>();
    const flags = new Map<string, unknown>([["locale", "en-US"]]);
    const registeredFlags: string[] = [];
    piI18n({
      events: createEventBus(),
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
    applyLocale("zh-CN");
    assert.equal(getLocale(), "en-US", "startup flag owner remains above the legacy public override");
  });
});

test("dependency entry shims share one registration per event bus and release it on shutdown", async () => {
  await withAgentDir(() => {
    const bus = createEventBus();
    const register = (events = bus) => {
      const commands: string[] = [];
      const flags: string[] = [];
      const handlers = new Map<string, () => void>();
      piI18n({
        events,
        registerFlag(name: string) { flags.push(name); },
        getFlag() {},
        on(name: string, handler: () => void) { handlers.set(name, handler); },
        registerCommand(name: string) { commands.push(name); },
        registerEntryRenderer() {},
        appendEntry() {},
      } as any);
      return { commands, flags, handlers };
    };
    const first = register();
    const duplicate = register();
    assert.equal(first.commands.length, 3);
    assert.deepEqual(first.flags, ["locale"]);
    assert.deepEqual(duplicate.commands, []);
    assert.deepEqual(duplicate.flags, []);
    assert.equal(register(createEventBus()).commands.length, 3, "an independent child runtime still registers");
    first.handlers.get("session_shutdown")?.();
    assert.equal(register().commands.length, 3, "shutdown does not leave a stale admission guard");
  });
});

test("package export keeps compatibility catalog validation", async () => {
  await withAgentDir(async (agentDir) => {
    const packageModule = await import("pi-utils");
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
