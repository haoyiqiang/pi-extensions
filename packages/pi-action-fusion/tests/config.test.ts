import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withTempAgentDir } from "@maplezzk/pi-test-utils";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import actionFusion, { loadActionFusionConfig } from "../index.ts";

function harness() {
  const tools = new Map<string, ToolDefinition>();
  let start!: (event: unknown, ctx: ExtensionContext) => void;
  let command!: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
  const messages: string[] = [];
  const api = {
    on(event: string, handler: typeof start) { if (event === "session_start") start = handler; },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(_name: string, value: typeof command) { command = value; },
  } as unknown as ExtensionAPI;
  const ctx = { mode: "print", ui: { notify: (text: string) => messages.push(text) } } as unknown as ExtensionCommandContext;
  actionFusion(api);
  return { tools, messages, ctx, start: () => start({}, ctx), command: (args: string) => command.handler(args, ctx) };
}

test("missing configuration is opt-in, does not replace tools or create files", async () => {
  await withTempAgentDir(async (agentDir) => {
    const instance = harness();
    instance.start();
    assert.equal(instance.tools.size, 0);
    assert.equal(loadActionFusionConfig().config.enabled, false);
    assert.equal(existsSync(join(agentDir, "extensions", "pi-action-fusion", "config.json")), false);
  });
});

test("enable/disable persists only by explicit command, applies on a new load", async () => {
  await withTempAgentDir(async () => {
    const first = harness();
    first.start();
    await first.command("enable");
    assert.equal(first.tools.size, 0, "configuration changes require reload");
    const loaded = loadActionFusionConfig();
    assert.equal(loaded.config.enabled, true);
    assert.deepEqual(JSON.parse(readFileSync(loaded.path, "utf8")), { enabled: true });
    const second = harness();
    second.start();
    second.start();
    assert.deepEqual([...second.tools.keys()], ["edit", "write"]);
    await second.command("status");
    assert.ok(second.messages.length > 0);
    await second.command("disable");
    assert.equal(second.tools.size, 2);
    const third = harness();
    third.start();
    assert.equal(third.tools.size, 0);
  });
});

test("invalid configuration stays disabled and malformed JSON is not overwritten", async () => {
  await withTempAgentDir(async () => {
    const path = loadActionFusionConfig().path;
    mkdirSync(dirname(path), { recursive: true });
    for (const value of ['{"enabled":"true"}', '{"unknown":true}', '[true]', '{broken']) {
      writeFileSync(path, value);
      const loaded = loadActionFusionConfig();
      assert.equal(loaded.config.enabled, false);
      assert.ok(loaded.warning);
      const instance = harness();
      instance.start();
      assert.equal(instance.tools.size, 0);
      assert.ok(instance.messages.length > 0);
      await instance.command("enable");
      await instance.command("disable");
      assert.equal(readFileSync(path, "utf8"), value, "invalid configuration requires explicit manual repair");
    }
    const instance = harness();
    await instance.command("enable");
    assert.equal(readFileSync(path, "utf8"), "{broken");
    assert.ok(instance.messages.length > 0);
  });
});

test("configuration command rejects unsupported actions without writing", async () => {
  await withTempAgentDir(async () => {
    const instance = harness();
    await instance.command("unexpected");
    assert.equal(existsSync(loadActionFusionConfig().path), false);
    assert.ok(instance.messages.length > 0);
  });
});

test("all authored messages have both locales and use the shared translator", () => {
  const catalog = loadCatalog(new URL("../src/catalog.json", import.meta.url));
  const translator = createTranslator(catalog);
  for (const [key, translations] of Object.entries(catalog)) {
    assert.ok(translations["en-US"].length > 0, key);
    assert.ok(translations["zh-CN"].length > 0, key);
    assert.equal(typeof translator.t(key), "string");
  }
});
