import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi } from "pi-utils/rpiv";
import { applyLocale, LOCALE_CHANGED_EVENT } from "pi-utils";
import { afterEach, expect, it } from "vitest";
import advisor from "./index.ts";

afterEach(() => applyLocale("en-US"));

it("refreshes startup and live-locale metadata without activating a disabled advisor", async () => {
  applyLocale("en-US");
  const runtime = createMockPi({ events: createEventBus() });
  advisor(runtime.pi);
  const initial = runtime.captured.tools.get("advisor")!;
  const initialCommand = runtime.captured.commands.get("config:advisor")!.description;
  applyLocale("zh-CN");
  for (const handler of runtime.captured.events.get("session_start") ?? []) {
    await handler({}, createMockCtx({ mode: "rpc", hasUI: true }));
  }
  const chinese = runtime.captured.tools.get("advisor")!;
  expect(chinese.description).not.toBe(initial.description);
  expect(chinese.promptGuidelines).not.toEqual(initial.promptGuidelines);
  expect(runtime.captured.commands.get("config:advisor")!.description).not.toBe(initialCommand);
  expect(runtime.captured.activeTools).not.toContain("advisor");
  applyLocale("en-US");
  runtime.pi.events.emit(LOCALE_CHANGED_EVENT, { locale: "en-US" });
  expect(runtime.captured.tools.get("advisor")!.description).toBe(initial.description);
  expect(runtime.captured.activeTools).not.toContain("advisor");
  const current = runtime.captured.tools.get("advisor");
  runtime.pi.events.emit(LOCALE_CHANGED_EVENT, { locale: "en-US" });
  expect(runtime.captured.tools.get("advisor")).toBe(current);
  for (const handler of runtime.captured.events.get("session_shutdown") ?? []) await handler({});
});
