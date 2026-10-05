import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager, type AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { createManagedEmbeddedExecutionBackend } from "../src/backends/embedded-managed.js";
import type { ExecutionSession } from "../src/backends/session.js";
import { i18n } from "../src/i18n.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("managed embedded invocation admission (offline real SDK)", () => {
  let root: string;
  let ctx: ExtensionContext;
  let pi: ExtensionAPI;
  let backend: ReturnType<typeof createManagedEmbeddedExecutionBackend>;
  let faux: ReturnType<typeof registerFauxProvider>;
  let native: AgentSession;
  let handles: ExecutionSession[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "managed-admission-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    registerAgents(new Map([["admission", { name: "admission", description: "Offline fixture", builtinToolNames: [],
      extensions: false, skills: false, systemPrompt: "Follow the task.", promptMode: "replace", persistSession: true }]]));
    faux = registerFauxProvider({ provider: "managed-admission", models: [{ id: "model", contextWindow: 200_000 }] });
    const runtime = fauxModelBackend(faux.getModel());
    runtime.modelRegistry.runtime = runtime.modelRuntime;
    ctx = { cwd: root, model: faux.getModel(), modelRegistry: runtime.modelRegistry,
      sessionManager: SessionManager.inMemory(root), getSystemPrompt: () => "Parent" } as ExtensionContext;
    pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
    backend = createManagedEmbeddedExecutionBackend({ agentDir, sessionDir: join(root, "sessions") }, {
      createSession: async options => { const result = await createAgentSession(options); native = result.session; return result; },
    });
    handles = [];
  });
  afterEach(async () => {
    await Promise.allSettled(handles.map(handle => backend.shutdown(handle)));
    faux.unregister();
    registerAgents(new Map());
    rmSync(root, { recursive: true, force: true });
  });
  async function seed() {
    faux.setResponses([fauxAssistantMessage("seed")]);
    const result = await backend.run(ctx, "admission", "Seed", { pi, isolated: true, onSessionCreated: handle => handles.push(handle) });
    expect(result.responseText).toBe("seed");
    return result.session;
  }
  function record(handle: ExecutionSession) {
    return JSON.parse(readFileSync(`${handle.reference.sessionFile}.pi-subagents.json`, "utf8"));
  }

  it("reserves persistence before immediate steering after resume", async () => {
    const handle = await seed();
    let observed = "";
    faux.setResponses([(context) => { observed = JSON.stringify(context); return fauxAssistantMessage("continued"); }]);
    const running = backend.resume(handle, "Next task");
    await backend.steer(handle, "Literal @not-a-file");
    expect((await running).text).toBe("continued");
    expect(observed).toContain("Literal @not-a-file");
    expect(record(handle).state).toBe("ready");
    await backend.shutdown(handle);
    const restored = await backend.reattach!(handle.reference as any, { ctx });
    handles.push(restored);
    expect(restored.reference).toEqual(handle.reference);
  });

  it("refuses reentrant steering at native settlement rather than appending undelivered control", async () => {
    const handle = await seed();
    let delivery: Promise<void> | undefined;
    const off = native.subscribe(event => {
      if (event.type === "agent_settled") {
        delivery = backend.steer(handle, "TOO LATE");
        void delivery.catch(() => {});
      }
    });
    faux.setResponses([fauxAssistantMessage("done")]);
    await backend.resume(handle, "Next task");
    off();
    expect(delivery).toBeDefined();
    await expect(delivery).rejects.toThrow(i18n.t("invocation.notRunning"));
    expect(JSON.stringify(handle.messages)).not.toContain("TOO LATE");
    expect(record(handle).state).toBe("ready");
  });

  it("keeps schema and validator binding captured before asynchronous environment preparation", async () => {
    const entered = deferred();
    const gate = deferred();
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
    const supplied: { schema: Record<string, unknown>; check: () => true | string } = { schema, check: () => true };
    const slowPi = { exec: async () => { entered.resolve(); await gate.promise; return { code: 1, stdout: "", stderr: "" }; } } as unknown as ExtensionAPI;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("StructuredOutput", { answer: "captured" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const running = backend.run(ctx, "admission", "Schema task", { pi: slowPi, isolated: true, structuredOutput: supplied,
      onSessionCreated: handle => handles.push(handle) });
    void running.catch(() => {});
    try {
      await Promise.race([entered.promise, running.then(() => { throw new Error("No environment gate"); })]);
      supplied.schema = { type: "object", properties: { changed: { type: "number" } }, required: ["changed"] };
      supplied.check = () => "must not use the replaced validator";
    } finally { gate.resolve(); }
    const result = await running;
    expect(result.structuredJson).toBe('{"answer":"captured"}');
    expect(record(result.session).policy.structuredSchema).toEqual(schema);
    expect(record(result.session).state).toBe("ready");
  });

  it("checkpoints a cancellation between reservation and deferred prompt without poisoning resume", async () => {
    const handle = await seed();
    const calls = faux.state.callCount;
    const controller = new AbortController();
    const running = backend.resume(handle, "Never start", { signal: controller.signal });
    controller.abort();
    expect(await running).toMatchObject({ aborted: true, text: "" });
    expect(faux.state.callCount).toBe(calls);
    expect(record(handle).state).toBe("ready");
    faux.setResponses([fauxAssistantMessage("next")]);
    expect((await backend.resume(handle, "Actual next invocation")).text).toBe("next");
  });
});
