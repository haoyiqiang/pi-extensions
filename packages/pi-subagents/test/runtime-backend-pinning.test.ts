import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const productBackend = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/product-backend.js", () => ({
  createProductExecutionBackend: productBackend.create,
}));

import { createAgentRuntime } from "../src/agent-runtime.js";
import type { ExecutionSession } from "../src/backends/session.js";
import type { AgentExecutionBackend, ExecutionRunOptions } from "../src/backends/types.js";
import {
  prepareStandardTerminalPolicy,
  validateStandardTerminalPolicy,
} from "../src/backends/terminal/standard-policy.js";
import { initializeSubagentsRuntime } from "../src/runtime.js";

const roots: string[] = [];

afterEach(() => {
  productBackend.create.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-runtime-pin-"));
  roots.push(cwd);
  return cwd;
}

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: () => "root-session",
      getSessionFile: () => undefined,
      getBranch: () => [],
    },
    getSystemPrompt: () => "parent prompt",
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

function extensionHarness() {
  const lifecycle = new Map<string, Set<(...args: any[]) => unknown>>();
  const bus = new Map<string, Set<(data: unknown) => unknown>>();
  const add = <T extends (...args: any[]) => unknown>(map: Map<string, Set<T>>, name: string, fn: T) => {
    const handlers = map.get(name) ?? new Set<T>();
    handlers.add(fn);
    map.set(name, handlers);
    return () => handlers.delete(fn);
  };
  const pi = {
    on: (name: string, fn: (...args: any[]) => unknown) => add(lifecycle, name, fn),
    events: {
      on: (name: string, fn: (data: unknown) => unknown) => add(bus, name, fn),
      emit: (name: string, data: unknown) => {
        for (const fn of [...(bus.get(name) ?? [])]) fn(data);
      },
    },
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return {
    pi,
    async fire(name: string, ...args: any[]) {
      for (const fn of [...(lifecycle.get(name) ?? [])]) await fn(...args);
    },
    rpc(channel: string, payload: Record<string, unknown>): Promise<any> {
      const requestId = "pin-request";
      return new Promise((resolve) => {
        const off = pi.events.on(`${channel}:reply:${requestId}`, (reply: unknown) => {
          off();
          resolve(reply);
        });
        pi.events.emit(channel, { requestId, ...payload });
      });
    },
  };
}

describe("scoped backend pinning", () => {
  it("drops an RPC backend override before the scoped manager dispatches", async () => {
    const cwd = tempCwd();
    initializeSubagentsRuntime(cwd);
    const seen: ExecutionRunOptions[] = [];
    const opened: ExecutionSession = {
      reference: { backend: "embedded", sessionId: "child" },
      messages: [],
      getSessionStats: () => ({
        tokens: { input: 0, output: 0, cacheWrite: 0 },
        contextUsage: { percent: null },
      }),
      subscribe: () => () => {},
    };
    const backend: AgentExecutionBackend = {
      kind: "embedded",
      async run(_ctx, _type, _prompt, options) {
        seen.push(options);
        options.onSessionCreated?.(opened);
        return { responseText: "done", session: opened, aborted: false, steered: false };
      },
      resume: async () => ({ text: "resumed" }),
      steer: async () => {},
      shutdown: async () => {},
    };
    productBackend.create.mockReturnValue(backend);
    const h = extensionHarness();
    const ctx = context(cwd);
    createAgentRuntime({ backend: "embedded" })(h.pi);
    await h.fire("session_start", {}, ctx);

    const reply = await h.rpc("subagents:rpc:spawn", {
      type: "general-purpose",
      prompt: "inspect",
      options: { description: "rpc child", backend: "terminal", isBackground: true },
    });

    expect(reply).toMatchObject({ success: true, data: { id: expect.any(String) } });
    expect(productBackend.create).toHaveBeenCalledWith({ cwd, backend: "embedded" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.backend).toBeUndefined();
    await h.fire("session_shutdown", { reason: "quit" });
  });

  it("persists a terminal-owned descendant pin in standard policy", async () => {
    const cwd = tempCwd();
    const ctx = context(cwd);
    const pi = {
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "", killed: false })),
    } as unknown as ExtensionAPI;
    const { policy } = await prepareStandardTerminalPolicy(ctx, "parent", {
      pi,
      cwd,
      configCwd: cwd,
      agentConfig: {
        name: "parent",
        description: "Nested terminal parent",
        builtinToolNames: ["read"],
        extensions: false,
        skills: false,
        allowedSubagents: ["general-purpose"],
        systemPrompt: "",
      },
    });

    expect(policy.nested).toMatchObject({ backend: "terminal", depth: 1 });
    expect(JSON.parse(JSON.stringify(policy)).nested.backend).toBe("terminal");
    expect(() => validateStandardTerminalPolicy({
      ...policy,
      nested: { ...policy.nested!, backend: "embedded" },
    })).toThrow();
  });
});
