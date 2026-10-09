import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi } from "pi-utils/rpiv";
import { applyLocale, LOCALE_CHANGED_EVENT } from "pi-utils";
import { afterEach, expect, it } from "vitest";
import ask from "./index.js";

afterEach(() => applyLocale("en-US"));

it("rebuilds question schema after the startup locale and keeps hidden tools hidden on locale refresh", async () => {
  applyLocale("en-US");
  const runtime = createMockPi({ events: createEventBus() });
  ask(runtime.pi);
  const initial = runtime.captured.tools.get("ask_user_question")!;
  applyLocale("zh-CN");
  for (const handler of runtime.captured.events.get("session_start") ?? []) {
    await handler({}, createMockCtx({ mode: "rpc", hasUI: true }));
  }
  const chinese = runtime.captured.tools.get("ask_user_question")!;
  expect(chinese.description).not.toBe(initial.description);
  expect(JSON.stringify(chinese.parameters)).not.toBe(JSON.stringify(initial.parameters));
  expect(chinese.executionMode).toBe("sequential");
  runtime.captured.activeTools = [];
  applyLocale("en-US");
  runtime.pi.events.emit(LOCALE_CHANGED_EVENT, { locale: "en-US" });
  expect(runtime.captured.tools.get("ask_user_question")!.description).toBe(initial.description);
  expect(runtime.captured.activeTools).toEqual([]);
  for (const handler of runtime.captured.events.get("session_shutdown") ?? []) await handler({});
});
