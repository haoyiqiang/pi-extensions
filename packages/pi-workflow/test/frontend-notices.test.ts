import { applyLocale } from "pi-extensions-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWfHandler, registerWorkflowCommand } from "../src/command.js";
import { handleWorkflowCommand } from "../src/command-run.js";
import { i18n, notifyWorkflow, workflowNoticeObserver } from "../src/i18n.js";
import { createMockCommandCtx, createMockPi } from "./upstream/index.ts";

afterEach(() => { applyLocale("en-US"); });

describe("Pi workflow notice ownership", () => {
  it("decorates the notice port once without mutating or snapshotting live SDK context fields", () => {
    const ctx = createMockCommandCtx({ mode: "rpc" });
    const originalUi = ctx.ui;
    const originalNotify = originalUi.notify;
    let registry = { version: 1 };
    let prompt = "first";
    Object.defineProperty(ctx, "modelRegistry", { get: () => registry });
    Object.assign(ctx, { getSystemPrompt: () => prompt });
    const view = workflowNoticeObserver(ctx);
    expect(view).not.toBe(ctx);
    expect(workflowNoticeObserver(ctx)).toBe(view);
    expect(workflowNoticeObserver(view)).toBe(view);
    expect(ctx.ui).toBe(originalUi);
    expect(ctx.ui.notify).toBe(originalNotify);
    registry = { version: 2 };
    prompt = "current";
    expect(view.modelRegistry).toBe(registry);
    expect(view.getSystemPrompt()).toBe("current");
    expect(view.sessionManager).toBe(ctx.sessionManager);
    view.ui.notify("engine result", "info");
    notifyWorkflow(view, "frontend result", "warning");
    expect(originalNotify).toHaveBeenNthCalledWith(1, "[workflow] engine result", "info");
    expect(originalNotify).toHaveBeenNthCalledWith(2, "[workflow] frontend result", "warning");
  });

  it("leaves programmatic host identity and caller-owned notice behavior unchanged", () => {
    const ctx = createMockCommandCtx();
    expect(workflowNoticeObserver(ctx)).toBe(ctx);
    notifyWorkflow(ctx, "legacy result", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith("legacy result", "info");
  });
});

describe("locale changes after frontend import", () => {
  it("uses the current locale for command registration and runtime-loading feedback", async () => {
    const f = createMockPi();
    applyLocale("zh-CN");
    registerWorkflowCommand(f.pi);
    expect(f.captured.commands.get("wf")?.description).toBe(i18n.t("command.description"));
    const handle = vi.fn(async () => {});
    const handler = makeWfHandler(f.pi, async () => ({
      handleWorkflowCommand: handle,
      prewarmWorkflowRuntime: async () => {},
    }));
    const ctx = createMockCommandCtx({ mode: "rpc", hasUI: true });
    await handler("preview", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(`[workflow] ${i18n.t("command.runtimeLoading")}`, "info");
    expect(handle).toHaveBeenCalledWith(f.pi, "preview", ctx);
  });

  it("does not retain the import-time locale for headless-command errors", async () => {
    const f = createMockPi();
    const ctx = createMockCommandCtx({ mode: "rpc", hasUI: false });
    applyLocale("zh-CN");
    await handleWorkflowCommand(f.pi, "", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(`[workflow] ${i18n.t("messages.interactiveOnly")}`, "error");
    applyLocale("en-US");
    await handleWorkflowCommand(f.pi, "", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(`[workflow] ${i18n.t("messages.interactiveOnly")}`, "error");
  });
});
