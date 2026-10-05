/** Real SDK/CLI fixtures. Only model responses, auth and terminal transport are injected. */
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  cleanupHeadlessProcesses, closeHeadlessSurface, createHeadlessSurface, getHeadlessProcessExit,
  pollForExit, readScreen, sendHeadlessEscape, sendLongCommand,
} from "pi-terminal-mux";
import { expect } from "vitest";
import { registerAgents } from "../../src/agent-types.js";
import { createManagedEmbeddedExecutionBackend } from "../../src/backends/embedded-managed.js";
import { inspectManagedSession } from "../../src/backends/managed-session.js";
import { createTerminalArtifacts } from "../../src/backends/terminal/artifacts.js";
import { createTerminalExecutionBackend } from "../../src/backends/terminal/backend.js";
import { openTerminalBridge } from "../../src/backends/terminal/bridge-server.js";
import type { TerminalDependencies } from "../../src/backends/terminal/types.js";
import type { ExecutionBackendKind } from "../../src/backends/session-reference.js";
import type { AgentConfig } from "../../src/types.js";
import type { ManagedWorkflowExecution, WorkflowHostContext } from "../../src/workflow/execution-contract.js";
import { createWorkflowExecutionProvider } from "../../src/workflow/execution-provider.js";
import { compileJsonSchema } from "../../src/workflow/json-schema.js";
import {
  TERMINAL_FAUX_JSON_PREFIX, TERMINAL_FAUX_MARKERS, TERMINAL_FAUX_MODEL_ID,
  TERMINAL_FAUX_PROVIDER, TERMINAL_FAUX_REQUEST_ACTIVE,
} from "../fixtures/terminal-faux-provider.js";
import { fauxModelBackend } from "./faux-model-backend.js";
import { registerFauxProvider } from "./pi-ai.js";

const PROVIDER_EXTENSION = fileURLToPath(new URL("../fixtures/terminal-faux-provider.ts", import.meta.url));
const TYPE = "workflow-offline";
export const SAVED_PROMPT = "WORKFLOW_ORIGINAL_SAVED_SYSTEM_PROMPT";
export const SCHEMA = {
  type: "object", properties: { file: { type: "string" }, line: { type: "integer", minimum: 1 } },
  required: ["file", "line"], additionalProperties: false,
};
export const payload = (name: string) => ({ file: `目录/${name}.ts`, line: 7 });
export const prompt = (name: string) => [
  TERMINAL_FAUX_MARKERS.structured,
  `WORKFLOW_${name}`, `${TERMINAL_FAUX_JSON_PREFIX}${JSON.stringify(payload(name))}`,
].join("\n");

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export async function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function processTransport() {
  const created: string[] = [];
  const closed: string[] = [];
  const exits: Promise<{ exitCode: number }>[] = [];
  const screens = new Map<string, string>();
  const remember = (surface: string) => {
    const output = readScreen(surface, 200);
    if (output.trim()) screens.set(surface, output);
  };
  const dependencies: TerminalDependencies = {
    transport: {
      createSurface(name) { const surface = createHeadlessSurface(name); created.push(surface); return surface; },
      sendCommand(surface, command, scriptPath, interpreter) {
        sendLongCommand(surface, command, { scriptPath, ...(interpreter ? { interpreter } : {}) });
        const exit = getHeadlessProcessExit(surface);
        if (exit) exits.push(exit);
      },
      sendEscape: sendHeadlessEscape,
      closeSurface(surface) { remember(surface); closed.push(surface); closeHeadlessSurface(surface); },
      async waitForExit(surface, signal, options) {
        try { return await pollForExit(surface, signal, { interval: 20, onTick: options.onTick }); }
        catch (error) { remember(surface); throw error; }
      },
    },
    artifacts: createTerminalArtifacts(), now: Date.now, delay: async () => {},
  };
  return {
    dependencies, created,
    report() {
      created.forEach(remember);
      return [...screens].map(([surface, output]) => `--- ${surface} ---\n${output}`).join("\n");
    },
    async assertRetired() {
      await Promise.all(exits.map(exit => within(exit, 5_000, "headless workflow Pi child did not retire")));
      expect(new Set(closed)).toEqual(new Set(created));
    },
  };
}

export function workflowRealBackend(kind: ExecutionBackendKind) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `workflow-${kind}-`)));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const faux = kind === "embedded" ? registerFauxProvider({
    provider: TYPE, models: [{ id: "offline", contextWindow: 200_000, reasoning: true }],
    tokenSize: { min: 8, max: 8 },
  }) : undefined;
  const model: Model<string> = faux?.getModel() ?? {
    id: TERMINAL_FAUX_MODEL_ID, name: "Terminal Faux Model", api: "terminal-faux-api",
    provider: TERMINAL_FAUX_PROVIDER, baseUrl: "faux://offline", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_192,
  };
  const alternateModel = { ...model, id: "offline-other-model" };
  const runtime = fauxModelBackend(model);
  runtime.modelRegistry.runtime = runtime.modelRuntime;
  runtime.modelRegistry.find = (provider: string, id: string) =>
    [model, alternateModel].find(candidate => candidate.provider === provider && candidate.id === id);
  runtime.modelRegistry.getAll = () => [model, alternateModel];
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", defaultTools: [],
    compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, enableInstallTelemetry: false,
  }));
  const ctx = {
    cwd, mode: "json", model, modelRegistry: runtime.modelRegistry,
    sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "Offline workflow observer",
  } as unknown as ExtensionContext;
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }) } as unknown as ExtensionAPI;
  const observer: WorkflowHostContext = {
    cwd, hasUI: false, ui: { notify: () => {} }, maxConcurrency: 1,
    sessionManager: { getSessionId: () => "observer", getSessionFile: () => undefined, getBranch: () => [] },
    waitForIdle: async () => {}, spawnChild: async () => { throw new Error("observer spawning must not be used"); },
  };
  const config: AgentConfig = {
    name: TYPE, displayName: "Workflow offline", description: "Offline workflow integration fixture",
    builtinToolNames: ["ls"], systemPrompt: SAVED_PROMPT, promptMode: "replace", maxTurns: 8,
    extensions: false, skills: false, isolated: true, inheritContext: false, persistSession: true,
  };
  const configure = (changes: Partial<AgentConfig> = {}) => registerAgents(new Map([[TYPE, { ...config, ...changes }]]));
  configure();
  const compiled = compileJsonSchema(SCHEMA);
  if (!compiled.ok) throw new Error(compiled.message);
  const transport = processTransport();
  const active = deferred<string>();
  const executions: ManagedWorkflowExecution[] = [];
  const backendDirs: string[] = [];
  const gates: Array<() => void> = [];
  let nextBridgeGate: (() => Promise<void>) | undefined;
  let nextModelGate: (() => Promise<void>) | undefined;
  let closed = false;

  const provider = createWorkflowExecutionProvider({
    pi, getContext: () => ctx, agentType: TYPE, maxConcurrency: 1, structuredOutput: compiled.compiled,
    inspectSession: file => inspectManagedSession(file, kind),
    createBackend({ sessionDir, run }) {
      backendDirs.push(sessionDir);
      expect(sessionDir).toBe(join(run.childSessionsDir, "managed"));
      if (kind === "embedded") return createManagedEmbeddedExecutionBackend({ agentDir, sessionDir });
      return createTerminalExecutionBackend({
        agentDir, sessionDir, artifactDir: join(root, "runs"), providerExtensions: [PROVIDER_EXTENSION],
        mode: "json", startupTimeoutMs: 60_000,
      }, {
        dependencies: transport.dependencies,
        async bridge(run, onFeedback) {
          const gate = nextBridgeGate;
          nextBridgeGate = undefined;
          // Hold only this test's admission boundary, never replace child feedback or completion.
          await gate?.();
          return openTerminalBridge(run, event => {
            onFeedback(event);
            if (event.type === "text" && event.fullText.includes(TERMINAL_FAUX_REQUEST_ACTIVE)) {
              active.resolve(run.session.sessionFile);
            }
          });
        },
      });
    },
  });
  return {
    root, cwd, provider, model, alternateModel, configure, backendDirs, transport, active: active.promise,
    modelKey: `${model.provider}/${model.id}`,
    alternateModelKey: `${alternateModel.provider}/${alternateModel.id}`,
    calls: () => faux ? faux.state.callCount : transport.created.length,
    execution(runId: string) {
      const childSessionsDir = join(root, "workflow-runs", runId, "children");
      const execution = provider.createHost(observer, { runId, childSessionsDir });
      executions.push(execution);
      return { ...execution, childSessionsDir };
    },
    scriptText(text: string) {
      if (!faux) return;
      const gate = nextModelGate;
      nextModelGate = undefined;
      faux.setResponses([async () => { await gate?.(); return fauxAssistantMessage(text); }]);
    },
    script(name: string) {
      if (!faux) return;
      const gate = nextModelGate;
      nextModelGate = undefined;
      faux.setResponses([
        async () => {
          await gate?.();
          return fauxAssistantMessage(fauxToolCall("StructuredOutput", payload(name)), { stopReason: "toolUse" });
        },
        fauxAssistantMessage(`WORKFLOW_${name}_DONE`),
      ]);
    },
    gateNextInvocation() {
      const entered = deferred<void>();
      const release = deferred<void>();
      gates.push(() => release.resolve());
      const gate = async () => { entered.resolve(); await release.promise; };
      if (faux) nextModelGate = gate;
      else nextBridgeGate = gate;
      return { entered: entered.promise, release: () => release.resolve() };
    },
    async cleanup() {
      if (closed) return;
      closed = true;
      gates.forEach(release => release());
      try {
        await Promise.all(executions.map(execution => execution.close()));
        await transport.assertRetired();
      } finally {
        cleanupHeadlessProcesses();
        faux?.unregister();
        registerAgents(new Map());
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
