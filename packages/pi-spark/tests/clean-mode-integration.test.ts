import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearConfigCache } from "../src/config/index.ts";
import registerCleanMode from "../src/features/clean-mode/index.ts";

test("integrated clean mode keeps its commands, shortcuts, and lifecycle handlers", () => {
  const events = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const shortcuts = new Map<string, unknown>();
  const pi = {
    on(name: string, handler: unknown): void {
      events.set(name, handler);
    },
    registerCommand(name: string, command: unknown): void {
      commands.set(name, command);
    },
    registerShortcut(name: string, shortcut: unknown): void {
      shortcuts.set(name, shortcut);
    },
    registerMessageRenderer(): void {},
  } as any;

  registerCleanMode(pi);

  assert.ok(commands.has("clean"));
  assert.ok(commands.has("config:clean-mode"));
  assert.ok(shortcuts.has("f2"));
  assert.ok(shortcuts.has("shift+f2"));
  for (const event of ["session_start", "agent_start", "agent_settled", "session_shutdown"]) {
    assert.ok(events.has(event), `missing ${event}`);
  }
});

test("non-TUI child lifecycle does not claim spark's root UI surfaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-spark-clean-owner-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  clearConfigCache();
  try {
    const events = new Map<string, (...args: any[]) => any>();
    const pi = {
      on(name: string, handler: (...args: any[]) => any): void {
        events.set(name, handler);
      },
      registerCommand(): void {},
      registerShortcut(): void {},
      registerEntryRenderer(): void {},
      appendEntry(): void {},
    } as any;
    let widgetClaimed = false;
    const ctx = {
      mode: "rpc",
      cwd: dir,
      hasUI: false,
      sessionManager: {},
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        setWidget: () => { widgetClaimed = true; },
        notify() {},
      },
    } as any;

    registerCleanMode(pi);
    await events.get("session_start")?.({}, ctx);
    assert.equal(widgetClaimed, false);
    await events.get("session_shutdown")?.({}, ctx);
  } finally {
    clearConfigCache();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
