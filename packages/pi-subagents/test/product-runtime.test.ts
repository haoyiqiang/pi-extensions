import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const terminalFactories = vi.hoisted(() => ({ standard: vi.fn() }));
vi.mock("../src/backends/terminal/backend.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/backends/terminal/backend.js")>();
  return { ...actual, createStandardTerminalExecutionBackend: terminalFactories.standard };
});

import * as configIO from "pi-extensions-config";
import productExtension from "../index.js";
import { i18n } from "../src/i18n.js";
import { AgentManager } from "../src/agent-manager.js";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { registerAgents } from "../src/agent-types.js";
import { createEmbeddedExecutionBackend } from "../src/backends/embedded-adapter.js";
import type { ExecutionSession } from "../src/backends/session.js";
import type { ExecutionBackendKind, PersistentSessionReference } from "../src/backends/session-reference.js";
import type {
  AgentExecutionBackend,
  ExecutionRunOptions,
} from "../src/backends/types.js";
import subagentsExtension from "../src/index.js";
import {
  createRoutedExecutionBackend,
  getConfiguredBackend,
  initializeSubagentsRuntime,
} from "../src/runtime.js";
import { saveSettings } from "../src/settings.js";
import { flush, hermeticDir, textOf } from "./helpers/boot-extension.js";

interface Harness {
  pi: any;
  tools: Map<string, any>;
  commands: Map<string, any>;
  fire(event: string, ...args: any[]): Promise<unknown[]>;
}

function harness(): Harness {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const lifecycle = new Map<string, Set<(...args: any[]) => unknown>>();
  const bus = new Map<string, Set<(data: unknown) => unknown>>();
  const activeTools: string[] = [];
  const add = <T extends (...args: any[]) => unknown>(map: Map<string, Set<T>>, event: string, handler: T) => {
    const handlers = map.get(event) ?? new Set<T>();
    handlers.add(handler);
    map.set(event, handlers);
    return () => handlers.delete(handler);
  };
  const events = {
    on: vi.fn((event: string, handler: (data: unknown) => unknown) => add(bus, event, handler)),
    emit: vi.fn((event: string, data: unknown) => {
      for (const handler of [...(bus.get(event) ?? [])]) handler(data);
    }),
  };
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    }),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => []),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((names: string[]) => activeTools.splice(0, activeTools.length, ...names)),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => add(lifecycle, event, handler)),
    events,
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
  } as any;
  return {
    pi,
    tools,
    commands,
    async fire(event: string, ...args: any[]) {
      const results: unknown[] = [];
      for (const handler of [...(lifecycle.get(event) ?? [])]) results.push(await handler(...args));
      return results;
    },
  };
}

function context(cwd: string, overrides: Record<string, unknown> = {}): any {
  return {
    mode: "print",
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(),
      addAutocompleteProvider: vi.fn(),
    },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: vi.fn(() => "root-session"),
      getSessionFile: vi.fn(() => undefined),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
    isProjectTrusted: vi.fn(() => true),
    ...overrides,
  };
}

let sessionSequence = 0;
function session(kind: ExecutionBackendKind, sessionFile?: string): ExecutionSession {
  const id = `${kind}-${++sessionSequence}`;
  return {
    reference: {
      backend: kind,
      sessionId: id,
      ...(sessionFile ? { sessionFile } : {}),
    },
    messages: [],
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheWrite: 0 },
      contextUsage: { percent: null },
    }),
    subscribe: () => () => {},
  };
}

function fakeBackend(
  kind: ExecutionBackendKind,
  options: { sessionFile?: string } = {},
): {
  backend: AgentExecutionBackend;
  runs: Array<{ type: string; prompt: string; options: ExecutionRunOptions; session: ExecutionSession }>;
  resume: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
} {
  const runs: Array<{ type: string; prompt: string; options: ExecutionRunOptions; session: ExecutionSession }> = [];
  const resume = vi.fn(async () => ({ text: `${kind}:resumed` }));
  const steer = vi.fn(async () => {});
  const interrupt = vi.fn(async () => {});
  const shutdown = vi.fn(async () => {});
  const backend: AgentExecutionBackend = {
    kind,
    async run(_ctx, type, prompt, runOptions) {
      const opened = session(kind, options.sessionFile);
      runs.push({ type, prompt, options: runOptions, session: opened });
      runOptions.onSessionCreated?.(opened);
      return { responseText: `${kind}:${prompt}`, session: opened, aborted: false, steered: false };
    },
    resume,
    steer,
    interrupt,
    shutdown,
  };
  return { backend, runs, resume, steer, interrupt, shutdown };
}

let requestSequence = 0;
async function rpc(h: Harness, channel: string, payload: Record<string, unknown>): Promise<any> {
  const requestId = `request-${++requestSequence}`;
  return new Promise((resolve) => {
    const off = h.pi.events.on(`${channel}:reply:${requestId}`, (reply: unknown) => {
      off();
      resolve(reply);
    });
    h.pi.events.emit(channel, { requestId, ...payload });
  });
}

function writeAgent(cwd: string, name: string, body: string, workspace = false): string {
  const dir = join(cwd, workspace ? ".agents" : ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, body);
  return path;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeAll(() => initTheme(undefined, false));

afterEach(() => {
  terminalFactories.standard.mockReset();
  registerAgents(new Map());
  vi.useRealTimers();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
});

describe("unified product runtime", () => {
  it("registers only the original Agent/get/steer product surface", async () => {
    const env = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false } });
    const h = harness();
    try {
      productExtension(h.pi);
      expect([...h.tools.keys()].sort()).toEqual(["Agent", "get_subagent_result", "steer_subagent"]);
      for (const retired of [
        "subagent", "subagent_resume", "subagents_list", "subagent_interrupt", "subagent_done", "SubagentWorkflow",
      ]) expect(h.tools.has(retired)).toBe(false);
      expect([...h.commands.keys()]).toEqual(["config:subagents"]);
      expect(h.commands.has("agents")).toBe(false);
      expect(h.pi.registerCommand).toHaveBeenCalledTimes(1);
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      env.restore();
    }
  });

  it("funnels real Agent and RPC launches through the configured terminal router with canonical modes", async () => {
    const env = hermeticDir({ settings: {
      backend: "terminal",
      schedulingEnabled: false,
      workflowsEnabled: false,
      outputTranscript: false,
      agentMentions: "off",
    } });
    writeAgent(env.dir, "general-purpose", "---\ntools: read\nextensions: false\nskills: false\n---\nRead-only project override.\n");
    const terminal = fakeBackend("terminal");
    terminalFactories.standard.mockReturnValue(terminal.backend);
    const h = harness();
    const ctx = context(env.dir);
    try {
      productExtension(h.pi);
      await h.fire("session_start", {}, ctx);

      await h.tools.get("Agent").execute(
        "tool-autonomous",
        { prompt: "autonomous", description: "autonomous run", subagent_type: "general-purpose", run_in_background: false },
        undefined,
        undefined,
        ctx,
      );
      await h.tools.get("Agent").execute(
        "tool-interactive",
        { prompt: "interactive", description: "interactive run", subagent_type: "general-purpose", run_in_background: false, interactive: true },
        undefined,
        undefined,
        ctx,
      );
      const reply = await rpc(h, "subagents:rpc:spawn", {
        type: "general-purpose",
        prompt: "rpc",
        options: { description: "rpc run", isBackground: true, backend: "embedded" },
      });

      expect(reply).toMatchObject({ success: true, data: { id: expect.any(String) } });
      expect(terminalFactories.standard).toHaveBeenCalledOnce();
      expect(terminal.runs.map((run) => run.prompt)).toEqual(["autonomous", "interactive", "rpc"]);
      expect(terminal.runs[0].options).toMatchObject({
        interactive: false, autoExit: true,
        agentConfig: { builtinToolNames: ["read"], extensions: false },
      });
      expect(terminal.runs[1].options).toMatchObject({ interactive: true, autoExit: false });
      expect(terminal.runs[2].options).toMatchObject({ interactive: false, autoExit: true });
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      env.restore();
    }
  });

  it("keeps scoped RPC on its pinned backend despite a caller override", async () => {
    const env = hermeticDir({ settings: { backend: "embedded", outputTranscript: false } });
    const terminal = fakeBackend("terminal");
    terminalFactories.standard.mockReturnValue(terminal.backend);
    const h = harness();
    try {
      createAgentRuntime({ backend: "terminal" })(h.pi);
      await h.fire("session_start", {}, context(env.dir));
      const reply = await rpc(h, "subagents:rpc:spawn", {
        type: "general-purpose", prompt: "pinned",
        options: { backend: "embedded", description: "pinned RPC" },
      });
      expect(reply.success).toBe(true);
      expect(terminal.runs.map(run => run.prompt)).toEqual(["pinned"]);
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      env.restore();
    }
  });

  it("restores persisted owners independently of current and changing defaults", async () => {
    const env = hermeticDir();
    const firstFile = join(env.dir, "first.jsonl");
    const secondFile = join(env.dir, "second.jsonl");
    writeFileSync(firstFile, "{}\n");
    writeFileSync(secondFile, "{}\n");
    const first = session("terminal", firstFile);
    const second = session("terminal", secondFile);
    const terminal = fakeBackend("terminal");
    const pending = deferred<ExecutionSession>();
    const entered = deferred<void>();
    terminal.backend.reattach = vi.fn(async reference => {
      if (reference.sessionFile === firstFile) return first;
      entered.resolve();
      return pending.promise;
    });
    let selected: ExecutionBackendKind = "embedded";
    const router = createRoutedExecutionBackend({
      embedded: () => fakeBackend("embedded").backend,
      terminal: () => terminal.backend, selectBackend: () => selected,
    });
    const manager = new AgentManager(undefined, 1, undefined, undefined, undefined, router);
    const options = { type: "general-purpose", description: "restore", ctx: context(env.dir) };
    try {
      const restored = await manager.restore(first.reference as PersistentSessionReference, options);
      expect(restored.record.session).toBe(first);
      expect(await manager.interrupt(restored.id)).toBe(false);
      expect(terminal.interrupt).not.toHaveBeenCalled();
      selected = "terminal";
      const restoring = manager.restore(second.reference as PersistentSessionReference, options);
      await entered.promise;
      selected = "embedded";
      pending.resolve(second);
      expect((await restoring).record.session).toBe(second);
    } finally {
      pending.resolve(second);
      await manager.dispose();
      env.restore();
    }
  });

  it("loads a read-only workspace override and untouched defaults through shared initialization", () => {
    const env = hermeticDir();
    try {
      const overridePath = writeAgent(env.dir, "Explore", `---\ndescription: Workspace Explore\ntools: read\n---\n\nWorkspace-only prompt.`, true);
      chmodSync(overridePath, 0o444);

      const runtime = initializeSubagentsRuntime(env.dir);

      expect(runtime.agents.get("Explore")).toMatchObject({
        description: "Workspace Explore",
        builtinToolNames: ["read"],
        systemPrompt: "Workspace-only prompt.",
        source: "project",
        sourcePath: overridePath,
      });
      expect(runtime.agents.get("general-purpose")?.isDefault).toBe(true);
    } finally {
      env.restore();
    }
  });

  it("keeps the per-cwd agent definition captured before a queued launch", async () => {
    const env = hermeticDir();
    const cwdA = join(env.dir, "project-a");
    const cwdB = join(env.dir, "project-b");
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });
    const sourceA = writeAgent(cwdA, "scout", `---\ndescription: Scout A\n---\n\nPrompt A.`);
    writeAgent(cwdB, "scout", `---\ndescription: Scout B\n---\n\nPrompt B.`);
    initializeSubagentsRuntime(cwdA);

    const held = deferred<any>();
    let holderSession: ExecutionSession | undefined;
    const seen: Array<ExecutionRunOptions & { agentConfig?: { sourcePath?: string; systemPrompt?: string } }> = [];
    const backend: AgentExecutionBackend = {
      kind: "embedded",
      run(_ctx, _type, prompt, options) {
        seen.push(options);
        const opened = session("embedded");
        options.onSessionCreated?.(opened);
        if (prompt === "hold") {
          holderSession = opened;
          return held.promise;
        }
        return Promise.resolve({ responseText: "done", session: opened, aborted: false, steered: false });
      },
      resume: async () => ({ text: "resumed" }),
      steer: async () => {},
      interrupt: async () => {},
      shutdown: async () => {},
    };
    const manager = new AgentManager(undefined, 1, undefined, undefined, undefined, backend);
    const ctx = context(cwdA);
    try {
      manager.spawn({} as any, ctx, "general-purpose", "hold", {
        description: "holder", isBackground: true, configCwd: cwdA,
      });
      const queued = manager.spawn({} as any, ctx, "scout", "queued", {
        description: "queued", isBackground: true, configCwd: cwdA,
      });
      expect(manager.getRecord(queued)?.status).toBe("queued");

      initializeSubagentsRuntime(cwdB);
      held.resolve({ responseText: "released", session: holderSession!, aborted: false, steered: false });
      await manager.waitForAll();

      expect(seen).toHaveLength(2);
      expect(seen[1].agentConfig).toMatchObject({ sourcePath: sourceA, systemPrompt: "Prompt A." });
    } finally {
      await manager.dispose();
      env.restore();
    }
  });

  it("changes backend for new runs while resume, steer, interrupt, and stop retain the session owner", async () => {
    const embedded = fakeBackend("embedded");
    const terminal = fakeBackend("terminal");
    let selected: ExecutionBackendKind = "embedded";
    const router = createRoutedExecutionBackend({
      embedded: () => embedded.backend,
      terminal: () => terminal.backend,
      selectBackend: () => selected,
    });
    const ctx = context(process.cwd()) as ExtensionContext;

    const first = await router.run(ctx, "general-purpose", "first", { pi: {} as any });
    selected = "terminal";
    const second = await router.run(ctx, "general-purpose", "second", { pi: {} as any });
    await router.resume(first.session, "continue");
    await router.steer(first.session, "redirect");
    await router.interrupt(first.session);
    await router.shutdown(first.session);

    expect(embedded.runs.map((run) => run.prompt)).toEqual(["first"]);
    expect(terminal.runs.map((run) => run.prompt)).toEqual(["second"]);
    expect(router.backendKindFor(first.session)).toBe("embedded");
    expect(router.backendKindFor(second.session)).toBe("terminal");
    expect(embedded.resume).toHaveBeenCalledWith(first.session, "continue", undefined);
    expect(embedded.steer).toHaveBeenCalledWith(first.session, "redirect");
    expect(embedded.interrupt).toHaveBeenCalledWith(first.session);
    expect(embedded.shutdown).toHaveBeenCalledWith(first.session);
    expect(terminal.resume).not.toHaveBeenCalled();
  });

  it("reopens an evicted @handle on its tombstoned backend after the default changes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const env = hermeticDir({ settings: {
      schedulingEnabled: false,
      workflowsEnabled: false,
      outputTranscript: false,
      agentMentions: "direct",
    } });
    const saved = join(env.dir, "saved-agent.jsonl");
    writeFileSync(saved, "{}\n");
    const embedded = fakeBackend("embedded", { sessionFile: saved });
    const terminal = fakeBackend("terminal", { sessionFile: saved });
    let selected: ExecutionBackendKind = "embedded";
    const router = createRoutedExecutionBackend({
      embedded: () => embedded.backend,
      terminal: () => terminal.backend,
      selectBackend: () => selected,
    });
    const h = harness();
    const ctx = context(env.dir, { mode: "tui" });
    try {
      subagentsExtension(h.pi, { legacyWorkflow: false, execution: router });
      await h.fire("session_start", {}, ctx);
      const started = await h.tools.get("Agent").execute(
        "tool",
        { prompt: "remember", description: "remember run", subagent_type: "general-purpose", run_in_background: true },
        undefined,
        undefined,
        ctx,
      );
      expect(textOf(started)).toContain("Agent ID:");
      await flush();

      await vi.advanceTimersByTimeAsync(11 * 60_000);
      await flush();
      selected = "terminal";
      const inputResults = await h.fire("input", {
        text: "@general-purpose continue from disk",
        source: "interactive",
      }, ctx);
      await flush();

      expect(inputResults).toContainEqual({ action: "handled" });
      expect(embedded.runs).toHaveLength(2);
      expect(embedded.runs[1].options).toMatchObject({ backend: "embedded", resumeSessionFile: saved });
      expect(terminal.runs).toHaveLength(0);
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      env.restore();
    }
  });

  it("interrupts only the embedded turn, while full shutdown closes later resume", async () => {
    const native = {
      sessionId: "native-session",
      sessionManager: { getSessionId: () => "native-session", getSessionFile: () => undefined },
      messages: [],
      abort: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      getSessionStats: vi.fn(() => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: null } })),
    } as any;
    const resume = vi.fn(async () => ({ text: "resumed after interrupt" }));
    const shutdown = vi.fn(async () => {});
    const backend = createEmbeddedExecutionBackend({
      runAgent: vi.fn(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated?.(native);
        return { responseText: "first turn", session: native, aborted: false, steered: false };
      }),
      resumeAgent: resume,
      shutdownEmbeddedSession: shutdown,
    });
    const opened = await backend.run(context(process.cwd()), "general-purpose", "go", { pi: {} as any });

    await backend.interrupt!(opened.session);
    expect(native.abort).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
    await expect(backend.resume(opened.session, "continue")).resolves.toEqual({ text: "resumed after interrupt" });

    await backend.shutdown(opened.session);
    expect(shutdown).toHaveBeenCalledWith(native);
    await expect(backend.resume(opened.session, "too late")).rejects.toThrow();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("rejects every argument without opening a selector or writing configuration", async () => {
    const env = hermeticDir({ settings: { backend: "embedded", fleetView: true } });
    const h = harness();
    const ctx = context(env.dir, { mode: "tui", hasUI: true });
    const path = join(env.dir, ".pi", "subagents.json");
    const original = readFileSync(path, "utf8");
    try {
      productExtension(h.pi);
      for (const args of ["embedded", "terminal", "status", "list", "unknown"]) {
        await h.commands.get("config:subagents").handler(args, ctx);
      }
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(ctx.ui.select).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledTimes(5);
      expect(ctx.ui.notify.mock.calls.every((call: any[]) => call[0].includes(i18n.t("product.configUsage")))).toBe(true);
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      env.restore();
    }
  });

  it("does not substitute a backend selector or status/list for the panel outside TUI", async () => {
    const env = hermeticDir();
    const h = harness();
    try {
      productExtension(h.pi);
      for (const mode of ["print", "json", "rpc"]) {
        const ctx = context(env.dir, { mode, hasUI: mode === "rpc" });
        await h.commands.get("config:subagents").handler("", ctx);
        expect(ctx.ui.select).not.toHaveBeenCalled();
        expect(ctx.ui.setWidget).not.toHaveBeenCalled();
        expect(ctx.ui.setStatus).not.toHaveBeenCalled();
        expect(ctx.ui.notify.mock.calls[0][0]).toContain(i18n.t("product.panelRequiresTui"));
      }
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      env.restore();
    }
  });

  it("opens the full active management menu with no arguments", async () => {
    const env = hermeticDir({ settings: { schedulingEnabled: true } });
    const h = harness();
    const ctx = context(env.dir, { mode: "tui", hasUI: true });
    try {
      productExtension(h.pi);
      await h.fire("session_start", {}, ctx);
      await h.commands.get("config:subagents").handler("  ", ctx);
      expect(ctx.ui.select).toHaveBeenCalledWith("Agents", [
        expect.stringMatching(/^Agent types \(/),
        expect.stringMatching(/^Scheduled jobs \(/),
        "Create new agent", "Settings",
      ]);
      expect(ctx.ui.select.mock.calls[0][1].some((label: string) => label.startsWith("Workflows"))).toBe(false);
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      env.restore();
    }
  });

  it("retains only the above-editor AgentWidget through start, execution, switch and shutdown", async () => {
    const env = hermeticDir({ settings: { fleetView: true, schedulingEnabled: false, outputTranscript: false } });
    const h = harness();
    const backend = fakeBackend("embedded");
    const ctx = context(env.dir, { mode: "tui", hasUI: true });
    ctx.ui.onTerminalInput = vi.fn(() => vi.fn());
    try {
      subagentsExtension(h.pi, { legacyWorkflow: false, execution: backend.backend });
      await h.fire("session_start", {}, ctx);
      await h.fire("tool_execution_start", {}, ctx);
      await h.tools.get("Agent").execute("widget", {
        prompt: "widget task", description: "widget task", subagent_type: "general-purpose", run_in_background: true,
      }, undefined, undefined, ctx);
      await flush();
      const registrations = ctx.ui.setWidget.mock.calls.filter((call: any[]) => call[1]);
      expect(registrations.length).toBeGreaterThan(0);
      expect(registrations.every((call: any[]) => call[0] === "agents" && call[2]?.placement === "aboveEditor")).toBe(true);
      await h.commands.get("config:subagents").handler("", ctx);
      expect(ctx.ui.select.mock.calls[0][1]).toEqual([
        expect.stringMatching(/^Running agents \(/), expect.stringMatching(/^Agent types \(/),
        "Create new agent", "Settings",
      ]);
      await h.fire("session_before_switch");
      await h.fire("session_start", {}, ctx);
      await h.fire("session_shutdown", { reason: "quit" });
      expect(ctx.ui.onTerminalInput).not.toHaveBeenCalled();
      expect(ctx.ui.setWidget.mock.calls.some((call: any[]) => call[0] === "fleet")).toBe(false);
      expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("agents", undefined);
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      env.restore();
    }
  });

  it("saves backend choices from Settings without deleting unrelated product keys or touching global defaults", async () => {
    const env = hermeticDir({ settings: {
      backend: "embedded",
      maxConcurrent: 4,
      terminalOptions: { surface: "headless" },
      futureProductKey: "keep-me",
    } });
    const h = harness();
    const ctx = context(env.dir, { mode: "tui", hasUI: true });
    const globalPath = join(process.env.PI_CODING_AGENT_DIR!, "subagents.json");
    const globalContent = '{"backend":"embedded","showModel":true}\n';
    writeFileSync(globalPath, globalContent);
    ctx.ui.select.mockResolvedValueOnce("Settings");
    ctx.ui.custom = vi.fn(async (factory: any) => {
      const panel = factory({ requestRender: vi.fn() }, {}, {}, vi.fn());
      panel.handleInput(" "); // First row is the project backend setting.
      return undefined;
    });
    const configPath = join(env.dir, ".pi", "subagents.json");
    try {
      productExtension(h.pi);
      await h.fire("session_start", {}, ctx);
      await h.commands.get("config:subagents").handler("", ctx);
      expect(ctx.ui.custom).toHaveBeenCalledOnce();
      expect(readFileSync(globalPath, "utf8")).toBe(globalContent);
      expect(h.pi.events.emit).toHaveBeenCalledWith("subagents:settings_changed", expect.objectContaining({
        settings: expect.objectContaining({ backend: "terminal" }), persisted: true,
      }));
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        backend: "terminal",
        maxConcurrent: 4,
        terminalOptions: { surface: "headless" },
        futureProductKey: "keep-me",
      });

      expect(saveSettings({ showCost: true }, env.dir)).toBe(true);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        backend: "terminal",
        showCost: true,
        terminalOptions: { surface: "headless" },
        futureProductKey: "keep-me",
      });
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      env.restore();
    }
  });

  it("routes the Chinese management menu to localized project backend settings", async () => {
    const env = hermeticDir({ settings: { backend: "embedded", schedulingEnabled: false } });
    const h = harness();
    const ctx = context(env.dir, { mode: "tui", hasUI: true });
    const previousLocale = process.env.PI_EXTENSIONS_LOCALE;
    process.env.PI_EXTENSIONS_LOCALE = "zh-CN";
    let rendered: string[] = [];
    ctx.ui.select.mockResolvedValueOnce(i18n.t("product.menuSettings"));
    ctx.ui.custom = vi.fn(async (factory: any) => {
      const panel = factory({ requestRender: vi.fn() }, {}, {}, vi.fn());
      panel.handleInput(" ");
      rendered = panel.render(200);
    });
    try {
      productExtension(h.pi);
      await h.fire("session_start", {}, ctx);
      await h.commands.get("config:subagents").handler("", ctx);
      expect(ctx.ui.select.mock.calls[0]).toEqual([i18n.t("product.menuTitle"), [
        i18n.t("product.menuTypes", { count: 3 }), i18n.t("product.menuCreate"), i18n.t("product.menuSettings"),
      ]]);
      expect(rendered.join("\n")).toContain(i18n.t("product.backendLabel"));
      expect(JSON.parse(readFileSync(join(env.dir, ".pi", "subagents.json"), "utf8")).backend).toBe("terminal");
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      if (previousLocale === undefined) delete process.env.PI_EXTENSIONS_LOCALE;
      else process.env.PI_EXTENSIONS_LOCALE = previousLocale;
      env.restore();
    }
  });

  it("rechecks trust before backend changes, leaving project and global files untouched", async () => {
    const env = hermeticDir({ settings: { backend: "embedded" } });
    const h = harness();
    let trusted = true;
    const ctx = context(env.dir, { mode: "tui", hasUI: true, isProjectTrusted: () => trusted });
    const projectPath = join(env.dir, ".pi", "subagents.json");
    const original = readFileSync(projectPath, "utf8");
    const globalPath = join(process.env.PI_CODING_AGENT_DIR!, "subagents.json");
    writeFileSync(globalPath, '{"backend":"embedded"}');
    ctx.ui.select.mockResolvedValueOnce("Settings");
    ctx.ui.custom = vi.fn(async (factory: any) => {
      const panel = factory({ requestRender: vi.fn() }, {}, {}, vi.fn());
      trusted = false;
      panel.handleInput(" ");
    });
    try {
      productExtension(h.pi);
      await h.fire("session_start", {}, ctx);
      await h.commands.get("config:subagents").handler("", ctx);
      expect(readFileSync(projectPath, "utf8")).toBe(original);
      expect(readFileSync(globalPath, "utf8")).toBe('{"backend":"embedded"}');
      expect(ctx.ui.notify.mock.calls.some((call: any[]) => call[0].includes(i18n.t("product.projectUntrusted")))).toBe(true);
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      env.restore();
    }
  });

  it("reports backend persistence failures without applying the new backend", async () => {
    const env = hermeticDir({ settings: { backend: "embedded" } });
    const h = harness();
    const ctx = context(env.dir, { mode: "tui", hasUI: true });
    const path = join(env.dir, ".pi", "subagents.json");
    const original = readFileSync(path, "utf8");
    ctx.ui.select.mockResolvedValueOnce("Settings");
    ctx.ui.custom = vi.fn(async (factory: any) => {
      const panel = factory({ requestRender: vi.fn() }, {}, {}, vi.fn());
      panel.handleInput(" ");
    });
    try {
      productExtension(h.pi);
      await h.fire("session_start", {}, ctx);
      const write = vi.spyOn(configIO, "updateJsonObjectAtomic").mockImplementationOnce(() => { throw new Error("write blocked"); });
      try {
        await h.commands.get("config:subagents").handler("", ctx);
      } finally {
        write.mockRestore();
      }
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(getConfiguredBackend()).toBe("embedded");
      expect(ctx.ui.notify.mock.calls.some((call: any[]) => call[1] === "error" && call[0].includes("write blocked"))).toBe(true);
      expect(h.pi.events.emit.mock.calls.some((call: any[]) => call[0] === "subagents:settings_changed")).toBe(false);
    } finally {
      await h.fire("session_shutdown", { reason: "quit" });
      env.restore();
    }
  });
});
