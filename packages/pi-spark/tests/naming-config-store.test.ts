import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withTempAgentDir } from "pi-utils";
import { applyLocale, clearLocaleOverride } from "pi-utils";
import { clearConfigCache, loadConfig } from "../src/config/index.ts";
import { loadNamingConfig, namingConfigPath, saveNamingConfig } from "../src/config/naming-store.ts";
import { projectSparkConfigPath, readConfigObject, sparkConfigPath } from "../src/config/store.ts";
import { parseConfig } from "../src/features/naming/config.ts";

interface Fixture {
  ctx: ExtensionContext;
  globalPath: string;
  projectPath: string;
  legacyPath: string;
  notices: Array<{ message: string; level?: string }>;
}

async function withConfig(run: (fixture: Fixture) => void): Promise<void> {
  await withTempAgentDir((agentDir) => {
    clearConfigCache();
    const notices: Fixture["notices"] = [];
    const cwd = join(agentDir, "project");
    const ctx = {
      cwd,
      ui: { notify(message: string, level?: string) { notices.push({ message, level }); } },
    } as ExtensionContext;
    try {
      run({ ctx, globalPath: sparkConfigPath(agentDir), projectPath: projectSparkConfigPath(cwd),
        legacyPath: join(agentDir, "extensions", "pi-naming", "config.json"), notices });
    } finally {
      clearConfigCache();
    }
  }, "pi-spark-naming-");
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value));
}

test("missing canonical and legacy configs resolve full naming defaults without creating files", async () => {
  await withConfig(({ ctx, globalPath, projectPath, legacyPath, notices }) => {
    assert.deepEqual(loadNamingConfig(ctx), parseConfig({}));
    assert.equal(namingConfigPath(ctx), globalPath);
    assert.equal(existsSync(globalPath), false);
    assert.equal(existsSync(projectPath), false);
    assert.equal(existsSync(legacyPath), false);
    assert.deepEqual(notices, []);
  });
});

test("legacy naming is a read-only fallback when both canonical files omit naming", async () => {
  await withConfig(({ ctx, globalPath, projectPath, legacyPath, notices }) => {
    const legacy = { automaticNaming: false, targets: { workspace: false }, title: { maxTokens: 4096 } };
    writeJson(legacyPath, legacy);
    writeJson(globalPath, { footer: false });
    writeJson(projectPath, { metrics: false });
    const before = readFileSync(legacyPath, "utf8");
    assert.deepEqual(loadNamingConfig(ctx), parseConfig(legacy));
    assert.equal(loadConfig(ctx).footer, false);
    assert.equal(loadConfig(ctx).metrics, false);
    assert.equal(readFileSync(legacyPath, "utf8"), before);
    assert.deepEqual(notices, []);
  });
});

for (const scope of ["global", "project"] as const) {
  test(`${scope} partial canonical naming suppresses all legacy fields`, async () => {
    await withConfig(({ ctx, globalPath, projectPath, legacyPath, notices }) => {
      writeJson(legacyPath, { automaticNaming: false, manualNaming: false, title: { maxTokens: 8192 } });
      writeJson(scope === "global" ? globalPath : projectPath, { naming: { targets: { tab: false } } });
      assert.deepEqual(loadNamingConfig(ctx), parseConfig({ targets: { tab: false } }));
      assert.deepEqual(notices, []);
    });
  });

  test(`${scope} canonical naming ignores a malformed legacy file, including explicit false`, async () => {
    await withConfig(({ ctx, globalPath, projectPath, legacyPath, notices }) => {
      writeText(legacyPath, "{");
      const path = scope === "global" ? globalPath : projectPath;
      for (const naming of [{}, false]) {
        clearConfigCache();
        writeJson(path, { naming });
        assert.deepEqual(loadNamingConfig(ctx), naming === false ? false : parseConfig({}));
      }
      assert.deepEqual(notices, []);
      assert.equal(readFileSync(legacyPath, "utf8"), "{");
    });
  });

  test(`${scope} invalid canonical file disables naming without suppressing the other file's features`, async () => {
    await withConfig(({ ctx, globalPath, projectPath, legacyPath, notices }) => {
      writeJson(legacyPath, {});
      const path = scope === "global" ? globalPath : projectPath;
      writeJson(scope === "global" ? projectPath : globalPath, { naming: {}, footer: false, metrics: { display: "live" } });
      for (const text of ["{", "null", "[]", "false", "1", '"string"']) {
        clearConfigCache();
        notices.length = 0;
        writeText(path, text);
        assert.equal(loadNamingConfig(ctx), false, text);
        assert.equal(loadConfig(ctx).footer, false);
        assert.deepEqual(loadConfig(ctx).metrics, { display: "live" });
        assert.equal(notices.length, 1);
        assert.equal(notices[0].level, "error");
        assert.ok(notices[0].message.includes(path));
        assert.match(notices[0].message, /\[spark\]/);
      }
    });
  });

  test(`${scope} invalid naming values fail closed and never revive legacy or global defaults`, async () => {
    await withConfig(({ ctx, globalPath, projectPath, legacyPath, notices }) => {
      writeJson(legacyPath, {});
      const path = scope === "global" ? globalPath : projectPath;
      if (scope === "project") writeJson(globalPath, { naming: parseConfig({}) });
      for (const naming of [null, [], true, "false", 1, { unknown: true }, { title: null }, { targets: null },
        { title: { timeoutMs: null } }, { automaticNaming: null }, { title: { maxTokens: 0 } },
        { title: { timeoutMs: 2_147_483_648 } }, { title: { preferredLength: 16 } }, { title: { maxLength: 1.5 } }]) {
        clearConfigCache();
        notices.length = 0;
        writeJson(path, { naming, footer: false });
        assert.equal(loadNamingConfig(ctx), false, JSON.stringify(naming));
        assert.equal(loadConfig(ctx).footer, false);
        assert.equal(notices.length, 1);
        assert.equal(notices[0].level, "error");
        assert.match(notices[0].message, /field|字段/);
      }
    });
  });
}

test("invalid legacy JSON, shapes and fields fail closed without disabling sibling features", async () => {
  await withConfig(({ ctx, globalPath, legacyPath, notices }) => {
    writeJson(globalPath, { footer: false });
    for (const text of ["{", "[]", "false", "null", '{"unknown":true}', '{"title":{"maxTokens":0}}']) {
      clearConfigCache();
      notices.length = 0;
      writeText(legacyPath, text);
      assert.equal(loadNamingConfig(ctx), false, text);
      assert.equal(loadConfig(ctx).footer, false);
      assert.equal(notices.length, 1);
      assert.ok(notices[0].message.includes(legacyPath));
      assert.equal(readFileSync(legacyPath, "utf8"), text);
    }
  });
});

test("unreadable canonical and legacy paths fail closed", async () => {
  for (const source of ["globalPath", "projectPath", "legacyPath"] as const) {
    await withConfig((fixture) => {
      mkdirSync(fixture[source], { recursive: true });
      assert.equal(loadNamingConfig(fixture.ctx), false);
      assert.equal(fixture.notices.length, 1);
      assert.ok(fixture.notices[0].message.includes(fixture[source]));
    });
  }
});

test("naming errors use the Spark source and localized naming diagnostics in both locales", async () => {
  try {
    for (const [locale, pattern] of [["en-US", /Invalid configuration field/], ["zh-CN", /配置字段无效/]] as const) {
      applyLocale(locale);
      await withConfig(({ ctx, globalPath, notices }) => {
        writeJson(globalPath, { naming: { typo: true } });
        assert.equal(loadNamingConfig(ctx), false);
        assert.match(notices[0].message, pattern);
        assert.match(notices[0].message, /\[spark\]/);
        assert.equal(notices[0].level, "error");
        loadNamingConfig(ctx);
        assert.equal(notices.length, 1, "cached invalid config must not repeat notices");
      });
    }
  } finally {
    clearLocaleOverride();
  }
});

test("project naming merges global leaves before defaults and cross-field validation", async () => {
  await withConfig(({ ctx, globalPath, projectPath, notices }) => {
    writeJson(globalPath, {
      naming: { automaticNaming: false, targets: { workspace: false, tab: false },
        title: { maxLength: 60, preferredLength: 40, maxTokens: 4096, instructions: "Sentence case" } },
      footer: false,
    });
    writeJson(projectPath, { naming: { manualNaming: false, targets: { tab: true }, title: { preferredLength: 50, language: "English" } } });
    assert.deepEqual(loadNamingConfig(ctx), parseConfig({
      automaticNaming: false, manualNaming: false, targets: { workspace: false, tab: true },
      title: { maxLength: 60, preferredLength: 50, maxTokens: 4096, instructions: "Sentence case", language: "English" },
    }));
    assert.equal(loadConfig(ctx).footer, false);
    assert.deepEqual(notices, []);
  });
});

test("project false disables global naming while a project object overrides global false", async () => {
  await withConfig(({ ctx, globalPath, projectPath, notices }) => {
    writeJson(globalPath, { naming: { manualNaming: false } });
    writeJson(projectPath, { naming: false });
    assert.equal(loadNamingConfig(ctx), false);
    clearConfigCache();
    writeJson(globalPath, { naming: false });
    writeJson(projectPath, { naming: { title: { maxTokens: 1234 } } });
    assert.deepEqual(loadNamingConfig(ctx), parseConfig({ title: { maxTokens: 1234 } }));
    assert.deepEqual(notices, []);
  });
});

test("saving migrates into global Spark, preserves siblings and invalidates cached legacy config", async () => {
  await withConfig(({ ctx, globalPath, projectPath, legacyPath }) => {
    writeJson(legacyPath, { automaticNaming: false });
    writeJson(globalPath, { footer: false, unrelated: { keep: true } });
    writeJson(projectPath, { metrics: false });
    const legacyBefore = readFileSync(legacyPath, "utf8");
    const projectBefore = readFileSync(projectPath, "utf8");
    assert.deepEqual(loadNamingConfig(ctx), parseConfig({ automaticNaming: false }));
    const next = parseConfig({ title: { maxTokens: 1234 } });
    assert.equal(saveNamingConfig(next, ctx), globalPath);
    assert.deepEqual(readConfigObject(globalPath), { footer: false, unrelated: { keep: true }, naming: next });
    assert.deepEqual(loadNamingConfig(ctx), next);
    assert.equal(readFileSync(legacyPath, "utf8"), legacyBefore);
    assert.equal(readFileSync(projectPath, "utf8"), projectBefore);
    assert.ok(readdirSync(dirname(globalPath)).every((file) => !file.endsWith(".tmp")));
  });
});

test("project-owned naming edits and reset replace its override without writing global or legacy", async () => {
  await withConfig(({ ctx, globalPath, projectPath, legacyPath }) => {
    writeJson(globalPath, { naming: { automaticNaming: false, targets: { workspace: false }, title: { maxTokens: 8192 } }, footer: false });
    writeJson(projectPath, { naming: false, metrics: false, unrelated: { keep: true } });
    writeJson(legacyPath, { automaticNaming: false });
    const globalBefore = readFileSync(globalPath, "utf8");
    const legacyBefore = readFileSync(legacyPath, "utf8");
    assert.equal(loadNamingConfig(ctx), false);
    assert.equal(namingConfigPath(ctx), projectPath);
    const next = parseConfig({ manualNaming: false, title: { effort: "high" } });
    assert.equal(saveNamingConfig(next, ctx), projectPath);
    assert.deepEqual(loadNamingConfig(ctx), next);
    const defaults = parseConfig({});
    assert.equal(saveNamingConfig(defaults, ctx), projectPath);
    assert.deepEqual(loadNamingConfig(ctx), defaults, "reset must not re-inherit non-default global leaves");
    assert.deepEqual(readConfigObject(projectPath), { naming: defaults, metrics: false, unrelated: { keep: true } });
    assert.equal(readFileSync(globalPath, "utf8"), globalBefore);
    assert.equal(readFileSync(legacyPath, "utf8"), legacyBefore);
  });
});

test("saving and resetting global false re-enable naming without creating legacy storage", async () => {
  await withConfig(({ ctx, globalPath, legacyPath }) => {
    writeJson(globalPath, { naming: false, footer: false });
    assert.equal(loadNamingConfig(ctx), false);
    const defaults = parseConfig({});
    assert.equal(saveNamingConfig(defaults, ctx), globalPath);
    assert.deepEqual(loadNamingConfig(ctx), defaults);
    assert.deepEqual(readConfigObject(globalPath), { naming: defaults, footer: false });
    assert.equal(existsSync(legacyPath), false);
  });
});

test("saving rejects invalid config and malformed destination files rather than erasing them", async () => {
  await withConfig(({ ctx, globalPath }) => {
    writeJson(globalPath, { footer: false });
    const before = readFileSync(globalPath, "utf8");
    assert.throws(() => saveNamingConfig({ ...parseConfig({}), title: { ...parseConfig({}).title, maxTokens: 0 } }, ctx));
    assert.equal(readFileSync(globalPath, "utf8"), before);
  });
  for (const source of ["globalPath", "projectPath"] as const) {
    await withConfig((fixture) => {
      writeText(fixture[source], "{");
      assert.throws(() => saveNamingConfig(parseConfig({}), fixture.ctx));
      assert.equal(readFileSync(fixture[source], "utf8"), "{");
    });
  }
});

test("invalid unrelated feature config keeps its existing fallback without disabling naming", async () => {
  await withConfig(({ ctx, globalPath, notices }) => {
    writeJson(globalPath, { metrics: { display: "invalid" }, naming: {} });
    assert.deepEqual(loadNamingConfig(ctx), parseConfig({}));
    assert.deepEqual(loadConfig(ctx).metrics, {});
    assert.equal(notices.length, 1);
  });
});
