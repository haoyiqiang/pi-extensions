import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi } from "pi-utils/rpiv";
import { applyLocale, LOCALE_CHANGED_EVENT } from "pi-utils";
import { afterEach, expect, it } from "vitest";
import todo from "./index.js";

afterEach(() => applyLocale("en-US"));

it("rebuilds tool schema and command metadata in the active startup and live locale", async () => {
  applyLocale("en-US");
  const runtime = createMockPi({ events: createEventBus() });
  todo(runtime.pi);
  const initial = runtime.captured.tools.get("todo")!;
  const initialCommand = runtime.captured.commands.get("todos")!.description;
  const ctx = createMockCtx({ mode: "rpc", hasUI: true });
  applyLocale("zh-CN");
  for (const handler of runtime.captured.events.get("session_start") ?? []) await handler({}, ctx);
  const chinese = runtime.captured.tools.get("todo")!;
  expect(chinese.description).not.toBe(initial.description);
  expect(JSON.stringify(chinese.parameters)).not.toBe(JSON.stringify(initial.parameters));
  expect(runtime.captured.commands.get("todos")!.description).not.toBe(initialCommand);
  applyLocale("en-US");
  runtime.pi.events.emit(LOCALE_CHANGED_EVENT, { locale: "en-US" });
  expect(runtime.captured.tools.get("todo")!.description).toBe(initial.description);
  const current = runtime.captured.tools.get("todo");
  runtime.pi.events.emit(LOCALE_CHANGED_EVENT, { locale: "en-US" });
  expect(runtime.captured.tools.get("todo")).toBe(current);
  for (const handler of runtime.captured.events.get("session_shutdown") ?? []) await handler({}, ctx);
});
