import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTerminalExecutionBackend } from "../src/backends/terminal/backend.js";
import type { TerminalBridge } from "../src/backends/terminal/bridge-server.js";
import type { ChildFeedback, TerminalSnapshot } from "../src/backends/terminal/bridge-protocol.js";
import type { ExecutionSession } from "../src/backends/session.js";
import type { TerminalDependencies, TerminalExit } from "../src/backends/terminal/types.js";
import { i18n } from "../src/i18n.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import type { ExecutionRunOptions } from "../src/backends/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const snapshot: TerminalSnapshot = {
  messages: [], model: { provider: "faux", id: "local" }, thinkingLevel: "off",
  stats: { tokens: { input: 1, output: 2, cacheWrite: 0 }, contextUsage: { percent: null } },
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(exitTimeoutMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), "pi-terminal-backend-"));
  dirs.push(dir);
  const calls: Array<{
    run: any; feedback(value: ChildFeedback): void; ready: ReturnType<typeof deferred<TerminalSnapshot>>;
    settled: ReturnType<typeof deferred<Extract<ChildFeedback, { type: "settled" }>>>;
    exit: ReturnType<typeof deferred<TerminalExit>>; bridge: TerminalBridge;
  }> = [];
  let surface = 0;
  const transport: TerminalDependencies["transport"] = {
    createSurface: () => `surface-${++surface}`,
    sendCommand: () => {
      const call = calls.at(-1)!;
      queueMicrotask(() => { call.feedback({ type: "ready", snapshot }); call.ready.resolve(snapshot); });
    },
    sendEscape: vi.fn(), closeSurface: vi.fn(),
    waitForExit: () => calls.at(-1)!.exit.promise,
  };
  const backend = createTerminalExecutionBackend({ sessionDir: join(dir, "sessions"), artifactDir: join(dir, "runs"), exitTimeoutMs }, {
    dependencies: { transport, artifacts: { prepare: () => ({ byteOffset: 0 }), readSummary: () => "from artifact" }, now: Date.now, delay: async () => {} },
    waitForExit: () => calls.at(-1)!.exit.promise,
    bridge: async (run, feedback) => {
      const ready = deferred<TerminalSnapshot>();
      const settled = deferred<Extract<ChildFeedback, { type: "settled" }>>();
      const exit = deferred<TerminalExit>();
      const bridge: TerminalBridge = {
        endpoint: { host: "127.0.0.1", port: 1, token: "test-only" },
        ready: ready.promise, settled: settled.promise,
        start: vi.fn(), steer: vi.fn(async () => {}), abort: vi.fn(), close: vi.fn(async () => {}),
      };
      calls.push({ run, feedback, ready, settled, exit, bridge });
      return bridge;
    },
  });
  const ctx = { cwd: dir, getSystemPrompt: () => "parent", model: { provider: "faux", id: "local", name: "Local" },
    modelRegistry: { find: () => undefined, getAll: () => [] } } as unknown as ExtensionContext;
  const pi = { exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) } as any;
  function finish(index: number, text = "wire result", extra: Partial<Extract<ChildFeedback, { type: "settled" }>> = {}) {
    const call = calls[index];
    const final = { type: "settled" as const, snapshot: { ...snapshot, messages: [{ role: "assistant", content: [{ type: "text", text }] }] }, text, aborted: false, ...extra };
    call.feedback(final);
    call.settled.resolve(final);
    call.exit.resolve({ reason: "sentinel", exitCode: 0 });
  }
  async function running(signal?: AbortSignal, extra: Partial<ExecutionRunOptions> = {}) {
    const ready = deferred<ExecutionSession>();
    const promise = backend.run(ctx, "general-purpose", "task", { pi, isolated: true, signal, ...extra, onSessionCreated: ready.resolve });
    void promise.catch(ready.reject);
    const handle = await ready.promise;
    return { promise, handle };
  }
  return { backend, calls, transport, ctx, pi, finish, running };
}

function compiledSchema() {
  const result = compileJsonSchema({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] });
  if (result.ok === false) throw new Error(result.message);
  return result.compiled;
}

describe("real terminal backend coordinator port", () => {
  it("propagates validated schema data and flags, refreshing them on resume", async () => {
    const f = fixture();
    const first = await f.running(undefined, { structuredOutput: compiledSchema(), maxTurns: 2 });
    f.finish(0, "prose", { structuredJson: '{"answer":"first"}', structuredRetried: true, steered: true });
    await expect(first.promise).resolves.toMatchObject({ structuredJson: '{"answer":"first"}', structuredRetried: true, steered: true });
    const ready = new Promise<void>((resolve) => { const off = first.handle.subscribe(() => { off(); resolve(); }); });
    const resumed = f.backend.resume(first.handle, "again");
    await ready;
    f.finish(1, "new prose", { structuredJson: '{"answer":"second"}' });
    await expect(resumed).resolves.toEqual({ text: "new prose", failure: undefined, structuredJson: '{"answer":"second"}' });
    await f.backend.shutdown(first.handle);
  });

  it.each([undefined, "broken JSON", '{"answer":42}', "null", "[]"])("rejects invalid or missing wire data despite a success claim: %s", async (structuredJson) => {
    const f = fixture();
    const run = await f.running(undefined, { structuredOutput: compiledSchema() });
    f.finish(0, "not a substitute", { structuredJson });
    const result = await run.promise;
    expect(result.failure).toBe(i18n.t("terminalPolicy.invalidResult"));
    expect(result.structuredJson).toBeUndefined();
    await f.backend.shutdown(run.handle);
  });

  it("also applies the caller's validator without serializing its closure", async () => {
    const f = fixture();
    const run = await f.running(undefined, { structuredOutput: { ...compiledSchema(), check: () => "caller rejected" } });
    f.finish(0, "prose", { structuredJson: '{"answer":"valid JSON Schema but caller rejects"}' });
    await expect(run.promise).resolves.toMatchObject({ failure: i18n.t("terminalPolicy.invalidResult") });
    await f.backend.shutdown(run.handle);
  });

  it("rejects unsolicited structured data for a plain invocation", async () => {
    const f = fixture();
    const run = await f.running();
    f.finish(0, "prose", { structuredJson: '{"answer":"unrequested"}' });
    await expect(run.promise).resolves.toMatchObject({ failure: i18n.t("terminalPolicy.invalidResult") });
    await f.backend.shutdown(run.handle);
  });

  it("fails closed for native Windows until job-object retirement is available", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(() => createTerminalExecutionBackend()).toThrow(i18n.t("terminalBackend.unsupported", { feature: "win32/process-tree" }));
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });

  it("bounds retirement after settled and quarantines a process that will not exit", async () => {
    const f = fixture(20);
    const run = await f.running();
    const final = { type: "settled" as const, snapshot, text: "finished answer", aborted: false };
    f.calls[0].feedback(final);
    f.calls[0].settled.resolve(final);
    await expect(run.promise).resolves.toMatchObject({ responseText: "finished answer", failure: i18n.t("bridge.retirementTimeout") });
    expect(f.transport.closeSurface).toHaveBeenCalledOnce();
    await expect(f.backend.resume(run.handle, "unsafe")).rejects.toThrow(i18n.t("terminalBackend.quarantined"));
    await f.backend.shutdown(run.handle);
  });

  it("keeps an owned native-free session view and reuses it across fresh-process resume", async () => {
    const f = fixture();
    const first = await f.running();
    expect(first.handle.reference.backend).toBe("terminal");
    expect(first.handle).not.toHaveProperty("sessionManager");
    expect(first.handle).not.toHaveProperty("prompt");
    f.finish(0);
    await expect(first.promise).resolves.toMatchObject({ responseText: "wire result", session: first.handle });
    expect(f.transport.closeSurface).toHaveBeenCalledOnce();
    const notifications = vi.fn();
    const unsubscribe = first.handle.subscribe(notifications);
    const second = f.backend.resume(first.handle, "again");
    // Ready signal comes from the injected launch, not a log/status poll.
    const waitForReady = new Promise<void>((resolve) => {
      const off = first.handle.subscribe(() => { off(); resolve(); });
    });
    await waitForReady;
    expect(f.calls[1].run.runId).not.toBe(f.calls[0].run.runId);
    expect(f.calls[1].run.session).toEqual(f.calls[0].run.session);
    await f.backend.steer(first.handle, "correction");
    expect(f.calls[1].bridge.steer).toHaveBeenCalledWith("correction");
    expect(f.transport.sendEscape).not.toHaveBeenCalled();
    f.finish(1, "resumed");
    await expect(second).resolves.toEqual({ text: "resumed", failure: undefined });
    expect(first.handle.messages.at(-1)?.content).toEqual([{ type: "text", text: "resumed" }]);
    unsubscribe();
    await f.backend.shutdown(first.handle);
    await expect(f.backend.resume(first.handle, "closed")).rejects.toThrow(i18n.t("backend.closedSession"));
  });

  it("rejects foreign handles and concurrent writers to one session", async () => {
    const f = fixture();
    const run = await f.running();
    await expect(f.backend.resume({} as ExecutionSession, "foreign")).rejects.toThrow(i18n.t("backend.invalidSession"));
    await expect(f.backend.resume(run.handle, "overlap")).rejects.toThrow(i18n.t("terminalBackend.busy"));
    f.finish(0);
    await run.promise;
    await f.backend.shutdown(run.handle);
  });

  it("cancels, retires feedback and quarantines uncertain process shutdown", async () => {
    const f = fixture();
    const controller = new AbortController();
    const run = await f.running(controller.signal);
    controller.abort();
    await expect(run.promise).resolves.toMatchObject({ aborted: true });
    expect(f.transport.closeSurface).toHaveBeenCalledOnce();
    expect(f.calls[0].bridge.close).toHaveBeenCalledOnce();
    await expect(f.backend.resume(run.handle, "unsafe retry")).rejects.toThrow(i18n.t("terminalBackend.quarantined"));
    const first = f.backend.shutdown(run.handle);
    expect(f.backend.shutdown(run.handle)).toBe(first);
    await first;
  });

  it("does not report success until the child process has exited", async () => {
    const f = fixture();
    const run = await f.running();
    const final = { type: "settled" as const, snapshot, text: "done", aborted: false };
    f.calls[0].feedback(final);
    f.calls[0].settled.resolve(final);
    let completed = false;
    void run.promise.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    f.calls[0].exit.resolve({ reason: "sentinel", exitCode: 0 });
    await run.promise;
    expect(completed).toBe(true);
    await f.backend.shutdown(run.handle);
  });
});
