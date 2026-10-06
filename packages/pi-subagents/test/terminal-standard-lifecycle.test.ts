import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStandardTerminalExecutionBackend } from "../src/backends/terminal/backend.js";
import type { TerminalBridge } from "../src/backends/terminal/bridge-server.js";
import type { ChildFeedback, TerminalSnapshot } from "../src/backends/terminal/bridge-protocol.js";
import type { ExecutionSession } from "../src/backends/session.js";
import {
  adoptStandardTerminalSession,
  createStandardTerminalSession,
  openStandardTerminalSession,
  quarantineStandardTerminalSession,
} from "../src/backends/terminal/standard-session.js";
import type { StandardTerminalPolicy } from "../src/backends/terminal/standard-policy.js";
import { i18n } from "../src/i18n.js";
import type { AgentConfig } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agent(): AgentConfig {
  return {
    name: "persistent-terminal",
    description: "persistent terminal fixture",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "captured prompt",
    promptMode: "replace",
    persistSession: true,
    interactive: true,
    autoExit: false,
  };
}

function snapshot(text = "", percent: number | null = 42): TerminalSnapshot {
  return {
    messages: text ? [{ role: "assistant", content: [{ type: "text", text }] }] : [],
    stats: { tokens: { input: 1, output: text ? 1 : 0, cacheWrite: 0 }, contextUsage: { percent } },
  };
}

describe("standard persistent terminal lifecycle", () => {
  it("persists quarantine so uncertain writers cannot be restored", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-standard-quarantine-"));
    roots.push(root);
    const captured = agent();
    const policy: StandardTerminalPolicy = {
      profile: "standard",
      type: captured.name,
      name: captured.name,
      cwd: root,
      configCwd: root,
      cli: "pi",
      agent: captured,
      isolated: false,
      projectTrusted: true,
      persistSession: true,
      tools: ["read"],
      systemPrompt: "captured prompt",
      interactive: false,
      autoExit: true,
    };
    const reference = createStandardTerminalSession(policy, join(root, "sessions"));
    quarantineStandardTerminalSession(reference);
    expect(existsSync(reference.sessionFile)).toBe(true);
    expect(existsSync(`${reference.sessionFile}.pi-subagents-terminal.json`)).toBe(true);
    expect(() => openStandardTerminalSession(reference)).toThrow(i18n.t("terminalBackend.quarantined"));
    expect(() => adoptStandardTerminalSession(reference.sessionFile, policy)).toThrow(i18n.t("terminalBackend.quarantined"));
  });

  it("reuses one authenticated CLI, admits each SDK round, reports idle, and interrupts through the bridge", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-standard-persistent-"));
    roots.push(root);
    const receipt = deferred<{ reason: "sentinel"; exitCode: number }>();
    const ready = deferred<TerminalSnapshot>();
    const settled = deferred<Extract<ChildFeedback, { type: "settled" }>>();
    let feedback!: (event: ChildFeedback) => void;
    const bridge: TerminalBridge = {
      endpoint: { host: "127.0.0.1", port: 1, token: "offline" },
      ready: ready.promise,
      settled: settled.promise,
      start: vi.fn(),
      admit: vi.fn(),
      steer: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      abort: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const closeSurface = vi.fn();
    const sendEscape = vi.fn();
    const backend = createStandardTerminalExecutionBackend({
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      artifactDir: join(root, "runs"),
      exitTimeoutMs: 100,
    }, {
      bridge: async (_run, listener) => { feedback = listener; return bridge; },
      waitForExit: () => receipt.promise,
      dependencies: {
        transport: {
          createSurface: () => "surface-1",
          sendCommand: () => queueMicrotask(() => {
            const first = snapshot();
            feedback({ type: "ready", snapshot: first });
            ready.resolve(first);
          }),
          sendEscape,
          closeSurface,
          waitForExit: () => receipt.promise,
        },
        artifacts: { prepare: () => ({ byteOffset: 0 }), readSummary: () => undefined },
        now: Date.now,
        delay: async () => {},
      },
    });
    const ctx = {
      cwd: root,
      model: undefined,
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
      getSystemPrompt: () => "parent prompt",
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;
    const pi = { exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "", killed: false })) } as any;
    const created = deferred<ExecutionSession>();
    const acquire = vi.fn(async () => {});
    const idle = vi.fn();
    const operation = backend.run(ctx, "persistent-terminal", "first", {
      pi,
      agentConfig: agent(),
      cwd: root,
      configCwd: root,
      interactive: true,
      autoExit: false,
      acquireExecution: acquire,
      onExecutionIdle: idle,
      onSessionCreated: created.resolve,
    });
    void operation.catch(() => {});
    const handle = await created.promise;

    feedback({ type: "execution_request", id: "round-1" });
    await vi.waitFor(() => expect(bridge.admit).toHaveBeenCalledWith("round-1"));
    expect(acquire).toHaveBeenCalledOnce();
    feedback({ type: "idle", executionId: "round-1", snapshot: snapshot("first answer", 37), text: "first answer", aborted: false });
    expect(idle).toHaveBeenCalledWith({ text: "first answer" });
    expect(handle.getSessionStats().contextUsage?.percent).toBe(37);

    const resumedAcquire = vi.fn(async () => {});
    const resumedIdle = vi.fn();
    const resumed = backend.resume(handle, "second", {
      acquireExecution: resumedAcquire,
      onExecutionIdle: resumedIdle,
    });
    await vi.waitFor(() => expect(bridge.steer).toHaveBeenCalledWith("second"));
    feedback({ type: "execution_request", id: "round-2" });
    await vi.waitFor(() => expect(bridge.admit).toHaveBeenCalledWith("round-2"));
    expect(resumedAcquire).toHaveBeenCalledOnce();
    await backend.interrupt!(handle);
    expect(bridge.interrupt).toHaveBeenCalledOnce();
    expect(sendEscape).not.toHaveBeenCalled();

    appendFileSync(handle.reference.sessionFile!, "\n");
    const second = snapshot("second partial", 61);
    feedback({ type: "idle", executionId: "round-2", snapshot: second, text: "second partial", aborted: true });
    await expect(resumed).resolves.toEqual({ text: "second partial", aborted: true });
    expect(resumedIdle).toHaveBeenCalledWith({ text: "second partial", aborted: true });
    expect(handle.getSessionStats().contextUsage?.percent).toBe(61);
    expect(bridge.steer).toHaveBeenCalledOnce();

    const deniedIdle = vi.fn();
    const denied = backend.resume(handle, "denied", {
      acquireExecution: async () => { throw new Error("no execution slot"); },
      onExecutionIdle: deniedIdle,
    });
    await vi.waitFor(() => expect(bridge.steer).toHaveBeenCalledWith("denied"));
    feedback({ type: "execution_request", id: "round-3" });
    await expect(denied).rejects.toThrow("no execution slot");
    expect(bridge.admit).toHaveBeenCalledWith("round-3", "no execution slot");
    const deniedSettlement = snapshot("", 61);
    feedback({
      type: "settled", executionId: "round-3", snapshot: deniedSettlement,
      text: "", aborted: true, failure: "no execution slot",
    });
    expect(deniedIdle).not.toHaveBeenCalled();

    const shuttingDown = backend.shutdown(handle);
    receipt.resolve({ reason: "sentinel", exitCode: 0 });
    await shuttingDown;
    const final = await operation;
    expect(final).toMatchObject({ aborted: true });
    expect(final).not.toHaveProperty("failure");
    expect(closeSurface).toHaveBeenCalledOnce();
  });
});
