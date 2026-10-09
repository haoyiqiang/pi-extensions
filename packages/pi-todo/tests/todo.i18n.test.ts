import { createMockCtx, createMockPi } from "pi-utils/rpiv";
import { applyLocale, clearLocaleOverride } from "pi-utils";
import { afterEach, expect, it } from "vitest";
import { __resetState, registerTodoTool } from "../todo.js";

afterEach(() => {
  clearLocaleOverride();
  __resetState();
});

it("catalogs model guidance, schema descriptions, and tool results in the active locale", async () => {
  applyLocale("zh-CN");
  const { pi, captured } = createMockPi();
  registerTodoTool(pi);
  const tool = captured.tools.get("todo")!;

  expect(tool.description).toContain("管理用于跟踪多步骤进度");
  expect(tool.promptSnippet).toContain("任务清单");
  expect(tool.promptGuidelines?.[0]).toContain("复杂工作");
  expect(JSON.stringify(tool.parameters)).toContain("任务主题");

  const result = await tool.execute?.(
    "call",
    { action: "create", subject: "实现功能" } as never,
    undefined,
    undefined,
    createMockCtx(),
  );
  expect(result?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("已创建 #1") });
});
