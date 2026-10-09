import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withTempAgentDir } from "pi-utils";
import { clearConfigCache } from "../src/config/index.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createSurfaceRenameContext, resolveTerminalRenameTargets, TERMINAL_RENAME_CONTEXT_ENV, type TerminalRenameTarget } from "pi-terminal-mux";
import { parseConfig } from "../src/features/naming/config.ts";
import { registerNaming, registerNamingConfigCommand, registerNamingFeature, type NamingConfigSelection, type TerminalNamingAdapter } from "../src/features/naming/index.ts";
import type { SessionNameRequest } from "../src/features/naming/session-name.ts";

type Input = { text?: string; source?: string };
type Handler = (event: Input, ctx: ExtensionContext) => unknown;

/** 最小宿主，保存 session 状态、命令与通知。 */
function harness(messages: string[] = []) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const notices: string[] = [];
  const renamed: Array<[TerminalRenameTarget, string]> = [];
  let sessionId = "session-1";
  const names = new Map<string, string>();
  const pi = {
    on: (event: string, handler: Handler) => {
      assert.equal(events.has(event), false, `duplicate listener: ${event}`);
      events.set(event, handler);
    },
    registerCommand: (command: string, handler: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => {
      assert.equal(commands.has(command), false, `duplicate command: ${command}`);
      commands.set(command, handler);
    },
    getSessionName: () => names.get(sessionId),
    setSessionName: (value: string) => { names.set(sessionId, value); },
    sendMessage: (message: { content: string }) => notices.push(message.content),
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    sessionManager: {
      getBranch: () => messages.map((content) => ({ type: "message", message: { role: "user", content } })),
      getSessionId: () => sessionId,
    },
  } as unknown as ExtensionCommandContext;
  const terminal: TerminalNamingAdapter = {
    resolve: (options) => resolveTerminalRenameTargets({ ...options, backend: "cmux", env: {
      CMUX_SURFACE_ID: "own-tab", CMUX_WORKSPACE_ID: "own-workspace",
    } }),
    rename: (reference, title) => { renamed.push([reference, title]); return { status: "renamed", reference }; },
  };
  return {
    pi, ctx, events, commands, notices, renamed, terminal, name: () => names.get(sessionId),
    switchSession: (id: string, nextMessages: string[] = []) => { sessionId = id; messages = nextMessages; },
  };
}

/** 等待 fire-and-forget 命名的微任务结束，不依赖固定睡眠时长。 */
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

test("只注册 /rename，显式名称同步三个目标且不调用模型", async () => {
  const h = harness();
  const label = "Explicit title longer than fifteen characters";
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => assert.fail("unexpected model") });
  assert.deepEqual([...h.commands.keys()], ["rename"]);
  await h.commands.get("rename")!.handler(label, h.ctx);
  assert.equal(h.name(), label);
  assert.deepEqual(h.renamed.map(([, title]) => title), [label, label]);
});

test("命名仅按 targets 请求明确终端目标，不转换后端环境变量", async () => {
  const h = harness();
  let options: Parameters<TerminalNamingAdapter["resolve"]>[0] | undefined;
  h.terminal.resolve = (value) => { options = value; return []; };
  await registerNaming(h.pi, parseConfig({ targets: { session: false, workspace: true, tab: false } }), { loadTerminal: async () => h.terminal });
  await h.commands.get("rename")!.handler("Workspace title", h.ctx);
  assert.deepEqual(options, { tab: false, workspace: true });
});

test("配置菜单保存 targets 后，reload 的自动与手动入口只作用于保存的目标", async () => {
  const menu = harness();
  let saved = parseConfig({});
  let selectedTarget = false;
  Object.assign(menu.ctx.ui, {
    select: async (_title: string, choices: string[]) => {
      if (!selectedTarget) {
        selectedTarget = true;
        return choices.find((choice) => /session|会话/.test(choice));
      }
      return choices.at(-1);
    },
    input: async () => assert.fail("unexpected config input"),
  });
  registerNamingConfigCommand(menu.pi, {
    load: () => saved,
    save: (config) => { saved = config; },
    path: () => "/configured/pi-naming.json",
  });
  await menu.commands.get("config:naming")!.handler("", menu.ctx);
  assert.equal(saved.targets.session, false);

  const manual = harness();
  await registerNaming(manual.pi, saved, { loadTerminal: async () => manual.terminal });
  await manual.commands.get("rename")!.handler("Saved target", manual.ctx);
  assert.equal(manual.name(), undefined);
  assert.deepEqual(manual.renamed.map(([reference]) => reference.operation), ["workspace", "tab"]);

  const reloaded = harness();
  await registerNaming(reloaded.pi, parseConfig({ automaticNaming: true, manualNaming: false, targets: { workspace: false, tab: false } }), {
    loadTerminal: async () => assert.fail("terminal must not load after reload"),
    requestName: async () => "Automatic session",
  });
  reloaded.events.get("session_start")!({}, reloaded.ctx);
  reloaded.events.get("input")!({ text: "Task", source: "interactive" }, reloaded.ctx);
  await flush();
  assert.equal(reloaded.name(), "Automatic session");
  assert.equal(reloaded.renamed.length, 0);
});

test("首条真实输入和手动生成使用相同目标、标题配置", async () => {
  for (const automatic of [true, false]) {
    const h = harness(automatic ? [] : ["Task"]);
    const config = parseConfig({ title: { language: "English" } });
    const requests: SessionNameRequest[] = [];
    await registerNaming(h.pi, config, { loadTerminal: async () => h.terminal, requestName: async (request) => {
      requests.push(request); return "Generated";
    } });
    h.events.get("session_start")!({}, h.ctx);
    if (automatic) {
      h.events.get("input")!({ text: "Task", source: "interactive" }, h.ctx);
      await flush();
      h.events.get("input")!({ text: "Second task", source: "interactive" }, h.ctx);
      await flush();
    } else await h.commands.get("rename")!.handler("", h.ctx);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.userMessages, ["Task"]);
    assert.deepEqual(requests[0]?.title, config.title);
    assert.equal(h.name(), "Generated");
    assert.equal(h.renamed.length, 2);
  }
});

test("手动重新命名传入当前分支全部用户消息，包括纠正与流程性跟进", async () => {
  const messages = ["修复订单导出", "纠正：是订单筛选，不是导出", "继续", "验证一下", "提交"];
  const h = harness(messages);
  const requests: SessionNameRequest[] = [];
  h.pi.setSessionName("旧标题");
  await registerNaming(h.pi, parseConfig({}), {
    loadTerminal: async () => h.terminal,
    requestName: async (request) => { requests.push(request); return "修复订单筛选"; },
  });
  await h.commands.get("rename")!.handler("", h.ctx);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.userMessages, messages);
  assert.equal(h.name(), "修复订单筛选");
});

test("session-only 不加载终端；目标开关不阻止其他目标", async () => {
  const h = harness();
  await registerNaming(h.pi, parseConfig({ targets: { workspace: false, tab: false } }), {
    loadTerminal: async () => assert.fail("terminal must not load"),
  });
  await h.commands.get("rename")!.handler("Session only", h.ctx);
  assert.equal(h.name(), "Session only");
  const terminalOnly = harness();
  await registerNaming(terminalOnly.pi, parseConfig({ targets: { session: false, workspace: false } }), {
    loadTerminal: async () => terminalOnly.terminal,
  });
  await terminalOnly.commands.get("rename")!.handler("Tab only", terminalOnly.ctx);
  assert.equal(terminalOnly.name(), undefined);
  assert.equal(terminalOnly.renamed.length, 1);
});

test("disabled entries keep registration stable without model or terminal side effects", async () => {
  for (const config of [false, parseConfig({ automaticNaming: false, manualNaming: false }), parseConfig({ targets: { session: false, workspace: false, tab: false } })] as const) {
    const h = harness();
    registerNaming(h.pi, config, {
      loadTerminal: async () => assert.fail("unexpected load"),
      requestName: async () => assert.fail("unexpected model"),
    });
    assert.equal(h.events.has("input"), true);
    assert.equal(h.commands.has("rename"), true);
    h.events.get("session_start")!({}, h.ctx);
    h.events.get("input")!({ text: "Task", source: "interactive" }, h.ctx);
    await h.commands.get("rename")!.handler("", h.ctx);
    await h.commands.get("rename")!.handler("Explicit", h.ctx);
    await flush();
    assert.equal(h.name(), undefined);
    assert.equal(h.renamed.length, 0);
    assert.equal(h.notices.length, 2);
  }
});

test("automatic and manual switches are independent runtime guards", async () => {
  for (const automaticNaming of [true, false]) {
    const h = harness();
    let requests = 0;
    registerNaming(h.pi, parseConfig({ automaticNaming, manualNaming: !automaticNaming }), {
      loadTerminal: async () => h.terminal,
      requestName: async () => { requests++; return "Automatic"; },
    });
    h.events.get("session_start")!({}, h.ctx);
    h.events.get("input")!({ text: "Task", source: "interactive" }, h.ctx);
    await flush();
    assert.equal(requests, automaticNaming ? 1 : 0);
    await h.commands.get("rename")!.handler("Manual", h.ctx);
    assert.equal(h.name(), automaticNaming ? "Automatic" : "Manual");
  }
});

test("一个终端失败不影响 session 或其他终端，错误不伪报成功", async () => {
  const h = harness();
  h.terminal.rename = (reference) => {
    if (reference.operation === "workspace") throw new Error("workspace failure");
    return { status: "renamed", reference };
  };
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal });
  await h.commands.get("rename")!.handler("Name", h.ctx);
  assert.equal(h.name(), "Name");
  assert.ok(h.notices.some((message) => message.includes("workspace failure")));
});

test("没有终端、加载失败或协议损坏仍能改 session，并报告原因", async () => {
  for (const failure of ["headless", "load", "context"]) {
    const h = harness();
    h.terminal.resolve = () => {
      if (failure === "context") throw new Error("invalid context");
      return [{ status: "skipped", operation: "tab", reason: "unsupported" }];
    };
    await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => {
      if (failure === "load") throw new Error("load failed");
      return h.terminal;
    } });
    h.events.get("session_start")!({}, h.ctx);
    await h.commands.get("rename")!.handler("Name", h.ctx);
    assert.equal(h.name(), "Name");
    assert.ok(h.notices.length > 1);
  }
});

for (const backend of ["cmux", "tmux", "herdr"] as const) {
  test(`${backend} 组合子代理只修改获授目标，绝不改 workspace`, async () => {
    const h = harness();
    const context = createSurfaceRenameContext("child", backend);
    h.terminal.resolve = (options) => resolveTerminalRenameTargets({ ...options, backend,
      env: { [TERMINAL_RENAME_CONTEXT_ENV]: JSON.stringify(context) } });
    await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal });
    await h.commands.get("rename")!.handler("Child", h.ctx);
    assert.equal(h.name(), "Child");
    assert.ok(h.renamed.every(([target]) => target.operation !== "workspace" && target.id === "child"));
    assert.equal(h.renamed.length, backend === "cmux" || backend === "herdr" ? 1 : 0);
    assert.ok(h.notices.some((message) => /共享|shared/.test(message)));
  });
}

for (const lifecycle of ["session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown", "session_tree"]) {
  test(`${lifecycle} 后丢弃旧结果和旧错误`, async () => {
    for (const reject of [false, true]) {
      const h = harness(["Task"]);
      let finish!: (title: string) => void;
      let fail!: (error: Error) => void;
      const pending = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
      await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => pending });
      const running = h.commands.get("rename")!.handler("", h.ctx);
      await flush();
      h.events.get(lifecycle)!({}, h.ctx);
      if (reject) fail(new Error("stale")); else finish("Stale");
      await running;
      assert.equal(h.name(), undefined);
      assert.equal(h.renamed.length, 0);
      assert.deepEqual(h.notices, []);
    }
  });
}

test("后续手动命令优先于正在生成的自动标题", async () => {
  const h = harness();
  let finish!: (title: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => pending });
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "Task", source: "interactive" }, h.ctx);
  await h.commands.get("rename")!.handler("Manual", h.ctx);
  finish("Stale");
  await flush();
  assert.equal(h.name(), "Manual");
  assert.deepEqual(h.renamed.map(([, name]) => name), ["Manual", "Manual"]);
});

test("已有名称、空输入、扩展输入和已有历史不会触发自动命名", async () => {
  for (const scenario of ["named", "blank", "extension", "history"]) {
    const h = harness(scenario === "history" ? ["History"] : []);
    if (scenario === "named") h.pi.setSessionName("Existing");
    await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => assert.fail("unexpected request") });
    h.events.get("session_start")!({}, h.ctx);
    h.events.get("input")!({ text: scenario === "blank" ? " " : "Task", source: scenario === "extension" ? "extension" : "interactive" }, h.ctx);
    await flush();
    assert.equal(h.renamed.length, 0);
  }
});

test("无 UI 模式仍可看到终端跳过原因", async () => {
  const h = harness();
  Object.assign(h.ctx, { hasUI: false });
  h.terminal.resolve = () => [{ status: "skipped", operation: "tab", reason: "unverified" }];
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal });
  await h.commands.get("rename")!.handler("Name", h.ctx);
  assert.ok(h.notices.some((message) => /归属|ownership/.test(message)));
});


test("生成期间原生命名生效后自动结果不再改任何目标", async () => {
  const h = harness();
  let finish!: (title: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => pending });
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "Task", source: "interactive" }, h.ctx);
  h.pi.setSessionName("Native name");
  finish("Stale");
  await flush();
  assert.equal(h.name(), "Native name");
  assert.equal(h.renamed.length, 0);
});

test("后续手动命令取代旧手动请求，使用捕获的终端目标", async () => {
  const h = harness(["Task"]);
  let finish!: (title: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => pending });
  const old = h.commands.get("rename")!.handler("", h.ctx);
  await h.commands.get("rename")!.handler("New", h.ctx);
  finish("Old");
  await old;
  assert.equal(h.name(), "New");
  assert.deepEqual(h.renamed.map(([, title]) => title), ["New", "New"]);
});

test("标题超时保留旧状态，错误可见", async () => {
  const h = harness(["Task"]);
  const timeoutMs = 5;
  await registerNaming(h.pi, parseConfig({ title: { timeoutMs } }), {
    loadTerminal: async () => h.terminal,
    requestName: async () => new Promise<string>(() => undefined),
  });
  await h.commands.get("rename")!.handler("", h.ctx);
  assert.equal(h.name(), undefined);
  assert.equal(h.renamed.length, 0);
  assert.ok(h.notices.some((message) => /超时|timed out/.test(message)));
});

test("registration does not read config or load mux; terminal loading stays lazy and cached", async () => {
  const h = harness(["Task"]);
  let reads = 0;
  let loads = 0;
  registerNaming(h.pi, (ctx) => {
    assert.equal(ctx, h.ctx);
    reads++;
    return parseConfig({});
  }, { loadTerminal: async () => { loads++; return h.terminal; } });
  assert.equal(reads, 0);
  assert.equal(loads, 0);
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("session_start")!({}, h.ctx);
  assert.equal(loads, 0);
  await h.commands.get("rename")!.handler("First", h.ctx);
  await h.commands.get("rename")!.handler("Second", h.ctx);
  assert.equal(loads, 1);
  assert.equal(h.name(), "Second");
});

test("Spark feature registers all aliases once without a context or a renderer", () => {
  const h = harness();
  registerNamingFeature(h.pi);
  assert.deepEqual([...h.commands.keys()], ["config:naming", "naming-config", "pi-naming-config", "rename"]);
  assert.deepEqual([...h.events.keys()], ["session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown", "session_tree", "input"]);
});

test("switched sessions select independent config and eligibility without reregistering", async () => {
  const h = harness();
  let requests = 0;
  registerNaming(h.pi, (ctx) => ctx.sessionManager.getSessionId() === "disabled" ? false : parseConfig({ targets: { workspace: false, tab: false } }), {
    requestName: async () => { requests++; return "Enabled title"; },
    loadTerminal: async () => assert.fail("session-only must never load mux"),
  });
  h.switchSession("disabled");
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "Disabled task", source: "interactive" }, h.ctx);
  await h.commands.get("rename")!.handler("Disabled explicit", h.ctx);
  assert.equal(requests, 0);
  assert.equal(h.name(), undefined);
  h.switchSession("enabled");
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "Enabled task", source: "rpc" }, h.ctx);
  await flush();
  assert.equal(requests, 1);
  assert.equal(h.name(), "Enabled title");
  h.switchSession("disabled");
  h.events.get("session_start")!({}, h.ctx);
  await h.commands.get("rename")!.handler("", h.ctx);
  assert.equal(requests, 1);
  assert.equal(h.name(), undefined);
});

test("failed automatic attempts remain once-only across switches; new sessions get their own attempt", async () => {
  const h = harness();
  let requests = 0;
  registerNaming(h.pi, parseConfig({ targets: { workspace: false, tab: false } }), {
    requestName: async () => { requests++; throw new Error("failed attempt"); },
  });
  h.events.get("session_start")!({}, h.ctx);
  for (const text of ["", "   "]) h.events.get("input")!({ text, source: "interactive" }, h.ctx);
  h.events.get("input")!({ text: "Injected", source: "extension" }, h.ctx);
  assert.equal(requests, 0);
  h.events.get("input")!({ text: "First", source: "interactive" }, h.ctx);
  await flush();
  h.events.get("input")!({ text: "Second", source: "interactive" }, h.ctx);
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "Third", source: "interactive" }, h.ctx);
  await flush();
  assert.equal(requests, 1);
  h.switchSession("session-2");
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "New task", source: "interactive" }, h.ctx);
  await flush();
  assert.equal(requests, 2);
  h.switchSession("session-1");
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "Still attempted", source: "interactive" }, h.ctx);
  await flush();
  assert.equal(requests, 2);
});

test("disabled first real input cannot become a later automatic attempt", async () => {
  const h = harness();
  let config: NamingConfigSelection = false;
  registerNaming(h.pi, () => config, {
    requestName: async () => assert.fail("not the first input"),
    loadTerminal: async () => assert.fail("disabled naming must not load mux"),
  });
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "First while disabled", source: "interactive" }, h.ctx);
  config = parseConfig({});
  h.events.get("input")!({ text: "Later", source: "interactive" }, h.ctx);
  await flush();
  assert.equal(h.name(), undefined);
});

test("switches during terminal import cannot resolve targets or start stale model calls", async () => {
  for (const fail of [false, true]) {
    const h = harness(["Task"]);
    let resolve!: (adapter: TerminalNamingAdapter) => void;
    let reject!: (error: Error) => void;
    const loading = new Promise<TerminalNamingAdapter>((done, failed) => { resolve = done; reject = failed; });
    h.terminal.resolve = () => assert.fail("stale terminal resolution");
    registerNaming(h.pi, parseConfig({}), {
      loadTerminal: async () => loading,
      requestName: async () => assert.fail("stale model call"),
    });
    const running = h.commands.get("rename")!.handler("", h.ctx);
    await flush();
    h.switchSession("new-session");
    h.events.get("session_start")!({}, h.ctx);
    if (fail) reject(new Error("stale load failure"));
    else resolve(h.terminal);
    await running;
    assert.equal(h.name(), undefined);
    assert.deepEqual(h.notices, []);
  }
});

test("disabling naming or revoking targets discards pending titles and errors", async () => {
  for (const reject of [false, true]) {
    for (const disabled of [false, parseConfig({ targets: { workspace: false, tab: false } })] as const) {
      const h = harness(["Task"]);
      let config: NamingConfigSelection = parseConfig({});
      let finish!: (title: string) => void;
      let fail!: (error: Error) => void;
      const pending = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
      registerNaming(h.pi, () => config, { loadTerminal: async () => h.terminal, requestName: async () => pending });
      const running = h.commands.get("rename")!.handler("", h.ctx);
      await flush();
      config = disabled;
      if (reject) fail(new Error("old error")); else finish("Old title");
      await running;
      assert.equal(h.name(), undefined);
      assert.equal(h.renamed.length, 0);
      assert.deepEqual(h.notices, []);
    }
  }
});

test("terminal IDs are captured before generation instead of following later focus", async () => {
  const h = harness(["Task"]);
  let finish!: (title: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => pending });
  const running = h.commands.get("rename")!.handler("", h.ctx);
  await flush();
  h.terminal.resolve = () => assert.fail("must reuse captured IDs");
  finish("Captured targets");
  await running;
  assert.deepEqual(h.renamed.map(([target]) => target.id), ["own-workspace", "own-tab"]);
});

test("tree navigation invalidates eligibility until a different session is selected", async () => {
  const h = harness();
  let requests = 0;
  registerNaming(h.pi, parseConfig({ targets: { workspace: false, tab: false } }), {
    requestName: async () => { requests++; return "New"; },
  });
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("session_tree")!({}, h.ctx);
  h.events.get("input")!({ text: "Navigated branch", source: "interactive" }, h.ctx);
  await flush();
  assert.equal(requests, 0);
  h.switchSession("new-session");
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "Fresh task", source: "interactive" }, h.ctx);
  await flush();
  assert.equal(requests, 1);
});

test("configuration errors disable side effects without preventing later sessions from enabling naming", async () => {
  const h = harness();
  registerNaming(h.pi, (ctx) => {
    if (ctx.sessionManager.getSessionId() === "session-1") throw new Error("broken config");
    return parseConfig({ targets: { workspace: false, tab: false } });
  }, { loadTerminal: async () => assert.fail("unexpected terminal") });
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "Task", source: "interactive" }, h.ctx);
  assert.equal(h.notices.filter((notice) => notice.includes("broken config")).length, 1);
  h.switchSession("valid-session");
  h.events.get("session_start")!({}, h.ctx);
  await h.commands.get("rename")!.handler("Valid", h.ctx);
  assert.equal(h.name(), "Valid");
});

test("all config aliases forward ctx to the store and use its returned path", async () => {
  const h = harness();
  let loaded = 0;
  let saved = 0;
  registerNamingConfigCommand(h.pi, {
    load: (ctx) => { assert.equal(ctx, h.ctx); loaded++; return false; },
    save: (config, ctx) => {
      assert.equal(ctx, h.ctx);
      assert.deepEqual(config, parseConfig({}));
      saved++;
      return "project/.pi/spark.json";
    },
    path: () => assert.fail("save already returned the selected path"),
  });
  await h.commands.get("config:naming")!.handler("", h.ctx);
  assert.equal(loaded, 1);
  for (const alias of ["config:naming", "naming-config", "pi-naming-config"]) {
    await h.commands.get(alias)!.handler("reset", h.ctx);
  }
  assert.equal(saved, 3);
  assert.equal(h.notices.filter((notice) => notice.includes("project/.pi/spark.json")).length, 3);
});

test("non-UI reports send the Pi message without triggering a turn", async () => {
  const h = harness();
  Object.assign(h.ctx, { hasUI: false, mode: "json" });
  const messages: unknown[] = [];
  h.pi.sendMessage = ((message: unknown, options: unknown) => messages.push({ message, options })) as ExtensionAPI["sendMessage"];
  registerNaming(h.pi, parseConfig({ targets: { workspace: false, tab: false } }));
  await h.commands.get("rename")!.handler("Non-UI", h.ctx);
  assert.equal(messages.length, 1);
  const sent = messages[0] as { message: { customType: string; content: string; display: boolean }; options: { triggerTurn: boolean } };
  assert.equal(sent.message.customType, "pi-spark");
  assert.match(sent.message.content, /Non-UI/);
  assert.equal(sent.message.display, true);
  assert.deepEqual(sent.options, { triggerTurn: false });
});

test("production registration selects Spark naming per context and sends config writes to the selected scope", async () => {
  await withTempAgentDir(async (agentDir) => {
    clearConfigCache();
    try {
      const disabled = join(agentDir, "disabled-project");
      const enabled = join(agentDir, "enabled-project");
      mkdirSync(join(enabled, ".pi"), { recursive: true });
      mkdirSync(disabled, { recursive: true });
      const globalPath = join(agentDir, "spark.json");
      const projectPath = join(enabled, ".pi", "spark.json");
      const global = { naming: false, footer: false };
      writeFileSync(globalPath, JSON.stringify(global));
      writeFileSync(projectPath, JSON.stringify({ naming: { targets: { workspace: false, tab: false } }, metrics: false }));
      const h = harness();
      registerNamingFeature(h.pi);
      Object.assign(h.ctx, { cwd: disabled });
      h.events.get("session_start")!({}, h.ctx);
      h.events.get("input")!({ text: "Disabled", source: "interactive" }, h.ctx);
      await h.commands.get("rename")!.handler("Still disabled", h.ctx);
      await flush();
      assert.equal(h.name(), undefined);
      Object.assign(h.ctx, { cwd: enabled });
      h.switchSession("enabled-session");
      h.events.get("session_start")!({}, h.ctx);
      await h.commands.get("rename")!.handler("Project title", h.ctx);
      assert.equal(h.name(), "Project title");
      await h.commands.get("naming-config")!.handler("reset", h.ctx);
      assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")), { naming: parseConfig({}), metrics: false });
      assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), global);
      Object.assign(h.ctx, { cwd: disabled });
      h.switchSession("global-session");
      h.events.get("session_start")!({}, h.ctx);
      await h.commands.get("pi-naming-config")!.handler("reset", h.ctx);
      assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), { naming: parseConfig({}), footer: false });
    } finally {
      clearConfigCache();
    }
  }, "spark-naming-runtime-");
});
