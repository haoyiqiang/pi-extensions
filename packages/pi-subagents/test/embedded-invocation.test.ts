import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createEmbeddedInvocationPolicy, embeddedStructuredTools, invokeEmbeddedSession, rememberEmbeddedPolicy, observeEmbeddedActivity } from "../src/backends/embedded-invocation.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import { i18n } from "../src/i18n.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const answer = (text: string, stopReason = "stop") => ({ role: "assistant", stopReason,
  content: text ? [{ type: "text", text }] : [], errorMessage: stopReason === "error" ? "provider failed" : undefined });
function fixture(options: { maxTurns?: number; graceTurns?: number; structured?: boolean } = {}) {
  const schema = compileJsonSchema({ type: "object", properties: { value: { type: "integer" } }, required: ["value"] });
  if (schema.ok === false) throw new Error(schema.message);
  const policy = createEmbeddedInvocationPolicy({ ...options, structuredOutput: options.structured ? schema.compiled : undefined });
  const tools = embeddedStructuredTools(policy);
  const listeners = new Set<(event: any) => void>();
  const native = {
    isStreaming: false,
    messages: [] as any[],
    subscribe: (handler: (event: any) => void) => { listeners.add(handler); return () => { listeners.delete(handler); }; },
    prompt: vi.fn(async (_prompt: string) => {}),
    steer: vi.fn(async () => {}),
    sendCustomMessage: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const session = native as unknown as AgentSession;
  rememberEmbeddedPolicy(session, policy);
  const emit = (event: any) => { for (const listener of [...listeners]) listener(event); };
  const complete = (text: string, stopReason = "stop") => {
    const message = answer(text, stopReason);
    emit({ type: "message_start", message });
    emit({ type: "message_end", message });
    native.messages.push(message);
    emit({ type: "turn_end", message });
  };
  const capture = (value: unknown, signal?: AbortSignal) => tools[0].execute("capture", value as never, signal, undefined, {} as any);
  return { native, session, emit, complete, capture, listeners, policy };
}

describe("embedded invocation executor", () => {
  it("starts a new capture and retry allowance for every invocation, with one stable SDK tool", async () => {
    const f = fixture({ structured: true });
    await expect(f.capture({ value: 99 })).rejects.toThrow(i18n.t("invocation.notRunning"));
    f.native.prompt.mockImplementation(async () => { await f.capture({ value: 0 }); f.complete("first prose"); });
    expect(await invokeEmbeddedSession(f.session, "first")).toMatchObject({ structuredJson: '{"value":0}' });
    f.native.prompt.mockImplementationOnce(async () => { f.complete("not structured"); });
    f.native.prompt.mockImplementationOnce(async () => { await f.capture({ value: 2 }); f.complete("recovered"); });
    expect(await invokeEmbeddedSession(f.session, "second")).toMatchObject({ structuredJson: '{"value":2}', structuredRetried: true });
    f.native.prompt.mockImplementation(async () => { f.complete("still missing"); });
    const missing = await invokeEmbeddedSession(f.session, "third");
    expect(missing.structuredJson).toBeUndefined();
    expect(missing.structuredRetried).toBe(true);
    expect(missing.failure).toBeTruthy();
    expect(f.listeners.size).toBe(0);
    await expect(f.capture({ value: 88 })).rejects.toThrow();
  });

  it.each(["error", "aborted", "length"])("does not retry after final %s", async (reason) => {
    const f = fixture({ structured: true });
    f.native.prompt.mockImplementation(async () => { f.complete("", reason); });
    const result = await invokeEmbeddedSession(f.session, "task");
    expect(f.native.prompt).toHaveBeenCalledTimes(1);
    expect(result.structuredRetried).toBeUndefined();
    if (reason === "aborted") expect(result.aborted).toBe(true);
    else expect(result.failure).toBeTruthy();
  });

  it("counts the schema retry in the same hard budget and resets only on a new invocation", async () => {
    const f = fixture({ structured: true, maxTurns: 1, graceTurns: 1 });
    f.native.prompt.mockImplementation(async () => { f.complete("missing"); });
    for (const prompt of ["first", "second"]) {
      const turns: number[] = [];
      const result = await invokeEmbeddedSession(f.session, prompt, { onTurnEnd: (count) => turns.push(count) });
      expect(turns).toEqual([1, 2]);
      expect(result).toMatchObject({ aborted: true, steered: true, structuredRetried: true, failure: i18n.t("terminalPolicy.turnLimit") });
    }
    expect(f.native.sendCustomMessage).toHaveBeenCalledTimes(2);
    expect(f.native.steer).not.toHaveBeenCalled();
  });

  it("does not let throwing observers bypass the hard cap", async () => {
    const f = fixture({ maxTurns: 1, graceTurns: 1 });
    f.native.prompt.mockImplementation(async () => { f.complete("one"); f.complete("two"); f.emit({ type: "turn_end" }); });
    const result = await invokeEmbeddedSession(f.session, "task", { onTurnEnd: () => { throw new Error("observer"); } });
    expect(result.aborted).toBe(true);
    expect(f.native.abort).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
  });

  it("rejects re-entry before onSessionCreated can clobber the active capture", async () => {
    const f = fixture({ structured: true });
    f.native.prompt.mockImplementation(async () => { await f.capture({ value: 1 }); f.complete("done"); });
    let rejected: Promise<unknown> | undefined;
    const result = await invokeEmbeddedSession(f.session, "first", {}, () => {
      rejected = expect(invokeEmbeddedSession(f.session, "overlap")).rejects.toThrow(i18n.t("invocation.busy"));
    });
    await rejected;
    expect(result.structuredJson).toBe('{"value":1}');
    expect(f.native.prompt).toHaveBeenCalledTimes(1);
  });

  it("latches cancellation across asynchronous prompt preflight", async () => {
    const f = fixture({ structured: true });
    const started = deferred();
    const preflight = deferred();
    let operationAborted = false;
    let requests = 0;
    f.native.abort.mockImplementation(async () => { operationAborted = true; });
    f.native.prompt.mockImplementation(async () => {
      started.resolve();
      await preflight.promise;
      operationAborted = false; // Pi installs a new operation signal after preflight.
      f.emit({ type: "agent_start" });
      if (!operationAborted) requests++;
    });
    const controller = new AbortController();
    const pending = invokeEmbeddedSession(f.session, "task", { signal: controller.signal });
    await started.promise;
    controller.abort();
    preflight.resolve();
    expect(await pending).toMatchObject({ aborted: true });
    expect(requests).toBe(0);
    expect(f.native.abort).toHaveBeenCalledTimes(2);
    expect(f.native.prompt).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(0);
  });

  it("latches a native operation abort even if the final assistant stopped normally", async () => {
    const f = fixture({ structured: true });
    const native = new AbortController();
    Object.assign(f.native, { agent: { signal: native.signal } });
    const remove = vi.spyOn(native.signal, "removeEventListener");
    f.native.prompt.mockImplementation(async () => {
      f.emit({ type: "agent_start" });
      f.complete("normal final message");
      native.abort();
    });
    const result = await invokeEmbeddedSession(f.session, "cancel natively");
    expect(result.aborted).toBe(true);
    expect(result.structuredRetried).toBeUndefined();
    expect(f.native.prompt).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("drains abort work appended by a failed control during cleanup", async () => {
    const f = fixture({ maxTurns: 1, graceTurns: 2 });
    const delivery = deferred();
    const abortCalled = deferred();
    const drain = deferred();
    f.native.sendCustomMessage.mockImplementation(async () => { await delivery.promise; throw new Error("delivery"); });
    f.native.abort.mockImplementation(async () => { abortCalled.resolve(); await drain.promise; });
    f.native.prompt.mockImplementation(async () => { f.complete("answer"); });
    let settled = false;
    const pending = invokeEmbeddedSession(f.session, "task").then((result) => { settled = true; return result; });
    await Promise.resolve();
    delivery.resolve();
    await abortCalled.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(invokeEmbeddedSession(f.session, "too early")).rejects.toThrow(i18n.t("invocation.busy"));
    drain.resolve();
    expect(await pending).toMatchObject({ failure: i18n.t("invocation.wrapUpFailed") });
  });

  it("sends session-lifetime extension errors only to the current guarded observer", async () => {
    const f = fixture();
    const first = vi.fn();
    const second = vi.fn(() => { throw new Error("observer failed"); });
    const activity = { type: "end" as const, toolName: "extension-error:test" };
    f.native.prompt.mockImplementation(async () => { observeEmbeddedActivity(f.policy, activity); f.complete("ok"); });
    await invokeEmbeddedSession(f.session, "first", { onToolActivity: first });
    observeEmbeddedActivity(f.policy, activity);
    await invokeEmbeddedSession(f.session, "second", { onToolActivity: second });
    observeEmbeddedActivity(f.policy, activity);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("never starts a prompt for an already-aborted signal", async () => {
    const f = fixture({ structured: true });
    const controller = new AbortController();
    controller.abort();
    expect(await invokeEmbeddedSession(f.session, "skip", { signal: controller.signal })).toMatchObject({ aborted: true });
    expect(f.native.prompt).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0);
  });

  it("retains its lock while the abort operation drains", async () => {
    const f = fixture();
    const drain = deferred();
    const controller = new AbortController();
    f.native.abort.mockImplementation(() => drain.promise);
    f.native.prompt.mockImplementation(async () => { controller.abort(); });
    const pending = invokeEmbeddedSession(f.session, "first", { signal: controller.signal });
    await Promise.resolve();
    await expect(invokeEmbeddedSession(f.session, "too early")).rejects.toThrow(i18n.t("invocation.busy"));
    drain.resolve();
    await pending;
    f.native.prompt.mockImplementation(async () => { f.complete("new"); });
    expect(await invokeEmbeddedSession(f.session, "after drain")).toMatchObject({ text: "new", aborted: false });
  });

  it.each(["stop", "error"])("uses invocation-local finalized messages after compaction (%s)", async (reason) => {
    const f = fixture({ structured: true });
    f.native.messages.push(answer("old answer"));
    f.native.prompt.mockImplementation(async () => {
      f.complete(reason === "stop" ? "new answer" : "partial error", reason);
      f.native.messages = [];
    });
    const result = await invokeEmbeddedSession(f.session, "task");
    expect(result.text).toBe(reason === "stop" ? "new answer" : "partial error");
    if (reason === "error") { expect(result.failure).toBe("provider failed"); expect(f.native.prompt).toHaveBeenCalledTimes(1); }
  });

  it("releases listeners and the invocation lock after a prompt or setup callback throws", async () => {
    const f = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(invokeEmbeddedSession(f.session, "first", { signal: controller.signal }, () => { throw new Error("setup"); })).rejects.toThrow("setup");
    f.native.prompt.mockRejectedValueOnce(new Error("prompt"));
    await expect(invokeEmbeddedSession(f.session, "second", { signal: controller.signal })).rejects.toThrow("prompt");
    f.native.prompt.mockImplementation(async () => { f.complete("ok"); });
    expect(await invokeEmbeddedSession(f.session, "third")).toMatchObject({ text: "ok" });
    expect(f.listeners.size).toBe(0);
    expect(remove).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(f.native.abort).not.toHaveBeenCalled();
  });
});
