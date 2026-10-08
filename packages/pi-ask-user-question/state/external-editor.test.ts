import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editWithExternalEditor, type ExternalEditorTui } from "./external-editor.js";

const tempDirs: string[] = [];

function script(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-ask-editor-test-"));
  tempDirs.push(dir);
  const path = join(dir, "editor.mjs");
  writeFileSync(path, source, "utf8");
  return path;
}

function commandFor(path: string): string {
  return `${process.execPath} ${path}`;
}

function makeTui() {
  const tui: ExternalEditorTui = {
    stop: vi.fn(),
    start: vi.fn(),
    requestRender: vi.fn(),
  };
  return tui;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("editWithExternalEditor", () => {
  it("edits through a Node launcher and restores the TUI after real close", async () => {
    const editor = script(`
      import { appendFileSync } from "node:fs";
      appendFileSync(process.argv.at(-1), "\\nchanged\\n", "utf8");
    `);
    const tui = makeTui();
    const result = await editWithExternalEditor(tui, commandFor(editor), "draft", {
      signal: new AbortController().signal,
      launchMessage: "launching",
    });

    expect(result).toBe("draft\nchanged");
    expect(tui.stop).toHaveBeenCalledOnce();
    expect(tui.start).toHaveBeenCalledOnce();
    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });

  it("reports launcher failure but still restores the TUI after close", async () => {
    const editor = script("process.exit(7);");
    const tui = makeTui();

    await expect(
      editWithExternalEditor(tui, commandFor(editor), "draft", {
        signal: new AbortController().signal,
        launchMessage: "launching",
      }),
    ).rejects.toThrow("exit code 7");
    expect(tui.start).toHaveBeenCalledOnce();
  });

  it("sends SIGTERM on cancellation and does not restore the TUI before actual close", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "pi-ask-editor-close-"));
    tempDirs.push(dir);
    const ready = join(dir, "ready");
    const closed = join(dir, "closed");
    const editor = script(`
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {
        setTimeout(() => {
          writeFileSync(${JSON.stringify(closed)}, "closed");
          process.exit(0);
        }, 120);
      });
      writeFileSync(${JSON.stringify(ready)}, "ready");
      setInterval(() => {}, 1000);
    `);
    const tui = makeTui();
    const controller = new AbortController();
    const operation = editWithExternalEditor(tui, commandFor(editor), "draft", {
      signal: controller.signal,
      launchMessage: "launching",
      terminationGraceMs: 1000,
    });
    await waitForFile(ready);

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tui.start).not.toHaveBeenCalled();

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(closed)).toBe(true);
    expect(tui.start).toHaveBeenCalledOnce();
  });

  it("escalates to bounded SIGKILL when its launcher ignores SIGTERM", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "pi-ask-editor-kill-"));
    tempDirs.push(dir);
    const ready = join(dir, "ready");
    const editor = script(`
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      writeFileSync(${JSON.stringify(ready)}, "ready");
      setInterval(() => {}, 1000);
    `);
    const tui = makeTui();
    const controller = new AbortController();
    const operation = editWithExternalEditor(tui, commandFor(editor), "draft", {
      signal: controller.signal,
      launchMessage: "launching",
      terminationGraceMs: 30,
    });
    await waitForFile(ready);
    controller.abort();

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(tui.start).toHaveBeenCalledOnce();
  });
});
