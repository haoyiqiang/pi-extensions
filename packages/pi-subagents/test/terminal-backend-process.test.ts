import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
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
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { createTerminalArtifacts } from "../src/backends/terminal/artifacts.js";
import { createTerminalExecutionBackend } from "../src/backends/terminal/backend.js";
import type { TerminalDependencies } from "../src/backends/terminal/types.js";
import type { ExecutionSession } from "../src/backends/session.js";
import { i18n } from "../src/i18n.js";
import {
  TERMINAL_FAUX_MODEL_ID,
  TERMINAL_FAUX_PROVIDER,
} from "./fixtures/terminal-faux-provider.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PROVIDER_EXTENSION = fileURLToPath(new URL("./fixtures/terminal-faux-provider.ts", import.meta.url));
const TERMINAL_FAUX_API = "terminal-faux-api";
const SLOW_MARKER = "[[terminal-faux:slow]]";
const originalOffline = process.env.PI_OFFLINE;
const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;

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

const managers: AgentManager[] = [];
const harnesses: ProcessHarness[] = [];
const roots: string[] = [];

beforeEach(() => {
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
});

afterEach(async () => {
  for (const manager of managers) manager.abortAll();
  await Promise.all(managers.map((manager) => manager.waitForAll()));
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(harnesses.splice(0).map((harness) => harness.assertRetired()));
  cleanupHeadlessProcesses();
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

  it("cancels a slow child, retires its CLI process, and quarantines the session", async () => {
    const { ctx, pi, manager, backend, harness } = createFixture();
    const ready = deferred<ExecutionSession>();
    const deltas: string[] = [];
    const id = manager.spawn(pi, ctx, "general-purpose", `${SLOW_MARKER} wait until cancelled`, {
      description: "cancel real terminal process",
      isBackground: true,
      isolated: true,
      onTextDelta: (delta) => deltas.push(delta),
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
    expect(manager.abort(id)).toBe(true);
    await record.promise;

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
