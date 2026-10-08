import { createMockCtx, createMockPi } from "@maplezzk/pi-test-utils/rpiv";
import { expect, it, vi } from "vitest";
import registerTodo from "./index.js";
import type { TaskDetails } from "./todo.js";

it("nested factories stay isolated and a same-factory root replacement survives late old-root shutdown", async () => {
  const root = createMockPi();
  const child = createMockPi();
  registerTodo(root.pi);
  registerTodo(child.pi);

  const rootStart = root.captured.events.get("session_start")?.[0];
  const rootShutdown = root.captured.events.get("session_shutdown")?.[0];
  const rootToolEnd = root.captured.events.get("tool_execution_end")?.[0];
  const childStart = child.captured.events.get("session_start")?.[0];
  const childShutdown = child.captured.events.get("session_shutdown")?.[0];
  const rootTool = root.captured.tools.get("todo")!;
  const childTool = child.captured.tools.get("todo")!;
  const rootCommand = root.captured.commands.get("todos")!;

  const rootCtx = createMockCtx({ hasUI: true, mode: "tui", sessionId: "root" });
  const childCtx = createMockCtx({ hasUI: true, mode: "rpc", sessionId: "nested-child" });

  await rootStart?.({}, rootCtx);
  await rootTool.execute?.(
    "root-call",
    { action: "create", subject: "root task" } as never,
    undefined,
    undefined,
    rootCtx,
  );
  await rootToolEnd?.({ toolName: "todo", isError: false }, rootCtx);

  const rootWidget = rootCtx.ui.setWidget as ReturnType<typeof vi.fn>;
  expect(rootWidget).toHaveBeenCalledWith("rpiv-todos", expect.any(Function), { placement: "aboveEditor" });

  await childStart?.({}, childCtx);
  const childResult = await childTool.execute?.(
    "child-call",
    { action: "create", subject: "child task" } as never,
    undefined,
    undefined,
    childCtx,
  );
  expect((childResult?.details as TaskDetails).tasks.map((task) => task.subject)).toEqual(["child task"]);
  expect(childCtx.ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

  await childShutdown?.({}, childCtx);
  expect(rootWidget).not.toHaveBeenCalledWith("rpiv-todos", undefined);

  // Pi may reuse one extension factory while replacing the root session without
  // first shutting the old root down. The admitted TUI session must replace the
  // old render owner and clear only the old widget.
  const replacementCtx = createMockCtx({ hasUI: true, mode: "tui", sessionId: "replacement-root" });
  await rootStart?.({}, replacementCtx);
  expect(rootWidget).toHaveBeenCalledWith("rpiv-todos", undefined);

  await rootTool.execute?.(
    "replacement-call",
    { action: "create", subject: "replacement task" } as never,
    undefined,
    undefined,
    replacementCtx,
  );
  await rootToolEnd?.({ toolName: "todo", isError: false }, replacementCtx);
  const replacementWidget = replacementCtx.ui.setWidget as ReturnType<typeof vi.fn>;
  expect(replacementWidget).toHaveBeenCalledWith("rpiv-todos", expect.any(Function), { placement: "aboveEditor" });

  // A delayed shutdown from the replaced root may evict A's data, but it must
  // not dispose or clear B's active widget owner.
  await rootShutdown?.({}, rootCtx);
  expect(replacementWidget).not.toHaveBeenCalledWith("rpiv-todos", undefined);

  await rootCommand.handler("", replacementCtx as never);
  const replacementNotice = replacementCtx.ui.notify as ReturnType<typeof vi.fn>;
  expect(replacementNotice).toHaveBeenCalledWith(expect.stringContaining("replacement task"), "info");
  expect(replacementNotice.mock.calls.at(-1)?.[0]).not.toContain("root task");
  expect(replacementNotice.mock.calls.at(-1)?.[0]).not.toContain("child task");

  await rootShutdown?.({}, replacementCtx);
  expect(replacementWidget).toHaveBeenCalledWith("rpiv-todos", undefined);
});
