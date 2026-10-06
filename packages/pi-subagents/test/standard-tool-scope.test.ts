import { resolve } from "node:path";
import type { ExtensionAPI, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createStandardToolScope } from "../src/backends/terminal/standard-tool-scope.js";

it("keeps provider registration separate from extension-tool admission, including late tools", async () => {
  const path = resolve("provider-only.ts");
  const providerTools = new Map([["provider_write", {}]]);
  const handlers = new Map<string, (event?: any) => any>();
  let active: string[] = [];
  const allTools = ["read", "provider_write", "StructuredOutput"];
  const scope = createStandardToolScope({
    agent: { name: "readonly", description: "fixture", extensions: false },
    builtinTools: ["read"],
    readmitToolNames: new Set(["StructuredOutput"]),
    providerOnlyPaths: new Set([path]),
    getExtensions: () => ({ extensions: [{ path, resolvedPath: path, tools: providerTools }] }) as unknown as LoadExtensionsResult,
  });
  await scope.factory({
    on: (name: string, handler: (event?: any) => any) => handlers.set(name, handler),
    getAllTools: () => allTools.map(name => ({ name })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI);
  handlers.get("session_start")!();
  expect(active).toEqual(["read", "StructuredOutput"]);
  providerTools.set("late_provider_write", {});
  allTools.push("late_provider_write");
  handlers.get("turn_end")!();
  expect(active).toEqual(["read", "StructuredOutput"]);
  expect(handlers.get("tool_call")!({ toolName: "late_provider_write" })).toMatchObject({ block: true });
  expect(handlers.get("tool_call")!({ toolName: "read" })).toBeUndefined();
});
