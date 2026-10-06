import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createStandardWorkflowUi } from "../src/workflow/standard-ui.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function realUi() {
  return {
    theme: {},
    select: vi.fn(),
    input: vi.fn(async () => "input"),
    custom: vi.fn((factory) => new Promise((resolve, reject) => {
      // Like SDK custom(): done may settle before an async factory returns.
      void Promise.resolve(factory({}, {}, {}, resolve)).catch(reject);
    })),
    notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn(),
    setEditorText: vi.fn(), onTerminalInput: vi.fn(),
  };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("standard workflow child UI", () => {
  it("serializes child dialogs, cancels queued work, and leaves root surfaces alone", async () => {
    const real = realUi();
    const answer = deferred<string>();
    real.select.mockImplementation(() => answer.promise);
    const first = new AbortController();
    const second = new AbortController();
    const a = createStandardWorkflowUi(real as unknown as ExtensionUIContext, first.signal, "tui");
    const b = createStandardWorkflowUi(real as unknown as ExtensionUIContext, second.signal, "tui");
    const selected = a.select("first", ["yes"]);
    const queued = b.input("second");
    const cancellation = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(real.select).toHaveBeenCalledOnce();
    expect(real.select.mock.calls[0]![2].signal).toBe(first.signal);
    expect(real.input).not.toHaveBeenCalled();
    second.abort();
    await cancellation;
    answer.resolve("yes");
    expect(await selected).toBe("yes");
    await flush();
    expect(real.input).not.toHaveBeenCalled();
    a.setWidget("child", ["not at root"]);
    a.setStatus("child", "not at root");
    a.setFooter(undefined);
    a.setEditorText("do not overwrite the user's draft");
    a.onTerminalInput(() => undefined)();
    for (const method of [real.setWidget, real.setStatus, real.setFooter, real.setEditorText, real.onTerminalInput]) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(a.theme).toBe(real.theme);
    first.abort();
    a.notify("late");
    expect(real.notify).not.toHaveBeenCalled();
  });

  it("dismisses an active custom dialog and disposes its late-created component", async () => {
    const real = realUi();
    const scope = new AbortController();
    const ui = createStandardWorkflowUi(real as unknown as ExtensionUIContext, scope.signal, "tui");
    const component = { render: () => [], invalidate: () => {}, dispose: vi.fn() };
    const factory = deferred<typeof component>();
    const response = ui.custom(() => factory.promise);
    const cancellation = expect(response).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(real.custom).toHaveBeenCalledOnce();
    scope.abort();
    await cancellation;
    const nextScope = new AbortController();
    const next = createStandardWorkflowUi(real as unknown as ExtensionUIContext, nextScope.signal, "tui");
    expect(await next.input("next dialog")).toBe("input");
    factory.resolve(component);
    await flush();
    expect(component.dispose).toHaveBeenCalledOnce();
    nextScope.abort();
  });
});
