/** Real SDK sessions and tool execution; only model responses/auth are faux. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import {
  getDefaultMaxTurns,
  getGraceTurns,
  resumeAgent,
  runAgent,
  setDefaultMaxTurns,
  setGraceTurns,
} from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createEmbeddedExecutionBackend } from "../src/backends/embedded-adapter.js";
import { i18n } from "../src/i18n.js";
import { createStructuredCapture, structuredFailure } from "../src/structured-output.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";
import { compileJsonSchema, type CompiledSchema } from "../src/workflow/json-schema.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const TYPE = "embedded-resume-policy";
const MODES = ["foreground", "background"] as const;
type Mode = typeof MODES[number];
const FATAL = "invalid request: offline provider rejected the prompt";
const text = (value: string) => fauxAssistantMessage(value);
const structured = (payload: Record<string, unknown>) =>
  fauxAssistantMessage(fauxToolCall("StructuredOutput", payload), { stopReason: "toolUse" });
const readTurn = () =>
  fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" });

function compile(schema: Record<string, unknown>): CompiledSchema {
  const result = compileJsonSchema(schema);
  if (!result.ok) throw new Error(result.message);
  return result.compiled;
}

const ANSWER_SCHEMA = compile({
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.type === "text" ? block.text : "").join("");
}

function userTexts(record: AgentRecord, start: number): string[] {
  return record.session!.messages.slice(start)
    .filter((message) => message.role === "user")
    .map((message) => messageText(message.content));
}

// No vi.mock: the SDK loader, prompt lifecycle, tool registry, native session,
// backend adapter and manager settlement paths all execute unchanged.
describe("embedded owned-session resume policy (offline real SDK)", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;
  let previousMaxTurns: number | undefined;
  let previousGrace: number;
  let faux: ReturnType<typeof registerFauxProvider>;
  let runtime: ReturnType<typeof fauxModelBackend>;
  let ctx: ExtensionContext;
  let pi: ExtensionAPI;
  let backend: ReturnType<typeof createEmbeddedExecutionBackend>;
  let manager: AgentManager;
  let config: AgentConfig;
  let pending: Promise<unknown>[];
  let releases: Array<() => void>;
  let rawSessions: AgentSession[];

  function configure(overrides: Partial<AgentConfig> = {}): void {
    config = {
      name: TYPE,
      description: "Offline owned-session policy fixture",
      builtinToolNames: ["read"],
      extensions: false,
      skills: false,
      systemPrompt: "Follow the supplied task using the available tools.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: true,
      persistSession: false,
      ...overrides,
    };
    registerAgents(new Map([[TYPE, config]]));
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.push(promise);
    return promise;
  }

  function script(...steps: FauxResponseStep[]) {
    const start = faux.state.callCount;
    const requests: TranscriptContext[] = [];
    const abortedAtDispatch: boolean[] = [];
    faux.setResponses(steps.map((step): FauxResponseStep => (context, options, state, model) => {
      requests.push(context);
      abortedAtDispatch.push(options?.signal?.aborted === true);
      return typeof step === "function" ? step(context, options, state, model) : step;
    }));
    return {
      requests,
      calls: () => faux.state.callCount - start,
      // The SDK can dispatch a final cancellation-only stream after aborting at
      // turn_end. Snapshot the signal now: later aborts must not erase real work.
      nonAbortedCalls: () => abortedAtDispatch.filter((aborted) => !aborted).length,
    };
  }

  async function spawn(options: {
    structuredOutput?: CompiledSchema;
    maxTurns?: number;
    signal?: AbortSignal;
  } = {}): Promise<AgentRecord> {
    return (await track(manager.spawnAndWait(pi, ctx, TYPE, "Initial task", {
      description: "policy fixture",
      isolated: true,
      ...options,
    }))).record;
  }

  async function resume(record: AgentRecord, mode: Mode, signal?: AbortSignal): Promise<AgentRecord> {
    const result = await track(manager.resume(record.id, "Next task", signal, {
      isBackground: mode === "background",
    }));
    expect(result).toBe(record);
    if (mode === "background") await track(record.promise!);
    return result!;
  }

  async function seed(): Promise<AgentRecord> {
    const run = script(structured({ answer: "seed" }), text("seed prose"));
    const record = await spawn({ structuredOutput: ANSWER_SCHEMA });
    expect(record.status).toBe("completed");
    expect(record.structuredJson).toBe('{"answer":"seed"}');
    expect(run.calls()).toBe(2);
    return record;
  }

  /** A deterministic in-flight provider request, released even on assertion failure. */
  function providerGate() {
    const entered = deferred<AbortSignal | undefined>();
    const release = deferred<void>();
    releases.push(() => release.resolve());
    const step: FauxResponseStep = async (_context, options) => {
      entered.resolve(options?.signal);
      await release.promise;
      return text("must not survive cancellation");
    };
    return {
      step,
      release: () => release.resolve(),
      async wait(running: Promise<unknown>) {
        return Promise.race([
          entered.promise,
          running.then(() => { throw new Error("Invocation settled before the provider gate"); }),
        ]);
      },
    };
  }

  beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousMaxTurns = getDefaultMaxTurns();
    previousGrace = getGraceTurns();
    root = mkdtempSync(join(tmpdir(), "embedded-resume-policy-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // runAgent creates the real SettingsManager from disk. Disable SDK recovery
    // so these tests count only the invocation executor's one schema retry.
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
    }));
    writeFileSync(join(cwd, "fixture.txt"), "Offline tool result.\n");
    setDefaultMaxTurns(undefined);
    setGraceTurns(5);
    configure();
    faux = registerFauxProvider({
      provider: "embedded-resume-faux",
      models: [{ id: "policy", contextWindow: 200_000 }],
      tokenSize: { min: 8, max: 8 },
    });
    runtime = fauxModelBackend(faux.getModel());
    // The extension-facing facade carries the parent's runtime into real child
    // createAgentSession, just as a real ExtensionContext does in Pi 0.87.1.
    runtime.modelRegistry.runtime = runtime.modelRuntime;
    ctx = {
      cwd,
      model: faux.getModel(),
      modelRegistry: runtime.modelRegistry,
      sessionManager: SessionManager.inMemory(cwd),
      getSystemPrompt: () => "Offline parent",
    } as ExtensionContext;
    pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
    backend = createEmbeddedExecutionBackend();
    manager = new AgentManager(undefined, 2, undefined, undefined, undefined, backend);
    pending = [];
    releases = [];
    rawSessions = [];
  });

  afterEach(async () => {
    manager.abortAll();
    for (const release of releases) release();
    for (const session of rawSessions) await session.abort();
    await Promise.allSettled(pending);
    await manager.dispose();
    for (const session of rawSessions) session.dispose();
    faux.unregister();
    registerAgents(new Map());
    setDefaultMaxTurns(previousMaxTurns);
    setGraceTurns(previousGrace);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  it.each(MODES)("retains StructuredOutput and resets capture/retry on every %s resume", async (mode) => {
    // Initial retry proves a clean resume must also clear structuredRetried.
    const initial = script(text("forgot the tool"), structured({ answer: "seed" }), text("seed prose"));
    const record = await spawn({ structuredOutput: ANSWER_SCHEMA });
    expect(record.status).toBe("completed");
    expect(record.structuredRetried).toBe(true);
    expect(initial.calls()).toBe(3);
    const session = record.session;

    const clean = script(structured({ answer: "fresh" }), text("fresh prose"));
    await resume(record, mode);
    expect(record.session).toBe(session);
    expect(record.status).toBe("completed");
    expect(record.structuredJson).toBe('{"answer":"fresh"}');
    expect(record.structuredRetried).not.toBe(true);
    expect(record.result).toBe("fresh prose");
    expect(clean.calls()).toBe(2);
    expect(getCurrentTools(clean.requests[0].messages).find((tool) => tool.name === "StructuredOutput")?.parameters)
      .toEqual(ANSWER_SCHEMA.schema);

    const start = record.session!.messages.length;
    const retried = script(text("forgot again"), structured({ answer: "retried" }), text("retry prose"));
    await resume(record, mode);
    expect(record.status).toBe("completed");
    expect(record.structuredJson).toBe('{"answer":"retried"}');
    expect(record.structuredRetried).toBe(true);
    expect(retried.calls()).toBe(3);
    // The extra prompt must wait for native prompt settlement, not race the SDK.
    expect(userTexts(record, start)).toHaveLength(2);

    // A missing required field cannot be repaired by the SDK's argument
    // coercion (a number supplied for a string could otherwise become valid).
    const invalid = script(
      structured({ unexpected: "first" }), text("invalid first attempt"),
      structured({ unexpected: "retry" }), text("invalid retry"),
    );
    await resume(record, mode);
    expect(record.status).toBe("error");
    expect(record.structuredJson).toBeUndefined();
    expect(record.structuredRetried).toBe(true);
    expect(record.error).toContain("StructuredOutput");
    expect(invalid.calls()).toBe(4); // exactly one retry, never a third prompt
    const invalidResults = record.session!.messages.filter((message) =>
      message.role === "toolResult" && message.toolName === "StructuredOutput" && message.isError,
    );
    expect(invalidResults).toHaveLength(2);

    // A prior schema/tool failure must not leak into a missing-call invocation,
    // even though the tool definition and its dispatch closure are retained.
    const missing = script(text("no call"), text("still no call"));
    await resume(record, mode);
    expect(record.status).toBe("error");
    expect(record.error).toBe(structuredFailure(createStructuredCapture()));
    expect(record.structuredJson).toBeUndefined();
    expect(record.structuredRetried).toBe(true);
    expect(missing.calls()).toBe(2);

    script(structured({ answer: "recovered" }), text("recovered prose"));
    await resume(record, mode === "foreground" ? "background" : "foreground");
    expect(record.status).toBe("completed");
    expect(record.error).toBeUndefined();
    expect(record.structuredJson).toBe('{"answer":"recovered"}');
    expect(record.structuredRetried).not.toBe(true);
  });

  it.each(MODES)("does not reuse a prior result or retry provider failures on %s resume", async (mode) => {
    const record = await seed();
    for (const failure of [
      { stopReason: "error" as const, errorMessage: FATAL, expected: FATAL },
      { stopReason: "length" as const, expected: i18n.t("invocation.outputLimit") },
      { stopReason: "aborted" as const, expected: undefined },
    ]) {
      const start = record.session!.messages.length;
      const run = script(
        fauxAssistantMessage([], failure),
        structured({ answer: "must not retry" }), text("unexpected retry"),
      );
      await resume(record, mode);
      expect(run.calls()).toBe(1);
      expect(userTexts(record, start)).toEqual(["Next task"]);
      expect(record.status).toBe(failure.stopReason === "aborted" ? "aborted" : "error");
      expect(record.error).toBe(failure.expected);
      expect(record.result).toBe("");
      expect(record.structuredJson).toBeUndefined();
      expect(record.structuredRetried).not.toBe(true);
    }
  });

  it("exposes fresh invocation metadata and keeps callbacks live through an owned-session retry", async () => {
    const record = await seed();
    const activity: string[] = [];
    const usage: unknown[] = [];
    const retry = script(text("retry required"), structured({ answer: "direct retry" }), text("direct finish"));
    const result = await track(backend.resume(record.session!, "Direct resume", {
      onToolActivity: (event) => activity.push(`${event.type}:${event.toolName}`),
      onAssistantUsage: (value) => usage.push(value),
    }));
    expect(result.text).toBe("direct finish");
    expect(result.structuredJson).toBe('{"answer":"direct retry"}');
    expect(result.structuredRetried).toBe(true);
    expect(result.aborted).not.toBe(true);
    expect(result.steered).not.toBe(true);
    expect(result.failure).toBeUndefined();
    expect(activity).toEqual(["start:StructuredOutput", "end:StructuredOutput"]);
    expect(usage).toHaveLength(3);
    expect(retry.calls()).toBe(3);

    const preAborted = new AbortController();
    preAborted.abort();
    const skipped = script(structured({ answer: "must not run" }));
    const cancelled = await track(backend.resume(record.session!, "Already cancelled", { signal: preAborted.signal }));
    expect(cancelled.aborted).toBe(true);
    expect(cancelled.text).toBe("");
    expect(cancelled.structuredJson).toBeUndefined();
    expect(cancelled.structuredRetried).not.toBe(true);
    expect(skipped.calls()).toBe(0);

    const gate = providerGate();
    const controller = new AbortController();
    script(text("retry again"), gate.step);
    const running = track(backend.resume(record.session!, "Cancel retry", { signal: controller.signal }));
    try {
      const providerSignal = await gate.wait(running);
      controller.abort();
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      gate.release();
    }
    const aborted = await running;
    expect(aborted.aborted).toBe(true);
    expect(aborted.structuredRetried).toBe(true);
    expect(aborted.structuredJson).toBeUndefined();
    // Invocation callbacks must have been detached; old subscribers must not
    // accumulate usage or receive tool events from subsequent prompts.
    expect(activity).toHaveLength(2);
    expect(usage).toHaveLength(3);
  });

  it("latches native session.abort() after a normal final turn without schema-retrying an owned resume", async () => {
    script(structured({ answer: "seed" }), text("seed prose"));
    const initial = await track(runAgent(ctx, TYPE, "Seed native session", {
      pi,
      isolated: true,
      structuredOutput: ANSWER_SCHEMA,
      onSessionCreated: (session) => { rawSessions.push(session); },
    }));
    expect(initial.structuredJson).toBe('{"answer":"seed"}');
    expect(initial.aborted).toBe(false);
    const { session } = initial;
    const start = session.messages.length;
    const run = script(
      text("normal final without structured output"),
      structured({ answer: "must not retry" }), text("unexpected retry"),
    );
    const turns: number[] = [];
    let nativeAbort: Promise<void> | undefined;
    // No caller AbortSignal: a native host/extension can stop the SDK directly
    // after the assistant has already completed with stopReason "stop".
    const result = await track(resumeAgent(session, "Abort natively at turn end", {
      onTurnEnd: (turn) => {
        turns.push(turn);
        // Do not await here: abort() waits for settlement of this same prompt.
        nativeAbort ??= track(session.abort());
      },
    }));
    expect(nativeAbort).toBeDefined();
    await nativeAbort;
    expect(turns).toEqual([1]);
    expect(session.messages.slice(start)
      .filter((message) => message.role === "assistant")
      .map((message) => message.stopReason)).toEqual(["stop"]);
    expect(result.aborted).toBe(true);
    expect(result.text).toBe("normal final without structured output");
    expect(result.structuredJson).toBeUndefined();
    expect(result.structuredRetried).not.toBe(true);
    expect(run.nonAbortedCalls()).toBe(1);
    expect(run.calls()).toBe(1);

    // The native abort latch belongs to this invocation, not the retained session.
    const recovery = script(structured({ answer: "after native abort" }), text("recovered"));
    const recovered = await track(resumeAgent(session, "Resume after native abort"));
    expect(recovered.aborted).not.toBe(true);
    expect(recovered.structuredJson).toBe('{"answer":"after native abort"}');
    expect(recovered.structuredRetried).not.toBe(true);
    expect(recovery.calls()).toBe(2);
  });

  it.each(["error", "length", "aborted"] as const)("does not schema-retry a fresh %s provider stop", async (stopReason) => {
    const run = script(
      fauxAssistantMessage([], { stopReason, ...(stopReason === "error" ? { errorMessage: FATAL } : {}) }),
      structured({ answer: "unexpected retry" }), text("unexpected finish"),
    );
    const record = await spawn({ structuredOutput: ANSWER_SCHEMA });
    expect(run.calls()).toBe(1);
    expect(record.status).toBe(stopReason === "aborted" ? "aborted" : "error");
    expect(record.structuredJson).toBeUndefined();
    expect(record.structuredRetried).not.toBe(true);
  });

  it.each(["explicit", "agent", "global"] as const)(
    "snapshots the resolved %s maxTurns and grace, resetting counters on foreground/background resumes",
    async (source) => {
      setDefaultMaxTurns(source === "global" ? 2 : 7);
      setGraceTurns(1);
      configure({ maxTurns: source === "agent" ? 2 : undefined });
      script(text("seed"));
      const record = await spawn(source === "explicit" ? { maxTurns: 2 } : {});
      expect(record.status).toBe("completed");
      const session = record.session;
      // Mutate both the original definition and the registered definition: an
      // owned session must not re-resolve policy from either one on resume.
      config.maxTurns = 9;
      configure({ maxTurns: 9 });
      setDefaultMaxTurns(9);
      setGraceTurns(8);

      for (const mode of MODES) {
        const start = record.session!.messages.length;
        const run = script(...Array.from({ length: 12 }, readTurn), text("unbounded fallback"));
        await resume(record, mode);
        expect(record.session).toBe(session);
        expect(record.status).toBe("aborted");
        expect(run.nonAbortedCalls()).toBe(3); // snapshotted 2 + 1, not live 9 + 8
        expect(record.session!.messages.slice(start)
          .map((message) => messageText(message.content))
          .filter((value) => value === i18n.t("terminalPolicy.wrapUp")))
          .toHaveLength(1);
      }

      script(text("short recovery"));
      await resume(record, "foreground");
      expect(record.status).toBe("completed");
      expect(record.result).toBe("short recovery");
    },
  );

  it.each(["default-unlimited", "explicit-zero"] as const)(
    "keeps %s unlimited after settings change",
    async (source) => {
      if (source === "explicit-zero") {
        setDefaultMaxTurns(1);
        configure({ maxTurns: 1 });
      }
      script(text("seed"));
      const record = await spawn(source === "explicit-zero" ? { maxTurns: 0 } : {});
      setDefaultMaxTurns(1);
      setGraceTurns(1);
      configure({ maxTurns: 1 });
      for (const mode of MODES) {
        const run = script(...Array.from({ length: 5 }, readTurn), text("unlimited finish"));
        await resume(record, mode);
        expect(record.status).toBe("completed");
        expect(run.calls()).toBe(6);
      }
    },
  );

  it.each(MODES)("reports soft-limit steering without a hard abort on %s resume", async (mode) => {
    setGraceTurns(2);
    script(text("seed"));
    const record = await spawn({ maxTurns: 2 });
    const run = script(readTurn(), readTurn(), text("wrapped up"));
    await resume(record, mode);
    expect(record.status).toBe("steered");
    expect(record.result).toBe("wrapped up");
    expect(run.calls()).toBe(3);
    script(text("new short invocation"));
    await resume(record, mode);
    expect(record.status).toBe("completed");
  });

  it.each(["fresh", ...MODES] as const)("counts the schema retry inside the same hard turn budget (%s)", async (operation) => {
    setDefaultMaxTurns(3);
    setGraceTurns(1);
    const record = operation === "fresh" ? undefined : await seed();
    const run = script(text("no structured output"), ...Array.from({ length: 10 }, readTurn));
    const result = record
      ? await resume(record, operation as Mode)
      : await spawn({ structuredOutput: ANSWER_SCHEMA });
    expect(result.status).toBe("aborted");
    expect(result.structuredRetried).toBe(true);
    expect(result.structuredJson).toBeUndefined();
    expect(run.nonAbortedCalls()).toBe(4); // one original turn + three retry turns
  });

  it.each(MODES)("forwards active cancellation, including during the schema retry (%s)", async (mode) => {
    const record = await seed();
    for (const inRetry of [false, true]) {
      const gate = providerGate();
      const controller = new AbortController();
      const run = script(...(inRetry ? [text("retry needed")] : []), gate.step);
      const running = track(resume(record, mode, controller.signal));
      try {
        const providerSignal = await gate.wait(running);
        expect(record.status).toBe("running");
        expect(record.structuredJson).toBeUndefined();
        controller.abort();
        // Assert cancellation reaches the provider, not merely the manager's
        // status field, while the real native prompt is still unresolved.
        expect(providerSignal?.aborted).toBe(true);
      } finally {
        gate.release();
      }
      await running;
      expect(record.status).toBe("stopped");
      expect(record.structuredJson).toBeUndefined();
      expect(Boolean(record.structuredRetried)).toBe(inRetry);
      expect(run.calls()).toBe(inRetry ? 2 : 1);
      expect(record.result).not.toContain("seed");
      expect(record.result).not.toContain("must not survive cancellation");

      script(structured({ answer: "after abort" }), text("clean recovery"));
      await resume(record, mode);
      expect(record.status).toBe("completed");
      expect(record.structuredJson).toBe('{"answer":"after abort"}');
      expect(record.structuredRetried).not.toBe(true);
    }
  });

  it.each(["fresh", ...MODES] as const)("pre-aborted %s invocations make no model call", async (operation) => {
    const record = operation === "fresh" ? undefined : await seed();
    const controller = new AbortController();
    controller.abort();
    const run = script(structured({ answer: "must not run" }), text("must not run"));
    const result = record
      ? await resume(record, operation as Mode, controller.signal)
      : await spawn({ structuredOutput: ANSWER_SCHEMA, signal: controller.signal });
    expect(result.status).toBe("stopped");
    // A fresh launch may be stopped by the manager before it has any result.
    expect(result.result ?? "").toBe("");
    expect(result.structuredJson).toBeUndefined();
    expect(result.structuredRetried).not.toBe(true);
    expect(run.calls()).toBe(0);
  });

  it("keeps schemas and resolved budgets separate for two owned native sessions", async () => {
    setDefaultMaxTurns(3);
    setGraceTurns(1);
    const first = await seed();
    setDefaultMaxTurns(5);
    const countSchema = compile({
      type: "object", properties: { count: { type: "integer" } },
      required: ["count"], additionalProperties: false,
    });
    script(structured({ count: 1 }), text("second seed"));
    const second = await spawn({ structuredOutput: countSchema });
    expect(second.status).toBe("completed");
    expect(second.session).not.toBe(first.session);
    setDefaultMaxTurns(9);
    setGraceTurns(7);

    script(structured({ answer: "first only" }), text("first complete"));
    await resume(first, "foreground");
    expect(first.structuredJson).toBe('{"answer":"first only"}');
    script(structured({ count: 2 }), text("second complete"));
    await resume(second, "background");
    expect(second.structuredJson).toBe('{"count":2}');
    expect(first.structuredJson).toBe('{"answer":"first only"}');

    for (const [record, expectedCalls] of [[first, 4], [second, 6]] as const) {
      const run = script(...Array.from({ length: 12 }, readTurn));
      await resume(record, "foreground");
      expect(record.status).toBe("aborted");
      expect(record.structuredJson).toBeUndefined();
      expect(record.structuredRetried).not.toBe(true);
      expect(run.nonAbortedCalls()).toBe(expectedCalls);
    }
  });

  it("preserves the raw unowned-session resume contract instead of adopting current global policy", async () => {
    await seed(); // a different owned native session must not lend this one its schema
    const loader = new DefaultResourceLoader({
      cwd, agentDir, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => "Raw session fixture",
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd, agentDir, model: faux.getModel(), modelRuntime: runtime.modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
      tools: ["read"],
    });
    rawSessions.push(session);
    await session.bindExtensions({});
    script(text("raw seed"));
    await track(session.prompt("Seed raw session"));
    setDefaultMaxTurns(1);
    setGraceTurns(1);
    const run = script(readTurn(), readTurn(), readTurn(), text("raw continuation"));
    const result = await track(resumeAgent(session, "Continue raw session"));
    expect(result).toEqual({ text: "raw continuation", failure: undefined });
    expect(run.calls()).toBe(4);
    expect(session.getActiveToolNames()).not.toContain("StructuredOutput");

    script(fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }));
    await expect(track(resumeAgent(session, "Raw failure")))
      .resolves.toEqual({ text: "", failure: FATAL });
  });
});
