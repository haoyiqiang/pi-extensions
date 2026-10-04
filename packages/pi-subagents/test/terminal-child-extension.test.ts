import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import type {
  ExtensionAPI,
  ExtensionContext,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import terminalChildExtension, {
  registerTerminalChild,
  type TerminalChildConnect,
} from "../src/backends/terminal/child-extension.js";
import {
  encodeBridgeFrame,
  modelFingerprint,
  TERMINAL_MANIFEST_ENV,
  type TerminalChildManifest,
} from "../src/backends/terminal/bridge-protocol.js";
import { i18n } from "../src/i18n.js";

interface WriteRecord {
  readonly data: string;
  readonly callback: (error?: Error | null) => void;
}

class FakeSocket extends EventEmitter {
  readonly writes: WriteRecord[] = [];
  readonly end = vi.fn(() => this);
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    return this;
  });
  destroyed = false;
  autoFlush = true;
  autoAccept = true;
  autoStart = true;

  write(data: string | Uint8Array, callback?: (error?: Error | null) => void): boolean {
    const record = {
      data: typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
      callback: callback ?? (() => {}),
    };
    this.writes.push(record);
    const frame = JSON.parse(record.data);
    if (this.autoAccept && frame.type === "hello") queueMicrotask(() => this.receive({
      type: "accepted", version: 1, runId: frame.runId, sessionId: frame.sessionId,
    }));
    if (this.autoStart && frame.type === "ready") queueMicrotask(() => this.receive({ type: "start" }));
    if (this.autoFlush) queueMicrotask(() => record.callback());
    return true;
  }

  flush(index: number, error?: Error): void {
    this.writes[index]?.callback(error);
  }

  receive(value: unknown): void {
    this.emit("data", Buffer.from(encodeBridgeFrame(value)));
  }
}

type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface HarnessOptions {
  readonly manifest?: TerminalChildManifest;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly model?: Record<string, unknown>;
  readonly messages?: any[];
  readonly idle?: boolean;
  readonly socket?: FakeSocket;
  readonly autoConnect?: boolean;
}

function manifest(overrides: Partial<TerminalChildManifest> = {}): TerminalChildManifest {
  const base: TerminalChildManifest = {
    version: 1,
    run: {
      runId: "run-1",
      session: {
        backend: "terminal",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
      },
    },
    endpoint: { host: "127.0.0.1", port: 41_337, token: "capability-token" },
    model: { provider: "fixture", id: "fixture-model" },
    tools: ["read", "bash"],
    systemPrompt: "Resolved private child policy",
  };
  return { ...base, ...overrides };
}

function assistant(
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture-model",
    stopReason: "stop",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 3,
      totalTokens: 19,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    },
    timestamp: 1,
    ...overrides,
  };
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler[]>();
  const targetManifest = options.manifest ?? manifest();
  const socket = options.socket ?? new FakeSocket();
  const projection = { messages: options.messages ?? [] };
  const state = { idle: options.idle ?? true };
  let activeTools = ["read", "bash", "provider_fixture_tool"];

  const on = vi.fn((event: string, handler: Handler) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  });
  const piValue = {
    on,
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((names: string[]) => { activeTools = [...names]; }),
    getThinkingLevel: vi.fn(() => "high"),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;

  const abort = vi.fn();
  const shutdown = vi.fn();
  const contextValue: Record<string, any> = {
    model: options.model ?? {
      provider: targetManifest.model.provider,
      id: targetManifest.model.id,
      name: "Fixture Model",
      apiKey: "must-not-leak",
      baseUrl: "https://private.invalid",
    },
    sessionManager: {
      getSessionId: vi.fn(() => options.sessionId ?? targetManifest.run.session.sessionId),
      getSessionFile: vi.fn(() => options.sessionFile ?? targetManifest.run.session.sessionFile),
      buildSessionProjection: vi.fn(() => ({
        entries: [],
        messages: projection.messages,
        thinkingLevel: "high",
        model: { provider: targetManifest.model.provider, modelId: targetManifest.model.id },
      })),
    },
    abort,
    shutdown,
    isIdle: vi.fn(() => state.idle),
    getContextUsage: vi.fn(() => ({ tokens: 256, contextWindow: 1_024, percent: 25 })),
  };
  const ctx = contextValue as ExtensionContext;

  const connect = vi.fn<TerminalChildConnect>(() => {
    if (options.autoConnect !== false) queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as Socket;
  });
  const source = vi.fn(() => targetManifest);
  registerTerminalChild(piValue, source, connect);

  const emit = async (event: string, value: Record<string, unknown> = { type: event }) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler(value, ctx));
    return results;
  };

  return {
    abort,
    connect,
    ctx,
    emit,
    handlers,
    manifest: targetManifest,
    pi: piValue as any,
    projection,
    shutdown,
    socket,
    source,
    state,
  };
}

async function start(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await flushMicrotasks();
}

function records(socket: FakeSocket): any[] {
  return socket.writes.flatMap((write) => write.data
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line)));
}

function packets(socket: FakeSocket, type?: string): any[] {
  return records(socket).filter((record) => "seq" in record && (type === undefined || record.type === type));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function promptOptions(): NormalizedBuildSystemPromptOptions {
  return {
    cwd: "/project",
    selectedTools: ["provider_fixture_tool"],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "untrusted append",
    sections: { project: "untrusted project prompt" },
    contextFiles: [],
    skills: [],
    forceSystemPrompt: "untrusted force",
  };
}

describe("terminal child extension", () => {
  it("does not activate as a normally discovered extension without the private manifest environment", () => {
    const previous = process.env[TERMINAL_MANIFEST_ENV];
    delete process.env[TERMINAL_MANIFEST_ENV];
    const on = vi.fn();
    try {
      terminalChildExtension({ on } as unknown as ExtensionAPI);
      expect(on).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env[TERMINAL_MANIFEST_ENV];
      else process.env[TERMINAL_MANIFEST_ENV] = previous;
    }
  });

  it.each([
    ["version", { version: 2 }],
    ["host", { endpoint: { host: "0.0.0.0", port: 41_337, token: "token" } }],
    ["token", { endpoint: { host: "127.0.0.1", port: 41_337, token: "" } }],
    ["run id", { run: { runId: "", session: manifest().run.session } }],
    ["session id", { run: { runId: "run", session: { ...manifest().run.session, sessionId: "" } } }],
    ["tool", { tools: ["provider_fixture_tool"] }],
  ])("rejects an invalid manifest %s before creating transport", async (_label, invalid) => {
    const harness = createHarness({ manifest: { ...manifest(), ...invalid } as TerminalChildManifest });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.shutdown).toHaveBeenCalledOnce();
  });

  it("defers manifest/socket work to session_start and sends a safe canonical ready snapshot", async () => {
    const canonical = [
      { role: "user", content: "resume" },
      assistant("current", { usage: {
        input: 7,
        output: 5,
        cacheRead: 99,
        cacheWrite: 2,
        totalTokens: 113,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
      } }),
    ];
    const harness = createHarness({ messages: canonical });

    expect(harness.source).not.toHaveBeenCalled();
    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.socket.writes).toHaveLength(0);

    await start(harness);

    expect(harness.source).toHaveBeenCalledOnce();
    expect(harness.connect).toHaveBeenCalledWith({ host: "127.0.0.1", port: 41_337 });
    const output = records(harness.socket);
    expect(output[0]).toEqual({
      type: "hello",
      version: 1,
      token: "capability-token",
      runId: "run-1",
      sessionId: "session-1",
    });
    expect(output[1]).toMatchObject({
      seq: 1,
      type: "ready",
      snapshot: {
        messages: canonical,
        model: { provider: "fixture", id: "fixture-model", name: "Fixture Model" },
        thinkingLevel: "high",
        stats: {
          tokens: { input: 7, output: 5, cacheWrite: 2 },
          contextUsage: { percent: 25 },
        },
      },
    });
    expect(output[1].snapshot.model).not.toHaveProperty("apiKey");
    expect(output[1].snapshot.model).not.toHaveProperty("baseUrl");
    expect(harness.pi.setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
  });

  it("does not allow the initial prompt until the parent accepts the authenticated run", async () => {
    const socket = new FakeSocket();
    socket.autoAccept = false;
    socket.autoStart = false;
    const harness = createHarness({ socket });
    const starting = harness.emit("session_start");
    await flushMicrotasks();
    expect(records(socket)[0].type).toBe("hello");
    expect(packets(socket, "ready")).toHaveLength(0);
    expect((await harness.emit("input", { text: "early" }))[0]).toEqual({ action: "handled" });
    socket.receive({ type: "accepted", version: 1, runId: "run-1", sessionId: "session-1" });
    expect((await harness.emit("input", { text: "before start permission" }))[0]).toEqual({ action: "handled" });
    socket.receive({ type: "start" });
    await starting;
    expect(packets(socket, "ready")).toHaveLength(1);
    expect((await harness.emit("input", { text: "now" }))[0]).toEqual({ action: "continue" });
    await harness.emit("session_shutdown");
  });

  it("queues pre-prompt steering and acknowledges it only after SDK dispatch at agent_start", async () => {
    const socket = new FakeSocket();
    socket.autoStart = false;
    const harness = createHarness({ socket });
    const starting = harness.emit("session_start");
    await flushMicrotasks();
    socket.receive({ type: "steer", id: "early", message: "queued correction" });
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(packets(socket, "ack")).toHaveLength(0);
    socket.receive({ type: "start" });
    await starting;
    harness.state.idle = false;
    await harness.emit("agent_start");
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("queued correction", { deliverAs: "steer" });
    expect(packets(socket, "ack")[0]).toMatchObject({ id: "early" });
    await harness.emit("session_shutdown");
  });

  it("does not permanently suppress shutdown after a throwing shutdown hook", async () => {
    const harness = createHarness();
    await start(harness);
    harness.shutdown.mockImplementationOnce(() => { throw new Error("temporary shutdown failure"); });
    await harness.emit("message_end", { message: assistant("done") });
    await harness.emit("agent_settled");
    await flushMicrotasks();
    expect(harness.shutdown).toHaveBeenCalledTimes(2);
    await harness.emit("session_shutdown");
  });

  it("rejects a different endpoint even when provider and model IDs match", async () => {
    const chosen = manifest();
    chosen.modelFingerprint = modelFingerprint({ ...chosen.model, api: "test-api", baseUrl: "https://example.invalid/expected" });
    const harness = createHarness({ manifest: chosen, model: { ...chosen.model, api: "test-api", baseUrl: "https://example.invalid/other" } });
    await start(harness);
    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.shutdown).toHaveBeenCalledOnce();
  });

  it("fails closed on mismatched parent acceptance", async () => {
    const socket = new FakeSocket();
    socket.autoAccept = false;
    const harness = createHarness({ socket });
    const starting = harness.emit("session_start");
    await flushMicrotasks();
    socket.receive({ type: "accepted", version: 1, runId: "stale-run", sessionId: "session-1" });
    await starting;
    await flushMicrotasks();
    expect(harness.shutdown).toHaveBeenCalledOnce();
    expect(packets(socket, "ready")).toHaveLength(0);
    await harness.emit("session_shutdown");
  });

  it("streams text, tools, usage, turns, and deferred compaction snapshots in sequence", async () => {
    const first = assistant("done");
    const harness = createHarness({ messages: [] });
    await start(harness);
    harness.state.idle = false;

    await harness.emit("message_update", {
      type: "message_update",
      message: first,
      assistantMessageEvent: {
        type: "text_delta",
        delta: "done",
        partial: first,
        contentIndex: 0,
      },
    });
    await harness.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: {},
    });
    await harness.emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: {},
      isError: false,
    });
    await harness.emit("message_end", { type: "message_end", message: first });
    harness.projection.messages = [{ role: "user", content: "task" }, first];
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: first,
      toolResults: [],
      messageEntryId: "message-1",
      toolResultEntryIds: [],
      entries: [],
      continue: false,
      context: {},
      outcome: "completed",
    });
    await harness.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { tokensBefore: 900 },
      branchEntries: [],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });

    expect(packets(harness.socket, "compaction")).toHaveLength(0);
    const compacted = [{ role: "compactionSummary", summary: "summary" }];
    harness.projection.messages = compacted;
    await harness.emit("session_compact", {
      type: "session_compact",
      compactionEntry: { tokensBefore: 900 },
      fromExtension: false,
      reason: "threshold",
      willRetry: false,
    });
    await flushMicrotasks();
    await harness.emit("session_compact_failed", {
      type: "session_compact_failed",
      reason: "manual",
      aborted: true,
      willRetry: false,
      fromExtension: false,
    });
    await flushMicrotasks();

    expect(packets(harness.socket).map(({ type }) => type)).toEqual([
      "ready",
      "text",
      "tool",
      "tool",
      "usage",
      "turn",
      "snapshot",
      "snapshot",
      "compaction",
      "snapshot",
      "snapshot",
    ]);
    expect(packets(harness.socket, "text")[0]).toMatchObject({ delta: "done", fullText: "done" });
    expect(packets(harness.socket, "usage")[0].usage).toEqual({
      input: 10,
      output: 4,
      cacheWrite: 3,
      cacheRead: 2,
      cost: 0.25,
    });
    expect(packets(harness.socket, "turn")[0].count).toBe(1);
    const snapshots = packets(harness.socket, "snapshot");
    expect(snapshots[0]).toMatchObject({ event: { type: "turn_end" } });
    expect(snapshots[0].snapshot.messages.at(-1)).toEqual(first);
    expect(packets(harness.socket, "compaction")[0].info).toEqual({
      reason: "threshold",
      tokensBefore: 900,
    });
    expect(snapshots.slice(1).map((packet) => packet.event)).toEqual([
      { type: "compaction_start" },
      { type: "compaction_end", aborted: false, result: true },
      { type: "compaction_end", aborted: true, result: false },
    ]);
    expect(snapshots[2].snapshot.messages).toEqual(compacted);
    expect(packets(harness.socket).map(({ seq }) => seq)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1),
    );
  });

  it("settles only at agent_settled and never reuses a previous resumed answer after failure", async () => {
    const old = assistant("old answer");
    const failure = assistant("", { stopReason: "error", errorMessage: "resume provider failed" });
    const harness = createHarness({ messages: [old] });
    await start(harness);
    harness.state.idle = false;

    await harness.emit("agent_end", { type: "agent_end", messages: [failure] });
    expect(packets(harness.socket, "settled")).toHaveLength(0);

    await harness.emit("message_end", { type: "message_end", message: failure });
    harness.projection.messages = [old, { role: "user", content: "resume" }, failure];
    await harness.emit("turn_end", { type: "turn_end", message: failure, toolResults: [] });
    expect(packets(harness.socket, "snapshot").at(-1)?.snapshot.messages.at(-1)).toEqual(failure);

    await harness.emit("agent_settled", { type: "agent_settled" });
    await flushMicrotasks();

    const settled = packets(harness.socket, "settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      text: "",
      aborted: false,
      failure: "resume provider failed",
      snapshot: { messages: harness.projection.messages },
    });
    expect(settled[0].text).not.toBe("old answer");
    expect(harness.shutdown).toHaveBeenCalledOnce();
  });

  it("forces the manifest prompt/tool policy and vetoes provider-extension tools natively", async () => {
    const harness = createHarness();
    await start(harness);
    const options = promptOptions();
    const [result] = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "task",
      systemPrompt: "untrusted",
      systemPromptOptions: options,
    });

    expect(options.forceSystemPrompt).toBe(harness.manifest.systemPrompt);
    expect(options.selectedTools).toEqual(["read", "bash"]);
    expect(result).toEqual({ systemPrompt: harness.manifest.systemPrompt });
    expect(harness.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"]);

    const [allowed] = await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "read-1",
      toolName: "read",
      input: {},
    });
    const [denied] = await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "fixture-1",
      toolName: "provider_fixture_tool",
      input: {},
    });
    expect(allowed).toBeUndefined();
    expect(denied).toEqual({
      block: true,
      reason: i18n.t("bridge.toolDenied", { name: "provider_fixture_tool" }),
      terminate: true,
    });
  });

  it.each([
    ["session id", { sessionId: "wrong-session" }],
    ["session file", { sessionFile: "/tmp/wrong.jsonl" }],
    ["model", { model: { provider: "fixture", id: "wrong-model" } }],
  ])("fails closed on %s mismatch before opening the bridge", async (_label, overrides) => {
    const harness = createHarness(overrides);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.shutdown).toHaveBeenCalledOnce();
    const [input] = await harness.emit("input", { type: "input", text: "must not run", source: "interactive" });
    expect(input).toEqual({ action: "handled" });
  });

  it("acknowledges only accepted steering dispatches and rejects idle or settling input", async () => {
    const socket = new FakeSocket();
    socket.autoFlush = false;
    const harness = createHarness({ socket });
    const starting = harness.emit("session_start", { type: "session_start", reason: "startup" });
    await flushMicrotasks();
    socket.emit("connect");
    await starting;

    await harness.emit("agent_start");
    socket.receive({ type: "steer", id: "idle", message: "too early" });
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(packets(socket, "ack").at(-1)).toMatchObject({
      id: "idle",
      error: i18n.t("bridge.notRunning"),
    });

    harness.state.idle = false;
    socket.receive({ type: "steer", id: "accepted", message: "focus here" });
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("focus here", { deliverAs: "steer" });
    expect(packets(socket, "ack").at(-1)).toMatchObject({ id: "accepted" });
    expect(packets(socket, "ack").at(-1)).not.toHaveProperty("error");

    await harness.emit("message_end", { type: "message_end", message: assistant("final") });
    await harness.emit("agent_settled", { type: "agent_settled" });
    socket.receive({ type: "steer", id: "late", message: "too late" });
    expect(harness.pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(packets(socket, "ack").at(-1)).toMatchObject({
      id: "late",
      error: i18n.t("bridge.notRunning"),
    });
  });

  it("aborts on parent cancellation, flushes settled feedback before shutdown, and cleans up once", async () => {
    const socket = new FakeSocket();
    socket.autoFlush = false;
    const harness = createHarness({ socket, idle: false });
    const starting = harness.emit("session_start", { type: "session_start", reason: "startup" });
    await flushMicrotasks();
    socket.emit("connect");
    await starting;

    // Flush hello + ready so only settlement writes remain outstanding.
    socket.flush(0);
    socket.flush(1);
    socket.receive({ type: "abort" });
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.shutdown).not.toHaveBeenCalled();

    const aborted = assistant("partial", { stopReason: "aborted", errorMessage: "cancelled" });
    await harness.emit("message_end", { type: "message_end", message: aborted });
    harness.projection.messages = [aborted];
    await harness.emit("agent_settled", { type: "agent_settled" });
    const settledIndex = socket.writes.length - 1;
    expect(packets(socket, "settled").at(-1)).toMatchObject({
      text: "partial",
      aborted: true,
      failure: i18n.t("bridge.aborted"),
    });
    expect(harness.shutdown).not.toHaveBeenCalled();

    socket.flush(settledIndex);
    expect(harness.shutdown).not.toHaveBeenCalled();
    // The preceding usage packet is still queued; shutdown waits for every
    // feedback write so settlement cannot truncate earlier observations.
    socket.flush(settledIndex - 1);
    expect(harness.shutdown).toHaveBeenCalledOnce();

    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(socket.end).toHaveBeenCalledOnce();
    expect(socket.listenerCount("data")).toBe(0);
    expect(socket.listenerCount("error")).toBe(1); // absorb asynchronous close/EPIPE errors
    expect(() => socket.emit("error", new Error("late close error"))).not.toThrow();
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("treats protocol faults and connection loss as terminal instead of continuing without the parent", async () => {
    const protocolHarness = createHarness({ idle: false });
    await start(protocolHarness);
    protocolHarness.socket.emit("data", Buffer.from("{invalid-json\n"));
    await flushMicrotasks();
    expect(protocolHarness.abort).toHaveBeenCalledOnce();
    expect(protocolHarness.shutdown).toHaveBeenCalledOnce();
    expect(packets(protocolHarness.socket, "failure").at(-1)).toMatchObject({
      error: i18n.t("bridge.protocol"),
    });
    const [blocked] = await protocolHarness.emit("input", {
      type: "input",
      text: "continue silently",
      source: "interactive",
    });
    expect(blocked).toEqual({ action: "handled" });

    const disconnected = createHarness({ idle: false });
    await start(disconnected);
    disconnected.socket.emit("close");
    expect(disconnected.abort).toHaveBeenCalledOnce();
    expect(disconnected.shutdown).toHaveBeenCalledOnce();
    expect(disconnected.pi.sendUserMessage).not.toHaveBeenCalled();
    const [blockedTool] = await disconnected.emit("tool_call", { toolName: "read" });
    expect(blockedTool).toMatchObject({ block: true, terminate: true });
  });
});
