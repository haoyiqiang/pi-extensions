import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { withTempAgentDir } from "@kevinhao/pi-utils";
import { clearConfigCache, loadConfig } from "../src/config/index.ts";
import { openSparkConfigPanel, registerSparkConfigCommand } from "../src/config/panel.ts";
import { projectSparkConfigPath, readConfigObject, sparkConfigPath } from "../src/config/store.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

async function fixture(run: (f: ReturnType<typeof context> & { global: string; project: string; dir: string }) => Promise<void>, actions: string[], edits: string[] = []) {
  await withTempAgentDir(async (dir) => {
    clearConfigCache();
    const panel = context(join(dir, "project"), actions, edits);
    try {
      await run({ ...panel, global: sparkConfigPath(dir), project: projectSparkConfigPath(panel.ctx.cwd), dir });
      assert.equal(actions.length, 0, "all scripted selections must be consumed");
    } finally {
      clearConfigCache();
    }
  }, "pi-spark-panel-");
}

function context(cwd: string, actions: string[], edits: string[]) {
  const notices: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd, hasUI: true, mode: "tui",
    ui: {
      async select(_title: string, choices: string[]) {
        const prefix = actions.shift();
        if (!prefix) return undefined;
        const selected = choices.find((choice) => choice.startsWith(prefix));
        assert.ok(selected, `missing ${prefix} in ${choices.join(", ")}`);
        return selected;
      },
      async editor() { return edits.shift(); },
      async confirm() { return true; },
      notify(message: string, level: string) { notices.push({ message, level }); },
    },
  } as any;
  return { ctx, notices };
}

test("registers the unified config command without reading configuration", () => {
  const commands = new Map<string, any>();
  registerSparkConfigCommand({ registerCommand(name: string, command: unknown) { commands.set(name, command); } } as any);
  assert.deepEqual([...commands.keys()], ["config:spark"]);
  assert.equal(typeof commands.get("config:spark").handler, "function");
});

test("cancel leaves absent configuration files absent", async () => {
  await fixture(async ({ ctx, global, project, notices }) => {
    await openSparkConfigPanel(ctx);
    assert.equal(existsSync(global), false);
    assert.equal(existsSync(project), false);
    assert.deepEqual(notices, []);
  }, []);
});

test("toggles features and preserves sibling settings", async () => {
  await fixture(async ({ ctx, global, notices }) => {
    writeJson(global, { footer: { style: "p10k" }, unrelated: { keep: true } });
    await openSparkConfigPanel(ctx);
    assert.deepEqual(readConfigObject(global), { footer: false, unrelated: { keep: true } });
    assert.equal(loadConfig(ctx).footer, false);
    assert.match(notices.at(-1)!.message, /\/reload/);
  }, ["Footer:", "Enabled:", "Back", "Done"]);
});

test("re-enabling within the panel retains previous settings", async () => {
  await fixture(async ({ ctx, global }) => {
    writeJson(global, { footer: { style: "p10k", statusPosition: "below" } });
    await openSparkConfigPanel(ctx);
    assert.deepEqual(readConfigObject(global)?.footer, { style: "p10k", statusPosition: "below" });
  }, ["Footer:", "Enabled:", "Enabled:", "Back", "Done"]);
});

test("project-owned settings write only the project file and preserve merged leaves", async () => {
  await fixture(async ({ ctx, global, project }) => {
    writeJson(global, { footer: { style: "p10k" }, metrics: false });
    writeJson(project, { footer: { statusPosition: "inline" }, unrelated: true });
    const before = readFileSync(global, "utf8");
    await openSparkConfigPanel(ctx);
    assert.equal(readFileSync(global, "utf8"), before);
    assert.deepEqual(readConfigObject(project), { footer: { style: "p10k", statusPosition: "below" }, unrelated: true });
  }, ["Footer:", "statusPosition:", "below", "Back", "Done"]);
});

test("JSON editing validates before writing and supports presets", async () => {
  await fixture(async ({ ctx, global, notices }) => {
    await openSparkConfigPanel(ctx);
    assert.deepEqual(readConfigObject(global)?.presets, { fast: { provider: "test", model: "test-model", thinkingLevel: "off" } });
    assert.ok(notices.some((notice) => notice.level === "error"));
  }, ["Model presets:", "Edit all", "Edit all", "Edit all", "Back", "Done"], [
    "{", JSON.stringify({ broken: { provider: "test" } }),
    JSON.stringify({ fast: { provider: "test", model: "test-model", thinkingLevel: "off" } }),
  ]);
});

test("reset restores defaults without overwriting other features", async () => {
  await fixture(async ({ ctx, global }) => {
    writeJson(global, { metrics: false, footer: false });
    await openSparkConfigPanel(ctx);
    assert.deepEqual(readConfigObject(global), { metrics: { display: "on-stop" }, footer: false });
  }, ["Metrics:", "Reset", "Back", "Done"]);
});

test("legacy files migrate on save without being modified", async () => {
  await fixture(async ({ ctx, global, dir }) => {
    const legacy = join(dir, "spark.json");
    writeJson(legacy, { editor: { spinner: "lights" }, footer: false });
    const before = readFileSync(legacy, "utf8");
    await openSparkConfigPanel(ctx);
    assert.equal(readFileSync(legacy, "utf8"), before);
    assert.deepEqual(readConfigObject(global), { editor: { spinner: "pulse" }, footer: false });
  }, ["Editor:", "spinner:", "pulse", "Back", "Done"]);
});

test("malformed configuration is reported and never overwritten", async () => {
  await fixture(async ({ ctx, global, notices }) => {
    mkdirSync(dirname(global), { recursive: true });
    writeFileSync(global, "{");
    await openSparkConfigPanel(ctx);
    assert.equal(readFileSync(global, "utf8"), "{");
    assert.ok(notices.some((notice) => notice.level === "error"));
  }, []);
});

test("enables clean mode and resources with explicit enabled false", async () => {
  await fixture(async ({ ctx, global }) => {
    writeJson(global, { cleanMode: { enabled: false, activityRows: 8 }, resources: { enabled: false } });
    await openSparkConfigPanel(ctx);
    const saved = readConfigObject(global) as any;
    assert.equal(saved.cleanMode.enabled, true);
    assert.equal(saved.cleanMode.activityRows, 8);
    assert.equal(saved.resources.enabled, true);
  }, ["Clean mode:", "Enabled:", "Back", "Session resources:", "Enabled:", "Back", "Done"]);
});

test("cancelled editing and reset do not write configuration", async () => {
  await fixture(async ({ ctx, global }) => {
    writeJson(global, { editor: { spinner: "lights" } });
    const before = readFileSync(global, "utf8");
    ctx.ui.confirm = async () => false;
    await openSparkConfigPanel(ctx);
    assert.equal(readFileSync(global, "utf8"), before);
  }, ["Editor:", "Edit all", "Reset", "Back", "Done"]);
});

test("a legacy project feature owns panel edits and migrates only its file", async () => {
  await fixture(async ({ ctx, global, project }) => {
    writeJson(global, { metrics: { display: "live" } });
    const legacy = join(ctx.cwd, ".pi", "spark.json");
    writeJson(legacy, { metrics: false, footer: false });
    const before = readFileSync(legacy, "utf8");
    await openSparkConfigPanel(ctx);
    assert.deepEqual(readConfigObject(project), { metrics: { display: "on-stop" }, footer: false });
    assert.deepEqual(readConfigObject(global), { metrics: { display: "live" } });
    assert.equal(readFileSync(legacy, "utf8"), before);
  }, ["Metrics:", "Reset", "Back", "Done"]);
});

test("unified panel opens detailed naming settings and preserves project scope", async () => {
  await fixture(async ({ ctx, global, project }) => {
    writeJson(global, { naming: { targets: { tab: false } } });
    writeJson(project, { naming: { automaticNaming: true }, metrics: false });
    await openSparkConfigPanel(ctx);
    const saved = readConfigObject(project) as any;
    assert.equal(saved.naming.automaticNaming, false);
    assert.equal(saved.naming.targets.tab, false);
    assert.equal(saved.metrics, false);
    assert.deepEqual(readConfigObject(global), { naming: { targets: { tab: false } } });
  }, ["Session and terminal naming:", "Detailed settings", "Automatic naming:", "Done", "Back", "Done"]);
});

test("unified panel opens clean-mode settings and saves activity rows", async () => {
  initTheme("dark", false);
  await fixture(async ({ ctx, global, notices }) => {
    writeJson(global, { cleanMode: { activityRows: 4 }, footer: false });
    ctx.ui.custom = async (factory: any) => {
      let closed = false;
      const component = factory({ requestRender() {} }, {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      }, {}, () => { closed = true; });
      for (let i = 0; i < 5; i++) component.handleInput("\u001b[B");
      component.handleInput("\r");
      component.handleInput("\u001b[B");
      component.handleInput("\r");
      component.handleInput("\u001b");
      assert.equal(closed, true);
    };
    await openSparkConfigPanel(ctx);
    const saved = readConfigObject(global) as any;
    assert.equal(saved.cleanMode.activityRows, 5, JSON.stringify(notices));
    assert.equal(saved.footer, false);
  }, ["Clean mode:", "Detailed settings", "Back", "Done"]);
});

test("non-interactive invocation does not open a dialog", async () => {
  const { ctx, notices } = context("/unused", [], []);
  ctx.hasUI = false;
  ctx.ui.select = () => assert.fail("dialog must not open");
  await openSparkConfigPanel(ctx);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /requires interactive mode/);
});
