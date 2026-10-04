import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shutdownEmbeddedSession, steerEmbeddedSession } from "../src/backends/embedded-lifecycle.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function childSession(options: {
  hasHandlers?: boolean;
  emit?: (event: unknown) => unknown;
  dispose?: () => void;
} = {}): AgentSession {
  return {
    extensionRunner: {
      hasHandlers: vi.fn(() => options.hasHandlers ?? true),
      emit: vi.fn(options.emit ?? (async () => {})),
    },
    dispose: vi.fn(options.dispose ?? (() => {})),
  } as unknown as AgentSession;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("embedded session lifecycle", () => {
  it("awaits session_shutdown before disposing the session", async () => {
    const order: string[] = [];
    const emitted = deferred<void>();
    const target = childSession({
      emit: (event) => {
        order.push(`emit:${JSON.stringify(event)}`);
        return emitted.promise;
      },
      dispose: () => { order.push("dispose"); },
    });

    const closing = shutdownEmbeddedSession(target);
    await Promise.resolve();

    expect(order).toEqual(['emit:{"type":"session_shutdown","reason":"quit"}']);
    emitted.resolve();
    await closing;
    expect(order).toEqual([
      'emit:{"type":"session_shutdown","reason":"quit"}',
      "dispose",
    ]);
  });

  it("shares one idempotent cleanup across concurrent and later callers", async () => {
    const emitted = deferred<void>();
    const target = childSession({ emit: () => emitted.promise });

    const first = shutdownEmbeddedSession(target);
    const concurrent = shutdownEmbeddedSession(target);
    expect(concurrent).toBe(first);

    await Promise.resolve();
    expect(target.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(target.dispose).not.toHaveBeenCalled();

    emitted.resolve();
    await Promise.all([first, concurrent]);
    const later = shutdownEmbeddedSession(target);

    expect(later).toBe(first);
    await later;
    expect(target.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(target.dispose).toHaveBeenCalledOnce();
  });

  it("still disposes and resolves when shutdown rejects and dispose throws", async () => {
    const target = childSession({
      emit: async () => { throw new Error("shutdown failed"); },
      dispose: () => { throw new Error("dispose failed"); },
    });

    await expect(shutdownEmbeddedSession(target)).resolves.toBeUndefined();
    expect(target.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(target.dispose).toHaveBeenCalledOnce();
  });

  it("bounds a hung shutdown handler at three seconds", async () => {
    vi.useFakeTimers();
    const target = childSession({ emit: () => new Promise<void>(() => {}) });
    const closing = shutdownEmbeddedSession(target);
    let settled = false;
    void closing.then(() => { settled = true; });

    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    expect(target.dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(settled).toBe(true);
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout timer when shutdown settles early", async () => {
    vi.useFakeTimers();
    const target = childSession();

    await shutdownEmbeddedSession(target);

    expect(target.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(target.dispose).toHaveBeenCalledOnce();
  });

  it("keeps steering awaitable and preserves delivery errors", async () => {
    const delivery = deferred<void>();
    const pendingSession = {
      steer: vi.fn(() => delivery.promise),
    } as unknown as AgentSession;
    const pending = steerEmbeddedSession(pendingSession, "wait for delivery");
    let settled = false;
    void pending.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(pendingSession.steer).toHaveBeenCalledWith("wait for delivery");

    delivery.resolve();
    await pending;
    expect(settled).toBe(true);

    const failure = new Error("steer failed");
    const failingSession = {
      steer: vi.fn(async () => { throw failure; }),
    } as unknown as AgentSession;
    await expect(steerEmbeddedSession(failingSession, "fail")).rejects.toBe(failure);
  });
});
