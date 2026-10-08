import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { AgentExecutionBackend, ExecutionRunOptions } from "../src/backends/types.js";
import type { ExecutionSession } from "../src/backends/session.js";

const ports = vi.hoisted(() => ({ backend: undefined as AgentExecutionBackend | undefined }));
vi.mock("../src/product-backend.js", () => ({ createProductExecutionBackend: () => ports.backend }));

import subagentsExtension from "../index.js";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { ExtensionPolicyError } from "../src/extension-defaults.js";
import { captureRuntimePolicy } from "../src/runtime-policy.js";
import { ctx as makeContext, flush, hermeticDir, makePi as makeBasePi } from "./helpers/boot-extension.js";

function makePi() {
  const boot = makeBasePi();
  const listeners = new Map<string, Set<(...args: any[]) => unknown>>();
  boot.pi.on.mockImplementation((event: string, handler: (...args: any[]) => unknown) => {
    const set = listeners.get(event) ?? new Set();
    set.add(handler);
    listeners.set(event, set);
    boot.lifecycle.set(event, async (...args: any[]) => {
      for (const listener of [...set]) await listener(...args);
    });
    return () => set.delete(handler);
  });
  return boot;
}

beforeAll(() => initTheme(undefined, false));
afterEach(() => {
  registerAgents(new Map());
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  ports.backend = undefined;
});

describe("root admission after a failed definition migration reload", () => {
  it.each(["legacy definition", "invalid default"])("keeps owned foreground/background resume after %s while fresh admission fails", async failure => {
    const env = hermeticDir({
      settings: { schedulingEnabled: false, outputTranscript: false, backgroundByDefault: false },
      agentFiles: { custom: "---\ndescription: approved\nextensions: [approved-tools]\n---\nOriginal approved prompt" },
    });
    const boot = makePi();
    const ctx = makeContext({ cwd: env.dir });
    const calls: ExecutionRunOptions[] = [];
    const session: ExecutionSession = {
      reference: { backend: "embedded", sessionId: "owned-resume-fixture" }, messages: [],
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
      subscribe: () => () => {},
    };
    const resume = vi.fn(async () => ({ text: "owned answer" }));
    ports.backend = {
      kind: "embedded",
      async run(_ctx, _type, _prompt, options) {
        calls.push(options);
        await Promise.resolve();
        options.onSessionCreated?.(session);
        return { session, responseText: "approved result", aborted: false, steered: false };
      },
      resume, steer: async () => {}, shutdown: async () => {},
    };
    try {
      subagentsExtension(boot.pi);
      await boot.lifecycle.get("session_start")({}, ctx);
      const facade = (globalThis as any)[Symbol.for("pi-subagents:manager")];
      const id = facade.spawn(boot.pi, ctx, "custom", "first", { description: "first", isBackground: true });
      await facade.waitForAll();
      expect(calls[0].resolvedExtensions).toEqual(["approved-tools"]);
      if (failure === "legacy definition") {
        writeFileSync(join(env.dir, ".pi/agents/custom.md"), "---\ninherit_extensions: false\n---\nMust migrate");
      } else {
        writeFileSync(join(env.dir, ".pi/subagents.json"), '{"defaultExtensions":null}');
      }
      expect(() => facade.spawn(boot.pi, ctx, "custom", "must fail", { description: "bad" })).toThrow(ExtensionPolicyError);
      const tool = boot.tools.get("Agent");
      await expect(tool.execute("fresh", { subagent_type: "custom", description: "bad", prompt: "bad" }, undefined, undefined, ctx))
        .rejects.toThrow(ExtensionPolicyError);
      const args = { subagent_type: "ignored-type", description: "continue", prompt: "continue", resume: id, model: "ignored-model" };
      const foreground = await tool.execute("owned-foreground", { ...args, run_in_background: false }, undefined, undefined, ctx);
      expect(foreground.content[0].text).toBe("owned answer");
      const background = await tool.execute("owned-background", { ...args, run_in_background: true }, undefined, undefined, ctx);
      expect(background.content[0].text).toContain("resumed");
      await facade.waitForAll();
      expect(resume).toHaveBeenCalledTimes(2);
      expect(calls).toHaveLength(1);
      expect(calls[0].resolvedExtensions).toEqual(["approved-tools"]);
      expect(facade.getRecord(id).session).toBe(session);
      const missing = await tool.execute("missing", { ...args, resume: "missing" }, undefined, undefined, ctx);
      expect(missing.content[0].text).toContain("Agent not found");
    } finally {
      await boot.lifecycle.get("session_shutdown")?.({ reason: "quit" }, ctx);
      env.restore();
    }
  });

  it("rejects fresh Agent/facade admissions without discarding already-admitted policies", async () => {
    const env = hermeticDir({
      settings: { maxConcurrent: 1, schedulingEnabled: false, outputTranscript: false },
      agentFiles: { custom: "---\ndescription: approved\n---\nOriginal approved prompt" },
    });
    const boot = makePi();
    const ctx = makeContext({ cwd: env.dir });
    const calls: ExecutionRunOptions[] = [];
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    ports.backend = {
      kind: "embedded",
      async run(_ctx, _type, _prompt, options) {
        calls.push(options);
        const session: ExecutionSession = {
          reference: { backend: "embedded", sessionId: `fixture-${calls.length}` }, messages: [],
          getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
          subscribe: () => () => {},
        };
        await Promise.resolve();
        options.onSessionCreated?.(session);
        if (calls.length === 1) await gate;
        return { session, responseText: "approved result", aborted: false, steered: false };
      },
      resume: async () => ({ text: "approved resume" }), steer: async () => {}, shutdown: async () => {},
    };
    try {
      subagentsExtension(boot.pi);
      await boot.lifecycle.get("session_start")({}, ctx);
      const facade = (globalThis as any)[Symbol.for("pi-subagents:manager")];
      const first = facade.spawn(boot.pi, ctx, "custom", "first", { description: "first", isBackground: true });
      const queued = facade.spawn(boot.pi, ctx, "custom", "queued", { description: "queued", isBackground: true });
      await flush();
      expect(facade.getRecord(first).status).toBe("running");
      expect(facade.getRecord(queued).status).toBe("queued");
      const path = join(env.dir, ".pi", "agents", "custom.md");
      writeFileSync(path, "---\ndescription: changed\ninherit_extensions: false\nextensions: true\n---\nUnapproved prompt");
      writeFileSync(join(env.dir, ".pi", "subagents.json"), JSON.stringify({
        defaultExtensions: false, maxConcurrent: 1, schedulingEnabled: false, outputTranscript: false,
      }));
      expect(() => loadCustomAgents(env.dir, false, { projectTrusted: true })).toThrow(ExtensionPolicyError);
      // The old registry remains available for observations, not for new admission.
      expect(getAgentConfig("custom")?.systemPrompt).toBe("Original approved prompt");
      expect(captureRuntimePolicy(env.dir, true).settings.defaultExtensions).toBe(false);
      expect(() => facade.spawn(boot.pi, ctx, "custom", "must fail", { description: "bad" })).toThrow(path);
      await expect(boot.tools.get("Agent").execute("new-root", {
        subagent_type: "custom", description: "must fail", prompt: "must fail", run_in_background: true,
      }, undefined, undefined, ctx)).rejects.toThrow(path);
      expect(calls).toHaveLength(1);
      expect(facade.getRecord(first).status).toBe("running");
      expect(facade.getRecord(queued).status).toBe("queued");
      release();
      await facade.waitForAll();
      expect(facade.getRecord(first).status).toBe("completed");
      expect(facade.getRecord(queued).status).toBe("completed");
      expect(calls).toHaveLength(2);
      expect(calls[1].agentConfig?.systemPrompt).toBe("Original approved prompt");
      expect(calls[1].resolvedExtensions).toBe(true);
      expect(calls[1].runtimePolicy?.settings.defaultExtensions).toBeUndefined();
    } finally {
      release();
      await boot.lifecycle.get("session_shutdown")?.({ reason: "quit" }, ctx);
      env.restore();
    }
  });
});
