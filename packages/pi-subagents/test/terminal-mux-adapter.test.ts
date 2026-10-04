import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalDependencies, createTerminalTransport, waitForShellReady, type TerminalMuxApi,
} from "../src/backends/terminal/mux-adapter.js";

function muxDouble() {
  return {
    createSurface: vi.fn(() => "owned-surface"),
    clearLastSplitSource: vi.fn(),
    sendLongCommand: vi.fn(),
    sendEscape: vi.fn(),
    closeSurface: vi.fn(),
    pollForExit: vi.fn(async () => ({ reason: "done" as const, exitCode: 0 })),
  } satisfies TerminalMuxApi;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("terminal mux adapter", () => {
  it("is lazy and delegates surface/command/exit operations to the public mux API", async () => {
    const api = muxDouble();
    const transport = createTerminalTransport(api);
    expect(api.createSurface).not.toHaveBeenCalled();
    expect(api.pollForExit).not.toHaveBeenCalled();
    expect(transport.createSurface("worker")).toBe("owned-surface");
    expect(api.createSurface).toHaveBeenCalledWith("worker");
    expect(api.clearLastSplitSource).toHaveBeenCalledOnce();
    transport.sendCommand("owned-surface", "prepared-command", "/artifacts/launch.sh");
    expect(api.sendLongCommand).toHaveBeenCalledWith("owned-surface", "prepared-command", {
      scriptPath: "/artifacts/launch.sh",
    });
    const signal = new AbortController().signal;
    const onTick = vi.fn();
    await expect(transport.waitForExit("owned-surface", signal, {
      sessionFile: "/sessions/conversation.jsonl", onTick,
    })).resolves.toEqual({ reason: "done", exitCode: 0 });
    expect(api.pollForExit).toHaveBeenCalledWith("owned-surface", signal, {
      interval: 1_000, sessionFile: "/sessions/conversation.jsonl", onTick,
    });
    transport.sendEscape("owned-surface");
    expect(api.sendEscape).toHaveBeenCalledWith("owned-surface");
    expect(api.closeSurface).not.toHaveBeenCalled();
    transport.closeSurface("owned-surface");
    expect(api.closeSurface).toHaveBeenCalledWith("owned-surface");
  });

  it("delegates explicit PowerShell without depending on the host operating system", () => {
    const api = muxDouble();
    const transport = createTerminalTransport(api);
    transport.sendCommand("owned-surface", "prepared-command", "/artifacts/launch.ps1", "powershell");
    expect(api.sendLongCommand).toHaveBeenCalledWith("owned-surface", "prepared-command", {
      scriptPath: "/artifacts/launch.ps1", interpreter: "powershell",
    });
  });

  it("can construct default dependencies without creating a timer or starting a run", () => {
    vi.useFakeTimers();
    const dependencies = createTerminalDependencies();
    expect(dependencies.transport.createSurface).toBeTypeOf("function");
    expect(dependencies.artifacts.prepare).toBeTypeOf("function");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("signal-aware shell readiness", () => {
  it("finishes the delay and detaches its listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const delay = waitForShellReady(500, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    await delay;
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer and listener on cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const delay = waitForShellReady(500, controller.signal);
    const rejected = expect(delay).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("rejects an already-aborted signal without allocating resources", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, "addEventListener");
    await expect(waitForShellReady(500, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
