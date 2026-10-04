import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentTools, type Message, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  cleanupHeadlessProcesses,
  closeHeadlessSurface,
  createHeadlessSurface,
  getHeadlessProcessExit,
  pollForExit,
  readScreen,
  sendHeadlessEscape,
  sendLongCommand,
} from "pi-terminal-mux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, registerAgents } from "../src/agent-types.js";
import {
  getDefaultMaxTurns,
  getGraceTurns,
  setDefaultMaxTurns,
  setGraceTurns,
} from "../src/backends/embedded.js";
import { createTerminalArtifacts } from "../src/backends/terminal/artifacts.js";
import { createTerminalExecutionBackend } from "../src/backends/terminal/backend.js";
import type { TerminalDependencies } from "../src/backends/terminal/types.js";
import type { ExecutionSession } from "../src/backends/session.js";
import { i18n } from "../src/i18n.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import {
  TERMINAL_FAUX_JSON_PREFIX,
  TERMINAL_FAUX_MARKERS,
  TERMINAL_FAUX_MODEL_ID,
  TERMINAL_FAUX_PROVIDER,
  TERMINAL_FAUX_REQUEST_ACTIVE,
} from "./fixtures/terminal-faux-provider.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PROVIDER_EXTENSION = fileURLToPath(new URL("./fixtures/terminal-faux-provider.ts", import.meta.url));
const TERMINAL_FAUX_API = "terminal-faux-api";
const originalOffline = process.env.PI_OFFLINE;
const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalMaxTurns = getDefaultMaxTurns();
const originalGraceTurns = getGraceTurns();

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
    line: { type: "integer", minimum: 1 },
    metadata: {
      type: "object",
      properties: { labels: { type: "array", items: { type: "string" } } },
      required: ["labels"],
      additionalProperties: false,
    },
  },
  required: ["file", "line"],
  additionalProperties: false,
};

function outputSchema() {
  const result = compileJsonSchema(OUTPUT_SCHEMA);
  if (!result.ok) throw new Error(result.message);
  return result.compiled;
}

function scriptedPrompt(marker: string, value?: Record<string, unknown>): string {
  return value === undefined ? marker : `${marker}\n${TERMINAL_FAUX_JSON_PREFIX}${JSON.stringify(value)}`;
}

async function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface ProcessHarness {
  dependencies: TerminalDependencies;
  created: string[];
  closed: string[];
  screenReport(): string;
  assertRetired(): Promise<void>;
}

function createProcessHarness(): ProcessHarness {
  const created: string[] = [];
  const closed: string[] = [];
  const exits = new Map<string, Promise<{ exitCode: number }>>();
  const screens = new Map<string, string>();

  const rememberScreen = (surface: string) => {
    const output = readScreen(surface, 200);
    if (output.trim()) screens.set(surface, output);
  };

  const dependencies: TerminalDependencies = {
    transport: {
      createSurface(name) {
        const surface = createHeadlessSurface(name);
        created.push(surface);
        return surface;
      },
      sendCommand(surface, command, scriptPath, interpreter) {
        sendLongCommand(surface, command, {
          scriptPath,
          ...(interpreter ? { interpreter } : {}),
        });
        const exit = getHeadlessProcessExit(surface);
        if (exit) exits.set(surface, exit);
      },
      sendEscape: (surface) => sendHeadlessEscape(surface),
      closeSurface(surface) {
        rememberScreen(surface);
        closed.push(surface);
        closeHeadlessSurface(surface);
      },
      async waitForExit(surface, signal, options) {
        try {
          return await pollForExit(surface, signal, { interval: 20, onTick: options.onTick });
        } catch (error) {
          rememberScreen(surface);
          throw error;
        }
      },
    },
    artifacts: createTerminalArtifacts(),
    now: Date.now,
    delay: async () => {},
  };

  return {
    dependencies,
    created,
    closed,
    screenReport() {
      for (const surface of created) rememberScreen(surface);
      return [...screens.entries()]
        .map(([surface, output]) => `--- ${surface} ---\n${output}`)
        .join("\n");
    },
    async assertRetired() {
      const withTimeout = (exit: Promise<{ exitCode: number }>) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("headless Pi child did not retire")), 5_000);
        timer.unref();
        exit.then(
          () => { clearTimeout(timer); resolve(); },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });
      await Promise.all([...exits.values()].map(withTimeout));
      expect(new Set(closed)).toEqual(new Set(created));
    },
  };
}

interface TestEnvironment {
  root: string;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  artifactDir: string;
  model: Model<typeof TERMINAL_FAUX_API>;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
}

function createTestEnvironment(): TestEnvironment {
  const root = mkdtempSync(join(tmpdir(), "pi-terminal-backend-process-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const artifactDir = join(root, "runs");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({
      defaultProvider: TERMINAL_FAUX_PROVIDER,
      defaultModel: TERMINAL_FAUX_MODEL_ID,
      enabledModels: [`${TERMINAL_FAUX_PROVIDER}/${TERMINAL_FAUX_MODEL_ID}`],
      defaultThinkingLevel: "off",
      defaultTools: [],
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
      enableInstallTelemetry: false,
    }, null, 2)}\n`,
  );

  const model: Model<typeof TERMINAL_FAUX_API> = {
    id: TERMINAL_FAUX_MODEL_ID,
    name: "Terminal Faux Model",
    api: TERMINAL_FAUX_API,
    provider: TERMINAL_FAUX_PROVIDER,
    baseUrl: "faux://offline",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  const modelRegistry = {
    find: (provider: string, modelId: string) =>
      provider === model.provider && modelId === model.id ? model : undefined,
    getAll: () => [model],
  };
  const ctx = {
    cwd,
    model,
    modelRegistry,
    getSystemPrompt: () => "Parent system prompt for the terminal backend process smoke test.",
  } as unknown as ExtensionContext;
  const pi = {
    exec: vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: "false\n", stderr: "", killed: false };
      }
      return { code: 1, stdout: "", stderr: "unsupported test command", killed: false };
    }),
  } as unknown as ExtensionAPI;

  return { root, cwd, agentDir, sessionDir, artifactDir, model, ctx, pi };
}

function transcriptText(session: ExecutionSession): string {
  return session.messages
    .flatMap((message) => {
      if (typeof message.content === "string") return [message.content];
      return (message.content ?? []).map((block) => block.text ?? "");
    })
    .join("\n");
}

function sessionEntries(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function persistedEntries(session: ExecutionSession): Array<Record<string, unknown>> {
  const path = session.reference.sessionFile;
  if (!path) throw new Error("terminal session has no persisted file");
  return sessionEntries(path);
}

function persistedMessages(session: ExecutionSession): Message[] {
  return persistedEntries(session)
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as Message);
}

function completedAssistants(session: ExecutionSession) {
  // Pi may persist an empty error/abort when the next request in a tool loop
  // observes the cancelled signal; that is not another completed model turn.
  return persistedMessages(session).filter((message) => message.role === "assistant")
    .filter((message) => message.stopReason !== "aborted" && message.stopReason !== "error");
}

function toolResults(session: ExecutionSession, name: string) {
  return persistedMessages(session).filter((message) => message.role === "toolResult")
    .filter((message) => message.toolName === name);
}

function customMessageTurns(session: ExecutionSession): number[] {
  let completedTurns = 0;
  return persistedEntries(session).flatMap((entry) => {
    if (entry.type === "message" && (entry.message as Message).role === "assistant") completedTurns++;
    return entry.type === "custom_message" ? [completedTurns] : [];
  });
}

const managers: AgentManager[] = [];
const harnesses: ProcessHarness[] = [];
const roots: string[] = [];

beforeEach(() => {
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  setDefaultMaxTurns(undefined);
  setGraceTurns(originalGraceTurns);
  registerAgents(new Map());
});

afterEach(async () => {
  for (const manager of managers) manager.abortAll();
  await Promise.all(managers.map((manager) => manager.waitForAll()));
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(harnesses.splice(0).map((harness) => harness.assertRetired()));
  cleanupHeadlessProcesses();
  setDefaultMaxTurns(originalMaxTurns);
  setGraceTurns(originalGraceTurns);
  registerAgents(new Map());
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = originalOffline;
  if (originalSkipVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
  else process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
});

function createFixture() {
  const environment = createTestEnvironment();
  roots.push(environment.root);
  const harness = createProcessHarness();
  harnesses.push(harness);
  const backend = createTerminalExecutionBackend({
    sessionDir: environment.sessionDir,
    artifactDir: environment.artifactDir,
    agentDir: environment.agentDir,
    providerExtensions: [PROVIDER_EXTENSION],
    mode: "json",
    startupTimeoutMs: 30_000,
  }, { dependencies: harness.dependencies });
  const manager = new AgentManager(undefined, undefined, undefined, undefined, undefined, backend);
  managers.push(manager);
  return { ...environment, harness, backend, manager };
}

describe.skipIf(process.platform === "win32")("terminal backend real Pi child process", () => {
  it("runs and resumes through AgentManager with one stable native-free session view", async () => {
    const { ctx, pi, manager, harness } = createFixture();
    const firstPrompt = [
      "FIRST_SOURCE_BEGIN",
      "source-section-".repeat(320),
      "FIRST_SOURCE_TAIL_MARKER",
    ].join("\n");
    const secondPrompt = "SECOND_SOURCE_TAIL_MARKER: continue from the complete first source.";
    const ready = deferred<ExecutionSession>();
    const deltas: string[] = [];
    const usage: Array<{ input: number; output: number; cacheWrite: number }> = [];
    const turns: number[] = [];

    const id = manager.spawn(pi, ctx, "general-purpose", firstPrompt, {
      description: "real terminal process smoke",
      isBackground: true,
      isolated: true,
      onTextDelta: (delta) => deltas.push(delta),
      onAssistantUsage: (entry) => usage.push(entry),
      onTurnEnd: (count) => turns.push(count),
      onSessionCreated: (session) => ready.resolve(session),
    });
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    const readyOrEnd = await Promise.race([
      ready.promise.then((session) => ({ kind: "ready" as const, session })),
      record.promise!.then(() => ({ kind: "ended" as const })),
    ]);
    if (readyOrEnd.kind === "ended") {
      throw new Error(`Pi child ended before ready.\n${harness.screenReport()}`);
    }
    const session = readyOrEnd.session;
    const reference = session.reference;
    if (!reference.sessionFile) throw new Error("terminal session did not expose a persisted session file");
    const sessionFile = reference.sessionFile;
    const observedEvents: string[] = [];
    const unsubscribe = session.subscribe((event) => observedEvents.push(event.type));

    expect(session.messages, harness.screenReport()).toEqual([]);
    expect(deltas, "ready must precede model streaming").toEqual([]);
    for (const key of ["prompt", "abort", "dispose", "steer", "sessionManager", "agent", "modelRuntime"]) {
      expect(session).not.toHaveProperty(key);
    }

    await record.promise;
    expect(record.status, harness.screenReport()).toBe("completed");
    expect(record.session).toBe(session);
    expect(record.sessionFile).toBe(sessionFile);
    expect(record.result).toContain("terminal-faux turn 1");
    expect(record.result).toContain("FIRST_SOURCE_TAIL_MARKER");
    expect(record.result).toContain(`tools=${JSON.stringify([...BUILTIN_TOOL_NAMES].sort())}`);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(record.result);
    expect(turns).toEqual([1]);
    expect(usage).toHaveLength(1);
    expect(usage[0].input).toBeGreaterThan(0);
    expect(usage[0].output).toBeGreaterThan(0);
    expect(usage[0].cacheWrite).toBeGreaterThan(0);
    expect([usage[0].input, usage[0].output, usage[0].cacheWrite].every(Number.isFinite)).toBe(true);
    expect(record.lifetimeUsage.input).toBe(usage[0].input);
    expect(record.lifetimeUsage.output).toBe(usage[0].output);
    expect(session.model).toMatchObject({ provider: TERMINAL_FAUX_PROVIDER, id: TERMINAL_FAUX_MODEL_ID });
    expect(session.thinkingLevel).toBe("off");
    expect(observedEvents).toContain("turn_end");
    expect(transcriptText(session)).toContain(firstPrompt);

    expect(existsSync(sessionFile)).toBe(true);
    let entries = sessionEntries(sessionFile);
    expect(entries[0]).toMatchObject({ type: "session", version: 3, id: reference.sessionId });

    const resumed = await manager.resume(id, secondPrompt, undefined, {
      onAssistantUsage: (entry) => usage.push(entry),
    });
    expect(resumed).toBe(record);
    expect(record.status, harness.screenReport()).toBe("completed");
    expect(record.session).toBe(session);
    expect(session.reference).toBe(reference);
    expect(record.result).toContain("terminal-faux turn 2");
    expect(record.result).toContain("FIRST_SOURCE_TAIL_MARKER");
    expect(record.result).toContain("SECOND_SOURCE_TAIL_MARKER");
    expect(record.result).toContain("assistant_history=[\"terminal-faux turn 1");
    expect(record.result).toContain(JSON.stringify(firstPrompt).slice(1, -1));
    expect(transcriptText(session)).toContain(firstPrompt);
    expect(transcriptText(session)).toContain(secondPrompt);
    expect(usage).toHaveLength(2);
    expect(usage.every((entry) => [entry.input, entry.output, entry.cacheWrite].every(Number.isFinite))).toBe(true);
    expect(harness.created).toHaveLength(2);
    expect(new Set(harness.created).size).toBe(2);
    expect(observedEvents.filter((event) => event === "turn_end")).toHaveLength(2);

    entries = sessionEntries(sessionFile);
    expect(entries[0]).toMatchObject({ id: reference.sessionId });
    expect(entries.filter((entry) => entry.type === "message").length).toBeGreaterThanOrEqual(4);
    unsubscribe();
    await harness.assertRetired();
  });

  it("delivers steering queued before the child is ready without racing the initial prompt", async () => {
    const { ctx, pi, manager } = createFixture();
    const id = manager.spawn(pi, ctx, "general-purpose", "initial queued task", {
      description: "queued steer", isolated: true, isBackground: true,
    });
    expect(manager.steer(id, "QUEUED_BEFORE_CHILD_READY")).toBe(true);
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.status).toBe("completed");
    expect(transcriptText(record.session!)).toContain("QUEUED_BEFORE_CHILD_READY");
    expect(record.result).toContain("QUEUED_BEFORE_CHILD_READY");
  });

  it("registers StructuredOutput beside the builtin allowlist and round-trips the exact JSON schema", async () => {
    const { ctx, pi, manager, harness } = createFixture();
    const expected = { file: "目录/result.ts", line: 7, metadata: { labels: ["offline", "校验"] } };
    const builtinTools = ["ls"];
    registerAgents(new Map([["general-purpose", { ...getAgentConfig("general-purpose")!, builtinToolNames: builtinTools }]]));
    const structuredOutput = outputSchema();
    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose",
      scriptedPrompt(TERMINAL_FAUX_MARKERS.structured, expected), {
        description: "structured CLI round-trip", isolated: true, structuredOutput,
      });

    expect(record.status, `${record.error ?? ""}\n${harness.screenReport()}`).toBe("completed");
    expect(record.structuredRetried).not.toBe(true);
    expect(JSON.parse(record.structuredJson!)).toEqual(expected);
    expect(structuredOutput.check(JSON.parse(record.structuredJson!))).toBe(true);
    const messages = persistedMessages(record.session!);
    const tools = getCurrentTools(messages);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...builtinTools, "StructuredOutput"].sort());
    expect(tools.find((tool) => tool.name === "StructuredOutput")?.parameters).toEqual(OUTPUT_SCHEMA);
    expect(toolResults(record.session!, "StructuredOutput")).toMatchObject([{ isError: false }]);
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(customMessageTurns(record.session!)).toEqual([]);
  });

  it.each([false, true])("keeps the schema on resume and resets capture/retry state (background=%s)", async (isBackground) => {
    const { ctx, pi, manager, harness } = createFixture();
    const first = { file: "first.ts", line: 1 };
    const second = { file: "second.ts", line: 9 };
    const { id, record } = await manager.spawnAndWait(pi, ctx, "general-purpose",
      scriptedPrompt(TERMINAL_FAUX_MARKERS.recover, first), {
        description: "structured retry and resume", isolated: true, structuredOutput: outputSchema(),
      });
    expect(record.status, record.error ?? harness.screenReport()).toBe("completed");
    expect(JSON.parse(record.structuredJson!)).toEqual(first);
    expect(record.structuredRetried).toBe(true);
    const session = record.session!;
    const reference = session.reference;
    expect(customMessageTurns(session)).toEqual([1]);
    expect(persistedMessages(session).filter((message) => message.role === "user")).toHaveLength(1);
    expect(persistedMessages(session).filter((message) => message.role === "assistant")).toHaveLength(3);

    const resumed = await manager.resume(id, scriptedPrompt(TERMINAL_FAUX_MARKERS.structured, second), undefined, { isBackground });
    if (isBackground) {
      expect(record.structuredJson).toBeUndefined();
      expect(record.structuredRetried).toBeUndefined();
      await record.promise;
    }
    expect(resumed).toBe(record);
    expect(record.status, record.error ?? harness.screenReport()).toBe("completed");
    expect(record.session).toBe(session);
    expect(session.reference).toBe(reference);
    expect(JSON.parse(record.structuredJson!)).toEqual(second);
    expect(record.structuredRetried).not.toBe(true);
    expect(customMessageTurns(session)).toEqual([1]);

    await manager.resume(id, TERMINAL_FAUX_MARKERS.missing, undefined, { isBackground });
    if (isBackground) await record.promise;
    expect(record.status, harness.screenReport()).toBe("error");
    expect(record.error).toContain("StructuredOutput");
    expect(record.error).not.toBe(record.result);
    expect(record.structuredJson).toBeUndefined();
    expect(record.structuredRetried).toBe(true);
    // Exactly one continuation per invocation, persisted as custom_message,
    // never a fabricated user turn and never a replay of the prior capture.
    expect(customMessageTurns(session)).toEqual([1, 6]);
    expect(persistedMessages(session).filter((message) => message.role === "user")).toHaveLength(3);
    expect(persistedMessages(session).filter((message) => message.role === "assistant")).toHaveLength(7);
    expect(toolResults(session, "StructuredOutput")).toHaveLength(2);
    expect(harness.created).toHaveLength(3);
  });

  it.each([
    { marker: TERMINAL_FAUX_MARKERS.invalidThenValid, corrected: true },
    { marker: TERMINAL_FAUX_MARKERS.invalid, corrected: false },
  ])("validates real StructuredOutput arguments instead of accepting prose (corrected=$corrected)", async ({ marker, corrected }) => {
    const { ctx, pi, manager, harness } = createFixture();
    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", marker, {
      description: "schema validation in child", isolated: true, structuredOutput: outputSchema(),
    });
    expect(record.session, `${record.error ?? ""}\n${harness.screenReport()}`).toBeDefined();
    expect(record.status, record.error ?? harness.screenReport()).toBe(corrected ? "completed" : "error");
    const results = toolResults(record.session!, "StructuredOutput");
    expect(results.map((message) => message.isError)).toEqual([true, !corrected]);
    expect(results[0].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("file") })]));
    if (corrected) {
      expect(JSON.parse(record.structuredJson!)).toEqual({ file: "fixture.ts", line: 3 });
      expect(record.structuredRetried).not.toBe(true);
      expect(customMessageTurns(record.session!)).toEqual([]);
    } else {
      expect(record.structuredJson).toBeUndefined();
      expect(record.structuredRetried).toBe(true);
      expect(record.error).toContain("StructuredOutput");
      expect(customMessageTurns(record.session!)).toEqual([2]);
    }
    expect(persistedMessages(record.session!).filter((message) => message.role === "user")).toHaveLength(1);
    expect(persistedMessages(record.session!).filter((message) => message.role === "assistant")).toHaveLength(corrected ? 3 : 4);
  });

  it.each([false, true])("soft-wraps, resets counters on resume, and hard-aborts a sticky budget (background=%s)", async (isBackground) => {
    const { ctx, pi, manager, harness } = createFixture();
    setGraceTurns(3);
    const turns: number[] = [];
    const { id, record } = await manager.spawnAndWait(pi, ctx, "general-purpose", TERMINAL_FAUX_MARKERS.wrapUp, {
      description: "turn budget across CLI invocations", isolated: true, maxTurns: 2,
      onTurnEnd: (count) => turns.push(count),
    });
    expect(record.status, record.error ?? harness.screenReport()).toBe("steered");
    expect(turns).toEqual([1, 2, 3]);
    const session = record.session!;
    expect(customMessageTurns(session)).toEqual([2]);
    expect(toolResults(session, "ls").map((message) => message.isError)).toEqual([false, false]);

    // Both resolved max and grace belong to the owned session, not whichever
    // global policy happens to be configured when a fresh child resumes it.
    setDefaultMaxTurns(20);
    setGraceTurns(1);
    await manager.resume(id, TERMINAL_FAUX_MARKERS.wrapUp, undefined, { isBackground });
    if (isBackground) await record.promise;
    expect(record.status, record.error ?? harness.screenReport()).toBe("steered");
    expect(record.session).toBe(session);
    expect(customMessageTurns(session)).toEqual([2, 5]);
    expect(persistedMessages(session).filter((message) => message.role === "assistant")).toHaveLength(6);

    await manager.resume(id, TERMINAL_FAUX_MARKERS.endless, undefined, { isBackground });
    if (isBackground) await record.promise;
    expect(record.status, record.error ?? harness.screenReport()).toBe("aborted");
    expect(customMessageTurns(session)).toEqual([2, 5, 8]);
    expect(completedAssistants(session)).toHaveLength(11);
    expect(persistedMessages(session).filter((message) => message.role === "user")).toHaveLength(3);
    expect(toolResults(session, "ls")).toHaveLength(9);
    expect(toolResults(session, "ls").every((message) => !message.isError)).toBe(true);
    expect(harness.created).toHaveLength(3);
  });

  it.each([
    { source: "global", global: 2, agent: undefined, explicit: undefined },
    { source: "agent", global: 1, agent: 2, explicit: undefined },
    { source: "explicit", global: 1, agent: 1, explicit: 2 },
    { source: "explicit unlimited", global: 1, agent: 1, explicit: 0 },
  ])("resolves the $source maxTurns policy before launching the child", async ({ global, agent, explicit }) => {
    const { ctx, pi, manager, harness } = createFixture();
    setDefaultMaxTurns(global);
    setGraceTurns(2);
    registerAgents(new Map([["general-purpose", { ...getAgentConfig("general-purpose")!, maxTurns: agent }]]));
    const unlimited = explicit === 0;
    const turns: number[] = [];
    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose",
      unlimited ? TERMINAL_FAUX_MARKERS.structured : TERMINAL_FAUX_MARKERS.wrapUp, {
        description: "resolved turn policy", isolated: true, maxTurns: explicit,
        ...(unlimited ? { structuredOutput: outputSchema() } : {}),
        onTurnEnd: (count) => turns.push(count),
      });
    expect(record.status, record.error ?? harness.screenReport()).toBe(unlimited ? "completed" : "steered");
    expect(turns).toEqual(unlimited ? [1, 2] : [1, 2, 3]);
    expect(customMessageTurns(record.session!)).toEqual(unlimited ? [] : [2]);
    if (unlimited) expect(JSON.parse(record.structuredJson!)).toEqual({ file: "fixture.ts", line: 3 });
  });

  it.each([
    { marker: TERMINAL_FAUX_MARKERS.retryEndless, maxTurns: 2, expectedTurns: [1, 2, 3], customTurns: [1, 2], retried: true },
    { marker: TERMINAL_FAUX_MARKERS.missing, maxTurns: 1, expectedTurns: [1, 2], customTurns: [1], retried: false },
  ])("does not let structured recovery exceed maxTurns + grace (retry=$retried)", async ({ marker, maxTurns, expectedTurns, customTurns, retried }) => {
    const { ctx, pi, manager, harness } = createFixture();
    setGraceTurns(1);
    const turns: number[] = [];
    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", marker, {
      description: "structured recovery shares the turn budget", isolated: true,
      structuredOutput: outputSchema(), maxTurns, onTurnEnd: (count) => turns.push(count),
    });
    expect(record.status, record.error ?? harness.screenReport()).toBe("aborted");
    expect(record.structuredJson).toBeUndefined();
    expect(record.structuredRetried === true).toBe(retried);
    const interruptedMessages = persistedMessages(record.session!)
      .filter((message) => message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error"));
    expect(interruptedMessages.length).toBeLessThanOrEqual(1);
    // SDK abort bookkeeping may emit one final turn_end, but no completed
    // model work (including structured recovery) may exceed the budget.
    expect(turns.slice(0, expectedTurns.length)).toEqual(expectedTurns);
    expect(turns.length).toBeLessThanOrEqual(expectedTurns.length + interruptedMessages.length);
    expect(customMessageTurns(record.session!)).toEqual(customTurns);
    expect(completedAssistants(record.session!)).toHaveLength(expectedTurns.length);
    expect(persistedMessages(record.session!).filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("cancels a slow child, retires its CLI process, and quarantines the session", async () => {
    const { ctx, pi, manager, backend, harness } = createFixture();
    const ready = deferred<ExecutionSession>();
    const deltas: string[] = [];
    const active = deferred<void>();
    const id = manager.spawn(pi, ctx, "general-purpose", `${TERMINAL_FAUX_MARKERS.slow} wait until cancelled`, {
      description: "cancel real terminal process",
      isBackground: true,
      isolated: true,
      onTextDelta: (delta, fullText) => {
        deltas.push(delta);
        if (fullText.includes(TERMINAL_FAUX_REQUEST_ACTIVE)) active.resolve();
      },
      onSessionCreated: (session) => ready.resolve(session),
    });
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    const readyOrEnd = await Promise.race([
      ready.promise.then((session) => ({ kind: "ready" as const, session })),
      record.promise!.then(() => ({ kind: "ended" as const })),
    ]);
    if (readyOrEnd.kind === "ended") {
      throw new Error(`Slow Pi child ended before cancellation.\n${harness.screenReport()}`);
    }
    const session = readyOrEnd.session;
    expect(session.messages).toEqual([]);
    expect(deltas).toEqual([]);
    await within(Promise.race([
      active.promise,
      record.promise!.then(() => { throw new Error(`Slow request ended before streaming.\n${harness.screenReport()}`); }),
    ]), 10_000, "slow Pi child did not start its model request");
    expect(deltas.join("")).toBe(TERMINAL_FAUX_REQUEST_ACTIVE);
    expect(record.status).toBe("running");
    expect(manager.abort(id)).toBe(true);
    await within(record.promise!, 5_000, "cancellation did not interrupt the active model request");

    expect(record.status).toBe("stopped");
    expect(record.session).toBe(session);
    expect(harness.created).toHaveLength(1);
    await expect(backend.resume(session, "resume must be rejected")).rejects.toThrow(
      i18n.t("terminalBackend.quarantined"),
    );
    expect(harness.created).toHaveLength(1);
    await harness.assertRetired();
  });
});
