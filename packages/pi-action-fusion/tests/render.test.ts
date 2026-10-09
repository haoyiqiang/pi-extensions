import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createEditToolDefinition, createWriteToolDefinition, initTheme, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createActionFusionExtension, THEN_RUN_SUCCEEDED, THEN_RUN_FAILED, THEN_RUN_RUNNING, THEN_RUN_SKIPPED } from "../index.ts";

initTheme("dark", false);
type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Parameters<NonNullable<ToolDefinition["renderCall"]>>[1];

function tools() {
  const registered = new Map<string, ToolDefinition>();
  createActionFusionExtension()({ registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool) } as unknown as ExtensionAPI);
  return registered;
}
function renderContext(args: unknown): RenderContext {
  return { args, cwd: process.cwd(), toolCallId: "render-test", state: {}, invalidate() {}, lastComponent: undefined,
    executionStarted: false, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false };
}
function locale(t: TestContext, language = "en-US") {
  const previous = process.env.PI_EXTENSIONS_LOCALE;
  process.env.PI_EXTENSIONS_LOCALE = language;
  t.after(() => { if (previous === undefined) delete process.env.PI_EXTENSIONS_LOCALE; else process.env.PI_EXTENSIONS_LOCALE = previous; });
}
const args = () => ({ path: "target.txt", content: "after\n", then_run: { command: "check 中文-output", timeout: 12 } });
function success(output = "", status: "running" | "succeeded" = "succeeded") {
  return { content: [{ type: "text" as const, text: "Successfully wrote target.txt" }, { type: "text" as const, text: `${status === "running" ? THEN_RUN_RUNNING : THEN_RUN_SUCCEEDED}${output ? `\n${output}` : ""}` }],
    details: { actionFusion: { status, command: args().then_run.command } } };
}
function row(tool: ToolDefinition, input: unknown, result: Parameters<NonNullable<ToolDefinition["renderResult"]>>[0], context: RenderContext, expanded = false, width = 80) {
  context.args = input;
  context.expanded = expanded;
  const call = tool.renderCall!(input, plainTheme, context);
  const content = tool.renderResult!(result, { expanded, isPartial: context.isPartial }, plainTheme, context);
  return [...call.render(width), ...content.render(width)];
}

for (const name of ["edit", "write"] as const) {
  test(`${name} without then_run preserves native call and result rendering`, (t) => {
    locale(t);
    const tool = tools().get(name)!;
    const native = name === "edit" ? createEditToolDefinition(process.cwd()) : createWriteToolDefinition(process.cwd());
    const input = name === "edit" ? { path: "target.txt", edits: [{ oldText: "before", newText: "after" }] } : { path: "target.txt", content: "after\n" };
    assert.deepEqual(tool.renderCall!(input, plainTheme, renderContext(input)).render(80), native.renderCall!(input as never, plainTheme, renderContext(input) as never).render(80));
    const result = { content: [{ type: "text" as const, text: "Successfully wrote target.txt" }], details: undefined };
    assert.deepEqual(tool.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, renderContext(input)).render(80), native.renderResult!(result as never, { expanded: false, isPartial: false }, plainTheme, renderContext(input) as never).render(80));
  });
}

test("pending fused call is one header with separate mutation and command phases", (t) => {
  locale(t);
  const tool = tools().get("write")!;
  const input = args();
  const context = renderContext(input);
  const component = tool.renderCall!(input, plainTheme, context);
  const text = component.render(80).join("\n");
  assert.match(text, /target.txt.*Fusion/);
  assert.match(text, /Waiting to modify/);
  assert.match(text, /Follow-up command · Waiting/);
  assert.equal((text.match(/check 中文-output/g) ?? []).length, 1);
  for (const width of [1, 2, 8, 20, 80]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
  context.executionStarted = true;
  assert.match(tool.renderCall!(input, plainTheme, context).render(80).join("\n"), /Modifying/);
});

test("Fusion badge fits the native header even with ANSI-styled padding", (t) => {
  locale(t);
  const tool = tools().get("write")!;
  const input = args();
  const theme = { ...plainTheme, fg: (_color: string, value: string) => `\u001b[32m${value}\u001b[39m`, bg: (_color: string, value: string) => `\u001b[40m${value}\u001b[49m` } as typeof plainTheme;
  const lines = tool.renderCall!(input, theme, renderContext(input)).render(80);
  assert.match(lines[0], /Fusion/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 80);
});

test("collapsed success shows phases only; expansion reveals native logs and secondary benefit", (t) => {
  locale(t);
  const tool = tools().get("write")!;
  const input = args();
  const context = renderContext(input);
  const output = Array.from({ length: 30 }, (_, index) => `diagnostic-line-${index}`).join("\n");
  const collapsed = row(tool, input, success(output), context).join("\n");
  assert.match(collapsed, /Changes saved/);
  assert.match(collapsed, /exit 0/);
  assert.doesNotMatch(collapsed, /then_run:|diagnostic-line|round-trip|Waiting/);
  assert.equal((collapsed.match(/check 中文-output/g) ?? []).length, 1);
  const expanded = row(tool, input, success(output), context, true).join("\n");
  assert.match(expanded, /diagnostic-line-0/);
  assert.match(expanded, /diagnostic-line-29/);
  assert.match(expanded, /1 model round-trip avoided/);
  assert.doesNotMatch(expanded, /then_run:/);
  assert.equal((expanded.match(/check 中文-output/g) ?? []).length, 1);
});

test("normalized command failure keeps saved mutation distinct from failed command after reload", (t) => {
  locale(t);
  const tool = tools().get("write")!;
  const input = args();
  const context = renderContext(input);
  context.isError = true;
  const result = { content: [{ type: "text" as const, text: `Successfully wrote target.txt\n\n${THEN_RUN_FAILED}\n\ntest failed\n\nCommand exited with code 7` }], details: undefined };
  const collapsed = row(tool, input, result, context).join("\n");
  assert.match(collapsed, /Changes saved; not rolled back/);
  assert.match(collapsed, /exit 7/);
  assert.doesNotMatch(collapsed, /Mutation failed|then_run:/);
  const expanded = row(tool, input, result, context, true).join("\n");
  assert.match(expanded, /Successfully wrote target.txt/);
  assert.match(expanded, /test failed/);
  assert.doesNotMatch(expanded, /then_run:|round-trip/);
});

for (const [footer, expected] of [["Command timed out after 12 seconds", "Timed out"], ["Command aborted", "Cancelled"]]) {
  test(`normalized failure distinguishes ${expected}`, (t) => {
    locale(t);
    const tool = tools().get("write")!;
    const input = args();
    const context = renderContext(input); context.isError = true;
    const result = { content: [{ type: "text" as const, text: `Successfully wrote target.txt\n\n${THEN_RUN_FAILED}\n\n${footer}` }], details: undefined };
    const text = row(tool, input, result, context).join("\n");
    assert.match(text, /Changes saved; not rolled back/);
    assert.ok(text.includes(expected));
    assert.doesNotMatch(text, /then_run:/);
  });
}

for (const storedMessage of [
  "The file mutation did not complete successfully; the command was not run.",
  "文件修改未成功完成，未执行后续命令。",
] as const) {
  test(`skipped mutation failure survives stored message ${storedMessage}`, () => {
    const tool = tools().get("write")!;
    const input = args();
    const context = renderContext(input); context.isError = true;
    const result = { content: [{ type: "text" as const, text: `permission denied\n\n${THEN_RUN_SKIPPED} ${storedMessage}` }], details: undefined };
    const text = row(tool, input, result, context, true).join("\n");
    assert.match(text, /Mutation failed/);
    assert.match(text, /Not run/);
    assert.match(text, /permission denied/);
    assert.doesNotMatch(text, /Changes saved|then_run:/);
  });
}

test("interference skips only the command and preserves mutation confirmation", () => {
  const tool = tools().get("write")!;
  const input = args();
  const context = renderContext(input); context.isError = true;
  const result = { content: [{ type: "text" as const, text: `Successfully wrote target.txt\n\n${THEN_RUN_SKIPPED} 执行后续命令前，目标文件内容发生了变化。 未执行后续命令。` }], details: undefined };
  const text = row(tool, input, result, context, true).join("\n");
  assert.match(text, /Changes saved/);
  assert.match(text, /Not run/);
  assert.match(text, /Successfully wrote target.txt/);
  assert.doesNotMatch(text, /Mutation failed|then_run:/);
});

test("partial running transitions to completion without duplicated command or stale pending rows", (t) => {
  locale(t);
  const tool = tools().get("write")!;
  const input = args();
  const context = renderContext(input); context.isPartial = true; context.executionStarted = true;
  const running = row(tool, input, success("", "running"), context).join("\n");
  assert.match(running, /Changes saved/);
  assert.match(running, /Running/);
  assert.doesNotMatch(running, /Waiting|then_run:/);
  context.isPartial = false;
  const finished = row(tool, input, success("done"), context).join("\n");
  assert.match(finished, /exit 0/);
  assert.doesNotMatch(finished, /Running|Waiting|then_run:/);
});

test("unknown or ambiguous results fall back to native text instead of fabricating phases", (t) => {
  locale(t);
  const tool = tools().get("write")!;
  const input = args();
  for (const text of ["unknown error", `${THEN_RUN_FAILED}\nlog\n${THEN_RUN_SKIPPED} reason`, `Successfully wrote target.txt\n\n${THEN_RUN_SKIPPED} unrecognized reason`]) {
    const context = renderContext(input); context.isError = true;
    const result = { content: [{ type: "text" as const, text }], details: undefined };
    const rendered = row(tool, input, result, context, true).join("\n");
    assert.ok(text.split("\n").every((line) => rendered.includes(line)));
    assert.doesNotMatch(rendered, /Changes saved|Waiting to modify|Follow-up command/);
  }
});

test("expanded edit reuses the committed native diff in the mutation section", (t) => {
  locale(t);
  const tool = tools().get("edit")!;
  const input = { path: "parser.ts", edits: [{ oldText: "before", newText: "after" }], then_run: args().then_run };
  const result = { ...success("command done"), details: { ...success().details, diff: "-1 before\n+1 after", firstChangedLine: 1 } };
  const context = renderContext(input);
  const collapsed = row(tool, input, result, context).join("\n");
  assert.doesNotMatch(collapsed, /before|after|command done/);
  const expanded = row(tool, input, result, context, true).join("\n");
  assert.match(expanded, /before/);
  assert.match(expanded, /after/);
  assert.ok(expanded.indexOf("Mutation") < expanded.indexOf("before"));
  assert.match(expanded, /command done/);
});

test("collapsed command previews normalize carriage returns and control characters", (t) => {
  locale(t);
  const tool = tools().get("write")!;
  const input = { ...args(), then_run: { command: "check\rreport\u0007\tend\u001b[31m", timeout: 12 } };
  const lines = tool.renderCall!(input, plainTheme, renderContext(input)).render(120);
  const preview = lines.find((line) => line.includes("Follow-up command"))!;
  assert.match(preview, /check ↵ report  end/);
  assert.doesNotMatch(preview, /[\u0000-\u001f\u007f]/);
});

test("English labels and wide content fit narrow columns without changing tool results", () => {
  const tool = tools().get("write")!;
  const input = args();
  const result = success("中文 ⚠️ 日志\n第二行");
  const before = JSON.stringify(result);
  for (const expanded of [false, true]) for (const width of [1, 2, 8, 20, 80]) {
    const lines = row(tool, input, result, renderContext(input), expanded, width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const text = row(tool, input, result, renderContext(input)).join("\n");
  assert.match(text, /Changes saved/);
  assert.match(text, /exit 0/);
  assert.equal(JSON.stringify(result), before);
});
