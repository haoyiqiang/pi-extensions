import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentSystemPrompt, getCurrentTools, type Model } from "@earendil-works/pi-ai";
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
import { registerAgents } from "../src/agent-types.js";
import type { ExecutionSession } from "../src/backends/session.js";
import { createTerminalArtifacts } from "../src/backends/terminal/artifacts.js";
import { createStandardTerminalExecutionBackend } from "../src/backends/terminal/backend.js";
import { readStandardSessionSnapshot } from "../src/backends/terminal/standard-session.js";
import type { TerminalDependencies } from "../src/backends/terminal/types.js";
import { i18n } from "../src/i18n.js";
import type { AgentConfig } from "../src/types.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import {
  TERMINAL_FAUX_JSON_PREFIX,
  TERMINAL_FAUX_MARKERS,
  TERMINAL_FAUX_MODEL_ID,
  TERMINAL_FAUX_PROVIDER,
  TERMINAL_FAUX_REQUEST_ACTIVE,
} from "./fixtures/terminal-faux-provider.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const TYPE = "terminal-standard-fixture";
const CONFIG_CWD = fileURLToPath(new URL("./fixtures", import.meta.url));
const PROVIDER_EXTENSION = fileURLToPath(new URL("./fixtures/terminal-faux-provider.ts", import.meta.url));
const TERMINAL_FAUX_API = "terminal-faux-api";
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
        sendLongCommand(surface, command, { scriptPath, ...(interpreter ? { interpreter } : {}) });
        const exit = getHeadlessProcessExit(surface);
        if (exit) exits.set(surface, exit);
      },
      sendEscape: sendHeadlessEscape,
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
      return [...screens.entries()].map(([surface, output]) => `--- ${surface} ---\n${output}`).join("\n");
    },
    async assertRetired() {
      const bounded = (exit: Promise<{ exitCode: number }>) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("headless standard child did not retire")), 5_000);
        timer.unref();
        exit.then(
          () => { clearTimeout(timer); resolve(); },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });
      await Promise.all([...exits.values()].map(bounded));
      expect(new Set(closed)).toEqual(new Set(created));
    },
  };
}

interface Fixture {
  root: string;
  workCwd: string;
  agentDir: string;
  sessionDir: string;
  artifactDir: string;
  model: Model<typeof TERMINAL_FAUX_API>;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  harness: ProcessHarness;
  manager: AgentManager;
}

const managers: AgentManager[] = [];
const harnesses: ProcessHarness[] = [];
const roots: string[] = [];

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: TYPE,
    description: "Standard terminal SDK child fixture",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "STANDARD_CAPTURED_PROMPT",
    promptMode: "replace",
    persistSession: true,
    ...overrides,
  };
}

function createFixture(maxConcurrent = 10, providerToolProbe = false): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-terminal-standard-"));
  roots.push(root);
  const workCwd = join(root, "work");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const artifactDir = join(root, "runs");
  mkdirSync(workCwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(workCwd, "work-only.txt"), "working directory marker\n");
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: TERMINAL_FAUX_PROVIDER,
    defaultModel: TERMINAL_FAUX_MODEL_ID,
    enabledModels: [`${TERMINAL_FAUX_PROVIDER}/${TERMINAL_FAUX_MODEL_ID}`],
    defaultThinkingLevel: "high",
    defaultTools: [],
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    enableInstallTelemetry: false,
  }, null, 2)}\n`);

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
    find: (provider: string, modelId: string) => provider === model.provider && modelId === model.id ? model : undefined,
    getAll: () => [model],
  };
  const ctx = {
    cwd: CONFIG_CWD,
    model,
    modelRegistry,
    getSystemPrompt: () => "PARENT_PROMPT_MUST_NOT_REPLACE_CAPTURED_AGENT",
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
  const pi = {
    exec: vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: "false\n", stderr: "", killed: false };
      }
      return { code: 1, stdout: "", stderr: "unsupported test command", killed: false };
    }),
  } as unknown as ExtensionAPI;
  const harness = createProcessHarness();
  harnesses.push(harness);
  const providerExtension = providerToolProbe ? join(root, "provider-with-tools.ts") : PROVIDER_EXTENSION;
  if (providerToolProbe) writeFileSync(providerExtension, `
import provider from ${JSON.stringify(PROVIDER_EXTENSION)};
import { Type } from "@sinclair/typebox";
export default function(pi) {
  provider(pi);
  for (const name of ["read", "provider_write"]) pi.registerTool({
    name, label: name, description: "PROVIDER_ONLY_TOOL_MUST_NOT_LEAK",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "provider tool" }], details: {} }),
  });
}
`);
  const backend = createStandardTerminalExecutionBackend({
    agentDir,
    sessionDir,
    artifactDir,
    providerExtensions: [providerExtension],
    mode: "json",
    startupTimeoutMs: 120_000,
  }, { dependencies: harness.dependencies });
  const manager = new AgentManager(undefined, maxConcurrent, undefined, undefined, undefined, backend);
  managers.push(manager);
  return { root, workCwd, agentDir, sessionDir, artifactDir, model, ctx, pi, harness, manager };
}

function activeToolNames(session: ExecutionSession): string[] {
  return getCurrentTools(session.messages).map((tool) => tool.name).sort();
}

function transcriptText(session: ExecutionSession): string {
  return session.messages.flatMap((message) => {
    if (typeof message.content === "string") return [message.content];
    return (message.content ?? []).map((block) => block.text ?? "");
  }).join("\n");
}

function sessionFiles(sessionDir: string): string[] {
  return existsSync(sessionDir) ? readdirSync(sessionDir).sort() : [];
}

beforeEach(() => {
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  registerAgents(new Map());
});

afterEach(async () => {
  for (const manager of managers) manager.abortAll();
  await Promise.all(managers.map((manager) => manager.waitForAll()));
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(harnesses.splice(0).map((harness) => harness.assertRetired()));
  cleanupHeadlessProcesses();
  registerAgents(new Map());
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = originalOffline;
  if (originalSkipVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
  else process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
});

describe.skipIf(process.platform === "win32")("standard terminal backend with a real SDK child", () => {
  it("loads provider models without exposing their tools or overriding builtin read", async () => {
    const f = createFixture(10, true);
    const { record } = await f.manager.spawnAndWait(f.pi, f.ctx, TYPE, "Inspect allowed tools.", {
      description: "provider-only tools", agentConfig: baseAgent(),
      cwd: f.workCwd, configCwd: CONFIG_CWD, requiredTools: ["read"],
    });
    expect(record.status, record.error ?? f.harness.screenReport()).toBe("completed");
    const tools = getCurrentTools(record.session!.messages);
    expect(tools.map(tool => tool.name)).toEqual(["read"]);
    expect(tools[0]!.description).not.toContain("PROVIDER_ONLY_TOOL_MUST_NOT_LEAK");
  });

  it("keeps configCwd separate from work cwd and applies the captured read-only extension/skill scope", async () => {
    const f = createFixture();
    const captured = baseAgent({
      builtinToolNames: ["read"],
      extensions: ["./ext-alpha.mjs", "./ext-beta.mjs"],
      excludeExtensions: ["ext-beta.mjs"],
      extSelectors: ["ext:ext-alpha.mjs/alpha_read"],
      skills: ["probe-skill"],
      systemPrompt: "STANDARD_CAPTURED_PROMPT",
    });
    registerAgents(new Map([[TYPE, baseAgent({
      builtinToolNames: ["write"],
      extensions: false,
      skills: false,
      systemPrompt: "REPLACEMENT_REGISTRY_PROMPT_MUST_NOT_WIN",
    })]]));

    const { record } = await f.manager.spawnAndWait(f.pi, f.ctx, TYPE, "Inspect the scoped resources.", {
      description: "standard resource scope",
      agentConfig: captured,
      cwd: f.workCwd,
      configCwd: CONFIG_CWD,
      thinkingLevel: "off",
      requiredTools: ["read", "alpha_read"],
      isolated: false,
    });

    expect(record.status, `${record.error ?? ""}\n${f.harness.screenReport()}`).toBe("completed");
    const session = record.session!;
    const tools = activeToolNames(session);
    expect(tools).toEqual(expect.arrayContaining(["read", "alpha_read"]));
    for (const absent of ["write", "alpha_write", "beta_tool"]) expect(tools).not.toContain(absent);
    expect(record.result).toContain("alpha_read");
    expect(record.result).not.toContain("alpha_write");
    expect(record.result).not.toContain("beta_tool");
    const systemPrompt = getCurrentSystemPrompt(session.messages);
    expect(systemPrompt).toContain("STANDARD_CAPTURED_PROMPT");
    expect(systemPrompt).toContain("SKILL_BODY_MARKER");
    expect(systemPrompt).not.toContain("REPLACEMENT_REGISTRY_PROMPT_MUST_NOT_WIN");
    expect(session.thinkingLevel).toBe("off");
    expect(session.reference.sessionFile).toBeTypeOf("string");
    const recordFile = `${session.reference.sessionFile}.pi-subagents-terminal.json`;
    const saved = JSON.parse(readFileSync(recordFile, "utf8"));
    expect(saved.policy).toMatchObject({ cwd: f.workCwd, configCwd: CONFIG_CWD, thinkingLevel: "off" });
    expect(saved.policy.agent).toMatchObject({ builtinToolNames: ["read"], skills: ["probe-skill"] });
  });

  it("rejects an interactive request on the headless transport instead of degrading to one-shot", async () => {
    const f = createFixture();
    const { record } = await f.manager.spawnAndWait(f.pi, f.ctx, TYPE, "Must remain interactive.", {
      description: "headless interactive refusal",
      agentConfig: baseAgent({ persistSession: false, interactive: true, autoExit: false }),
      cwd: f.workCwd,
      configCwd: CONFIG_CWD,
      interactive: true,
      autoExit: false,
    });

    expect(record.status).toBe("error");
    expect(record.error).toBe(i18n.t("terminalBackend.unsupported", { feature: "interactive/headless" }));
    expect(record.result).toBe("");
    expect(record.session?.messages).toEqual([]);
    expect(f.harness.created).toHaveLength(1);
    expect(f.harness.closed).toEqual(f.harness.created);
  });

  it("hides and deletes backend-owned ephemeral session artifacts on release", async () => {
    const f = createFixture();
    const { id, record } = await f.manager.spawnAndWait(f.pi, f.ctx, TYPE, "Ephemeral run.", {
      description: "ephemeral cleanup",
      agentConfig: baseAgent({ persistSession: false }),
      cwd: f.workCwd,
      configCwd: CONFIG_CWD,
      thinkingLevel: "off",
    });

    expect(record.status, record.error ?? f.harness.screenReport()).toBe("completed");
    expect(record.session?.reference).not.toHaveProperty("sessionFile");
    expect(record.sessionFile).toBeUndefined();
    expect(sessionFiles(f.sessionDir)).toEqual(expect.arrayContaining([
      expect.stringMatching(/\.jsonl$/),
      expect.stringMatching(/\.jsonl\.pi-subagents-terminal\.json$/),
    ]));

    await f.manager.release(id);
    expect(sessionFiles(f.sessionDir)).toEqual([]);
  });

  it("resumes the owned session with a raw branch and observes a live file without mutating it", async () => {
    const f = createFixture();
    const ready = deferred<ExecutionSession>();
    const active = deferred<void>();
    const id = f.manager.spawn(f.pi, f.ctx, TYPE, `${TERMINAL_FAUX_MARKERS.slow} LIVE_OBSERVATION_FIRST_TURN`, {
      description: "live observation and owned resume",
      agentConfig: baseAgent({ persistSession: true }),
      cwd: f.workCwd,
      configCwd: CONFIG_CWD,
      thinkingLevel: "off",
      isBackground: true,
      onSessionCreated: ready.resolve,
      onTextDelta: (_delta, fullText) => {
        if (fullText.includes(TERMINAL_FAUX_REQUEST_ACTIVE)) active.resolve();
      },
    });
    await f.manager.awaitStartup(id);
    const record = f.manager.getRecord(id)!;
    const session = await within(Promise.race([
      ready.promise,
      record.promise!.then(() => { throw new Error(`standard child ended before ready\n${f.harness.screenReport()}`); }),
    ]), 120_000, "standard child did not become ready");
    await within(Promise.race([
      active.promise,
      record.promise!.then(() => { throw new Error(`standard child ended before live observation\n${f.harness.screenReport()}`); }),
    ]), 120_000, "standard child did not start its slow model request");

    const file = session.reference.sessionFile!;
    const before = readFileSync(file);
    const observed = readStandardSessionSnapshot(file, f.workCwd);
    void session.messages;
    void session.getBranch?.();
    void session.getSessionStats();
    const after = readFileSync(file);
    expect(after).toEqual(before);
    expect(observed.branch.length).toBeGreaterThan(0);

    await expect(within(f.manager.control(id, { action: "cancel" }), 10_000, "standard child did not retire after cancel")).resolves.toBe(true);
    await record.promise;
    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
    expect(record.session).toBe(session);
    const reference = session.reference;
    const branchBefore = session.getBranch?.() ?? [];

    const resumed = await f.manager.resume(id, "OWNED_RESUME_SECOND_TURN", undefined, {
      requiredTools: ["read"],
    });
    expect(resumed).toBe(record);
    expect(record.status, record.error ?? f.harness.screenReport()).toBe("completed");
    expect(record.session).toBe(session);
    expect(session.reference).toBe(reference);
    expect(transcriptText(session)).toContain("LIVE_OBSERVATION_FIRST_TURN");
    expect(transcriptText(session)).toContain("OWNED_RESUME_SECOND_TURN");
    const branchAfter = session.getBranch?.() ?? [];
    expect(branchAfter.length).toBeGreaterThan(branchBefore.length);
    expect(branchAfter.some((entry) => entry.type === "message" && entry.message?.role === "user")).toBe(true);
    expect(branchAfter.some((entry) => entry.type === "message" && entry.message?.role === "assistant")).toBe(true);
  });

  it("readmits structured output under an extension selector and enforces the standard turn budget", async () => {
    const f = createFixture();
    const compiled = compileJsonSchema({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    });
    if (!compiled.ok) throw new Error(compiled.message);
    const turns: number[] = [];
    const prompt = `${TERMINAL_FAUX_MARKERS.structured}\n${TERMINAL_FAUX_JSON_PREFIX}${JSON.stringify({ answer: "scalar-value" })}`;
    const { record } = await f.manager.spawnAndWait(f.pi, f.ctx, TYPE, prompt, {
      description: "structured output and turn budget",
      agentConfig: baseAgent({
        builtinToolNames: [],
        extensions: ["./ext-alpha.mjs"],
        extSelectors: ["ext:ext-alpha.mjs/alpha_read"],
        persistSession: false,
      }),
      cwd: f.workCwd,
      configCwd: CONFIG_CWD,
      thinkingLevel: "off",
      maxTurns: 1,
      structuredOutput: compiled.compiled,
      requiredTools: ["StructuredOutput", "alpha_read"],
      onTurnEnd: (count) => turns.push(count),
    });

    expect(record.status, `${record.error ?? ""}\n${f.harness.screenReport()}`).toBe("steered");
    expect(JSON.parse(record.structuredJson!)).toEqual({ answer: "scalar-value" });
    expect(record.structuredRetried).not.toBe(true);
    expect(turns).toEqual([1, 2]);
    expect(activeToolNames(record.session!)).toEqual(expect.arrayContaining(["StructuredOutput", "alpha_read"]));
  });
});
