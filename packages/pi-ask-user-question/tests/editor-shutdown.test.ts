import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi, makeTheme } from "@maplezzk/pi-test-utils/rpiv";
import { beforeAll, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "../ask-user-question.js";
import type { QuestionnaireSessionComponent } from "../state/questionnaire-session.js";

beforeAll(async () => {
  await Promise.all([import("../state/questionnaire-session.js"), import("@earendil-works/pi-coding-agent")]);
}, 120_000);

it("shutdown after tool abort waits for its editor launcher close and never restarts the TUI", async () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "pi-question-shutdown-"));
  const ready = join(dir, "ready");
  const closed = join(dir, "closed");
  const script = join(dir, "editor.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => setTimeout(() => { writeFileSync(${JSON.stringify(closed)}, "closed"); process.exit(0); }, 120));
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);\n`);
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ externalEditor: `${process.execPath} ${script}` }));
  const runtime = createMockPi();
  registerAskUserQuestionTool(runtime.pi);
  const tool = runtime.captured.tools.get("ask_user_question")!;
  const tui = { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn(), stop: vi.fn(), start: vi.fn() };
  const control = new AbortController();
  let component: QuestionnaireSessionComponent | undefined;
  let started!: () => void;
  const mounted = new Promise<void>((resolve) => { started = resolve; });
  const editor = vi.fn();
  const ctx = createMockCtx({ hasUI: true, mode: "tui", ui: {
    editor,
    custom: (factory: Function) => new Promise((resolve) => {
      const tuiBindings = getKeybindings();
      const keybindings = { matches: (data: string, name: string) => name === "app.editor.external"
        ? data === "\x07" : tuiBindings.matches(data, name as Parameters<typeof tuiBindings.matches>[1]) };
      component = factory(tui, makeTheme(), keybindings, resolve);
      started();
    }),
  } as never });
  const params = { questions: [{ question: "Choose?", header: "Choice", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] };
  const operation = tool.execute("shutdown", params as never, control.signal, undefined, ctx);
  try {
    await mounted;
    for (const key of ["\x1b[B", "\x1b[B", "draft", "\x07", "\x07"]) component!.handleInput(key);
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("editor launcher did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    control.abort();
    let shutdownDone = false;
    const shutdown = Promise.all((runtime.captured.events.get("session_shutdown") ?? []).map((handler) => handler({}, ctx)))
      .then(() => { shutdownDone = true; });
    await Promise.resolve();
    expect(shutdownDone).toBe(false);
    expect(tui.start).not.toHaveBeenCalled();
    await shutdown;
    const result = await operation;
    expect(existsSync(closed)).toBe(true);
    expect(result.details).toMatchObject({ cancelled: true });
    expect(tui.stop).toHaveBeenCalledOnce();
    expect(tui.start).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
  } finally {
    control.abort();
    await operation.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
