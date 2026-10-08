import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent, resumeAgent } from "../src/backends/embedded.js";
import type { ExecutionSession } from "../src/backends/session.js";
import type { AgentExecutionBackend } from "../src/backends/types.js";
import { assertRequiredTools, snapshotRequiredTools } from "../src/backends/tool-requirements.js";
import { i18n } from "../src/i18n.js";
import { ctx as makeContext, hermeticDir, type Hermetic } from "./helpers/boot-extension.js";

const invalid = () => i18n.t("toolRequirements.invalid", { maxTools: 256, maxNameLength: 256 });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("invocation tool requirement snapshots", () => {
  it("keeps absence unconstrained, permits empty arrays, and freezes a deduplicated exact-name copy", () => {
    expect(snapshotRequiredTools(undefined)).toBeUndefined();
    const empty = snapshotRequiredTools([]);
    expect(empty).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
    const supplied = ["read", "StructuredOutput", "read", "Read", "mcp/tool-name.v1"];
    const captured = snapshotRequiredTools(supplied);
    supplied.fill("write");
    expect(captured).toEqual(["read", "StructuredOutput", "Read", "mcp/tool-name.v1"]);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(supplied)).toBe(false);
  });

  it.each([
    null, false, 1, "read", {}, new Set(["read"]), [null], [1], [""], [" read"], ["read "],
    ["read write"], ["read\twrite"], ["read\nwrite"], ["read\u00a0write"], ["read\u0000"],
    ["read\u007f"], ["read\u0085"], ["read\u200b"], ["read\u202e"], ["*"], ["read*"], ["read?"],
    ["[read]"], ["{read,write}"], new Array(1), Array(257).fill("read"), ["a".repeat(257)],
  ].map(value => ({ value })))("rejects malformed/unbounded input $value", ({ value }) => {
    expect(() => snapshotRequiredTools(value)).toThrow(invalid());
    expect(() => assertRequiredTools(value as readonly string[], ["read"])).toThrow(invalid());
  });

  it("bounds inputs before deduplication and does not use a caller-supplied array iterator", () => {
    expect(snapshotRequiredTools(Array(256).fill("read"))).toEqual(["read"]);
    expect(snapshotRequiredTools(["a".repeat(256)])).toEqual(["a".repeat(256)]);
    const values = ["read"];
    values[Symbol.iterator] = () => { throw new Error("untrusted iterator"); };
    expect(snapshotRequiredTools(values)).toEqual(["read"]);
  });

  it("checks membership without changing availability or granting missing/unknown tools", () => {
    const available = new Set(["read", "StructuredOutput"]);
    expect(() => assertRequiredTools(["read", "read"], available.values())).not.toThrow();
    expect(() => assertRequiredTools(["Read", "not-registered", "Read"], available)).toThrow(
      i18n.t("toolRequirements.missing", { tools: "Read, not-registered" }),
    );
    expect([...available]).toEqual(["read", "StructuredOutput"]);
    // No constraint must not inspect, much less validate, an agent's defaults.
    const unused = { [Symbol.iterator](): Iterator<string> { throw new Error("must not resolve defaults"); } };
    expect(() => assertRequiredTools(undefined, unused)).not.toThrow();
    expect(() => assertRequiredTools([], unused)).not.toThrow();
  });
});

const managers: AgentManager[] = [];
const environments: Hermetic[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  for (const environment of environments.splice(0).reverse()) environment.restore();
});
const pi = {} as ExtensionAPI;
const ctx = {} as ExtensionContext;
function managerFixture(onStart?: () => void) {
  const hold = deferred();
  let serial = 0;
  const session = (): ExecutionSession => ({
    reference: { backend: "embedded", sessionId: `fake-${++serial}` }, messages: [],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: null } }),
    subscribe: () => () => {},
  });
  const backend: AgentExecutionBackend = {
    kind: "embedded",
    run: vi.fn(async (_ctx, _type, prompt, options) => {
      if (prompt === "hold") await hold.promise;
      const handle = session();
      options.onSessionCreated?.(handle);
      return { responseText: prompt, session: handle, aborted: false, steered: false };
    }),
    resume: vi.fn(async (_session, prompt) => ({ text: prompt })),
    steer: vi.fn(async () => {}), shutdown: vi.fn(async () => {}),
  };
  const manager = new AgentManager(undefined, 1, onStart, undefined, undefined, backend);
  manager.setMaxConcurrentForeground(1);
  managers.push(manager);
  return { manager, backend, hold };
}

describe("manager invocation requirement forwarding", () => {
  let ctx: ExtensionContext;
  beforeEach(() => {
    const environment = hermeticDir({ settings: { defaultExtensions: false, schedulingEnabled: false } });
    environments.push(environment);
    ctx = makeContext({ cwd: environment.dir, isProjectTrusted: () => true });
  });

  it.each([false, true])("snapshots before a queued spawn (background: %s)", async isBackground => {
    const { manager, backend, hold } = managerFixture();
    const holder = isBackground
      ? manager.spawn(pi, ctx, "test", "hold", { description: "hold", isBackground })
      : manager.spawnAndWait(pi, ctx, "test", "hold", { description: "hold" });
    const requiredTools = ["read", "read"];
    const options = { description: "queued", requiredTools, isBackground };
    const queued = isBackground
      ? manager.spawn(pi, ctx, "test", "queued", options)
      : manager.spawnAndWait(pi, ctx, "test", "queued", options);
    expect(manager.listAgents().find(record => record.description === "queued")?.status).toBe("queued");
    expect(backend.run).toHaveBeenCalledTimes(1);
    requiredTools.push("write");
    options.requiredTools = ["bash"];
    hold.resolve();
    await holder;
    await manager.waitForAll();
    await queued;
    const forwarded = vi.mocked(backend.run).mock.calls[1][3].requiredTools;
    expect(forwarded).toEqual(["read"]);
    expect(Object.isFrozen(forwarded)).toBe(true);
  });

  it("snapshots before synchronous start callbacks without changing immediate launch timing", async () => {
    const requiredTools = ["read"];
    const { manager, backend } = managerFixture(() => { requiredTools[0] = "write"; });
    const running = manager.spawnAndWait(pi, ctx, "test", "immediate", { description: "immediate", requiredTools });
    expect(backend.run).toHaveBeenCalledOnce();
    expect(vi.mocked(backend.run).mock.calls[0][3].requiredTools).toEqual(["read"]);
    await running;
  });

  it.each(["foreground", "background", "queued background"] as const)("forwards an invocation-local frozen snapshot on %s resume", async mode => {
    const { manager, backend, hold } = managerFixture();
    const seeded = await manager.spawnAndWait(pi, ctx, "test", "seed", { description: "seed", requiredTools: ["read"] });
    if (mode === "queued background") manager.spawn(pi, ctx, "test", "hold", { description: "hold", isBackground: true });
    const requiredTools = ["StructuredOutput", "StructuredOutput"];
    const options = { requiredTools, isBackground: mode !== "foreground" };
    const resumed = manager.resume(seeded.id, "continued", undefined, options);
    if (mode === "queued background") {
      expect(seeded.record.status).toBe("queued");
      expect(backend.resume).not.toHaveBeenCalled();
    }
    requiredTools[0] = "write";
    options.requiredTools = ["bash"];
    hold.resolve();
    await resumed;
    await manager.waitForAll();
    const forwarded = vi.mocked(backend.resume).mock.calls[0][2]?.requiredTools;
    expect(forwarded).toEqual(["StructuredOutput"]);
    expect(Object.isFrozen(forwarded)).toBe(true);
    await manager.resume(seeded.id, "no constraint");
    expect(vi.mocked(backend.resume).mock.calls[1][2]?.requiredTools).toBeUndefined();
  });

  it("rejects malformed requirements before allocating records or modifying an existing resume", async () => {
    const { manager, backend } = managerFixture();
    expect(() => manager.spawn(pi, ctx, "test", "invalid", { description: "invalid", requiredTools: ["*"] })).toThrow(invalid());
    expect(manager.listAgents()).toEqual([]);
    expect(backend.run).not.toHaveBeenCalled();
    const { id, record } = await manager.spawnAndWait(pi, ctx, "test", "seed", { description: "seed" });
    const before = { ...record };
    await expect(manager.resume(id, "invalid", undefined, { isBackground: true, requiredTools: [" "] })).rejects.toThrow(invalid());
    expect(record).toEqual(before);
    expect(backend.resume).not.toHaveBeenCalled();
  });
});

describe("legacy embedded requirement rejection", () => {
  it("rejects nonempty requirements before environment discovery, native access or capture", async () => {
    const exec = vi.fn();
    await expect(runAgent(ctx, "test", "task", { pi: { exec } as unknown as ExtensionAPI, requiredTools: ["read"] }))
      .rejects.toThrow(i18n.t("toolRequirements.unsupportedLegacy"));
    const access = vi.fn(() => { throw new Error("native session must not be accessed"); });
    const native = new Proxy({}, { get: access }) as Parameters<typeof resumeAgent>[0];
    await expect(resumeAgent(native, "next", { requiredTools: ["read"] })).rejects.toThrow(i18n.t("toolRequirements.unsupportedLegacy"));
    expect(exec).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
  });

  it("validates malformed requirements instead of silently dropping them", async () => {
    await expect(runAgent(ctx, "test", "task", { pi, requiredTools: ["*"] })).rejects.toThrow(invalid());
    await expect(resumeAgent({} as Parameters<typeof resumeAgent>[0], "task", { requiredTools: ["*"] })).rejects.toThrow(invalid());
  });
});
