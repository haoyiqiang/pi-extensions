import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearConfigCache } from "../src/config/index.ts";
import { registerEditor } from "../src/features/editor/index.ts";
import { ensureSessionResourceRuntime, wrapSessionResourceEditor } from "../src/features/session-resources/runtime.ts";
import { SessionResourceEditor } from "../src/features/session-resources/picker.ts";

const base = {
  onSubmit: undefined,
  onChange: undefined,
  getText: () => "",
  setText() {},
  handleInput() {},
  invalidate() {},
  render: () => [],
} as any;

test("spark editor is wrapped by the integrated session-resource picker", () => {
  ensureSessionResourceRuntime();
  const wrapped = wrapSessionResourceEditor(
    base,
    { ui: { theme: {} } } as any,
    { requestRender() {} } as any,
    { matches: () => false } as any,
  );
  assert.ok(wrapped instanceof SessionResourceEditor);
});

test("resources still wrap Pi's current editor when spark editor is disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-spark-default-editor-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  clearConfigCache();
  try {
    writeFileSync(join(dir, "spark.json"), JSON.stringify({ editor: false, resources: {} }));
    ensureSessionResourceRuntime().enabled = true;
    const handlers = new Map<string, (...args: any[]) => any>();
    const pi = { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as any;
    let factory: ((...args: any[]) => any) | undefined;
    const currentFactory = () => base;
    const ctx = {
      mode: "tui",
      cwd: join(dir, "project"),
      ui: {
        theme: {},
        getEditorComponent: () => currentFactory,
        setEditorComponent: (next: (...args: any[]) => any) => { factory = next; },
      },
    } as any;

    registerEditor(pi, { on() {} } as any);
    handlers.get("session_start")?.({}, ctx);
    assert.ok(factory);
    const wrapped = factory?.({ requestRender() {} }, {}, { matches: () => false });
    assert.ok(wrapped instanceof SessionResourceEditor);
  } finally {
    clearConfigCache();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
