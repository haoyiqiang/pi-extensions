import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord, WidgetMode } from "../src/types.js";
import { type AgentActivity, AgentWidget, formatMs, type UICtx } from "../src/ui/agent-widget.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("AgentWidget refresh lifecycle", () => {
  const widgets: AgentWidget[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    try {
      for (const widget of widgets.splice(0)) widget.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
    return {
      id: "agent", type: "general-purpose", description: "background search",
      status: "running", toolUses: 0, startedAt: Date.now(), isBackground: true,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0, ...overrides,
    };
  }

  function mount(records: AgentRecord[], initialMode: WidgetMode = "background", withUI = true) {
    let mode = initialMode;
    let component: { render(): string[] } | undefined;
    let rendered = "";
    const activity: AgentActivity = {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
    };
    const widget = new AgentWidget(
      { listAgents: () => records } as unknown as AgentManager,
      new Map([["agent", activity]]), () => mode,
    );
    widgets.push(widget);
    const tui = {
      terminal: { columns: 120 },
      requestRender: vi.fn(() => { rendered = component?.render().join("\n") ?? ""; }),
    };
    const ui: UICtx = {
      setStatus: vi.fn(),
      setWidget: vi.fn((_key, factory) => {
        component = factory?.(tui, theme);
        rendered = component?.render().join("\n") ?? "";
      }),
    };
    if (withUI) widget.setUICtx(ui);
    return {
      widget, activity, ui, tui,
      setMode: (value: WidgetMode) => { mode = value; widget.update(); },
      rendered: () => rendered,
    };
  }

  it.each(["background", "all"] as const)("resumes live redraw after off -> %s during active work", mode => {
    const mounted = mount([record()]);
    // Match the runtime's start path, which already starts the initial timer.
    mounted.widget.ensureTimer();
    mounted.widget.update();
    expect(vi.getTimerCount()).toBe(1);

    mounted.setMode("off");
    expect(vi.getTimerCount()).toBe(0);
    expect(mounted.rendered()).toBe("");

    mounted.setMode(mode);
    expect(vi.getTimerCount()).toBe(1);
    expect(mounted.rendered()).toContain("background search");
    mounted.tui.requestRender.mockClear();
    mounted.activity.activeTools.set("read-call", "read");
    vi.advanceTimersByTime(800);
    expect(mounted.tui.requestRender).toHaveBeenCalled();
    expect(mounted.rendered()).toContain("reading");
    expect(mounted.rendered()).toContain(formatMs(800));

    for (let i = 0; i < 5; i++) mounted.widget.update();
    expect(vi.getTimerCount()).toBe(1);
    mounted.setMode("off");
    expect(vi.getTimerCount()).toBe(0);
    mounted.tui.requestRender.mockClear();
    vi.advanceTimersByTime(800);
    expect(mounted.tui.requestRender).not.toHaveBeenCalled();
  });

  it("starts its own timer only after an active widget has a UI", () => {
    const mounted = mount([record()], "all", false);
    mounted.widget.update();
    expect(vi.getTimerCount()).toBe(0);
    expect(mounted.ui.setWidget).not.toHaveBeenCalled();
    mounted.widget.setUICtx(mounted.ui);
    mounted.widget.update();
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    ["off", "off", () => [record()]],
    ["no agents", "all", () => []],
    ["hidden foreground", "background", () => [record({ isBackground: false })]],
    ["nested agent", "all", () => [record({ parentAgentId: "parent" })]],
    ["workflow child", "all", () => [record({ workflowId: "workflow" })]],
    ["finished only", "all", () => [record({ status: "completed", completedAt: Date.now() })]],
  ] as const)("does not start a timer for %s", (_label, mode, records) => {
    const mounted = mount(records(), mode);
    mounted.widget.update();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts redraw when an active foreground agent becomes visible", () => {
    const mounted = mount([record({ isBackground: false })]);
    mounted.widget.update();
    expect(vi.getTimerCount()).toBe(0);
    mounted.setMode("all");
    expect(vi.getTimerCount()).toBe(1);
    mounted.tui.requestRender.mockClear();
    vi.advanceTimersByTime(80);
    expect(mounted.tui.requestRender).toHaveBeenCalledOnce();
  });

  it("stops the timer when all agents disappear", () => {
    const records = [record()];
    const mounted = mount(records);
    mounted.widget.update();
    expect(vi.getTimerCount()).toBe(1);
    records.splice(0);
    vi.advanceTimersByTime(80);
    expect(vi.getTimerCount()).toBe(0);
    expect(mounted.rendered()).toBe("");
  });

  it("disposes the resumed timer idempotently without further redraws", () => {
    const mounted = mount([record()]);
    mounted.widget.ensureTimer();
    mounted.widget.update();
    mounted.setMode("off");
    mounted.setMode("background");
    expect(vi.getTimerCount()).toBe(1);
    mounted.widget.dispose();
    mounted.widget.dispose();
    expect(vi.getTimerCount()).toBe(0);
    mounted.tui.requestRender.mockClear();
    vi.advanceTimersByTime(800);
    expect(mounted.tui.requestRender).not.toHaveBeenCalled();
  });
});
