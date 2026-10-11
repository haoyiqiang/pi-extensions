import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearConfigCache } from "../src/config/index.ts";
import { registerSessionResources } from "../src/features/session-resources/index.ts";
import { ensureSessionResourceRuntime } from "../src/features/session-resources/runtime.ts";
import { openSparkConfigPanel } from "../src/config/panel.ts";

type Handler = (...args: any[]) => any;

test("integrated resources feature collects tools and uses only the unified configuration panel", async () => {
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
      cwd: join(dir, "project"),
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        notify() {},
        select: (() => {
          const actions = ["Session resources:", "Enabled:", "Back", "Done"];
          return async (_title: string, choices: string[]) => {
            const prefix = actions.shift();
            return prefix ? choices.find((choice) => choice.startsWith(prefix)) : undefined;
          };
        })(),
      },
    } as unknown as ExtensionContext;

    registerSessionResources(pi);
    assert.equal(commands.size, 0);

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

    await openSparkConfigPanel(ctx as unknown as ExtensionCommandContext);
    events.get("session_start")?.({}, ctx);
    assert.equal(runtime.enabled, false);
    assert.equal(JSON.parse(readFileSync(join(dir, "extensions", "pi-spark", "config.json"), "utf8")).resources, false);

    events.get("session_shutdown")?.({}, ctx);
    assert.equal(runtime.list().length, 0);
  } finally {
    clearConfigCache();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
