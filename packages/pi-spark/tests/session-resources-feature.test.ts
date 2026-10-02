import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearConfigCache } from "../src/config/index.ts";
import { registerSessionResources } from "../src/features/session-resources/index.ts";
import { ensureSessionResourceRuntime } from "../src/features/session-resources/runtime.ts";

type Handler = (...args: any[]) => any;

test("integrated resources feature collects tools and persists its compatibility command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-spark-resources-feature-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  clearConfigCache();
  try {
    const events = new Map<string, Handler>();
    const commands = new Map<string, any>();
    const pi = {
      on(name: string, handler: Handler): void {
        events.set(name, handler);
      },
      registerCommand(name: string, command: unknown): void {
        commands.set(name, command);
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      mode: "tui",
      cwd: resolve("/workspace/project"),
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
    } as unknown as ExtensionContext;

    registerSessionResources(pi);
    assert.ok(commands.has("config:session-resources"));
    assert.ok(commands.has("session-resources"));

    events.get("session_start")?.({}, ctx);
    events.get("tool_result")?.({
      toolName: "read",
      input: { path: "src/index.ts" },
      content: [],
      isError: false,
    }, ctx);
    const runtime = ensureSessionResourceRuntime();
    assert.equal(runtime.enabled, true);
    assert.equal(runtime.list().some((resource) => resource.label === "src/index.ts"), true);

    await commands.get("config:session-resources").handler("disable", ctx as unknown as ExtensionCommandContext);
    assert.equal(runtime.enabled, false);
    assert.equal(JSON.parse(readFileSync(join(dir, "spark.json"), "utf8")).resources, false);

    events.get("session_shutdown")?.({}, ctx);
    assert.equal(runtime.list().length, 0);
  } finally {
    clearConfigCache();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
