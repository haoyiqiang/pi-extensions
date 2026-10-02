import assert from "node:assert/strict";
import test from "node:test";
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
