/** Real standard-workflow acceptance fixture: only model responses and terminal transport are faux. */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FauxResponseStep,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { cleanupHeadlessProcesses } from "pi-terminal-mux";
import {
  registerWorkflowExecutionHost,
  type WorkflowExecutionProvider,
} from "../../../pi-workflow/src/startup.ts";
import { registerAgents } from "../../src/agent-types.js";
import type { ExecutionBackendKind } from "../../src/backends/session-reference.js";
import { createWorkflowAgentRuntime } from "../../src/workflow/agent-runtime.js";
import {
  SUBAGENT_EXECUTOR_ID,
  WORKFLOW_EXECUTOR_DISCOVERY,
  type WorkflowExecutorExecution,
  type WorkflowExecutorIdentity,
  type WorkflowExecutorOffer,
  type WorkflowExecutorRequest,
  type WorkflowExecutorSettings,
} from "../../src/workflow/executor-protocol.js";
import { registerWorkflowExecutor } from "../../src/workflow/pi-executor.js";
import { fauxModelBackend } from "./faux-model-backend.js";
import { registerFauxProvider } from "./pi-ai.js";

const TERMINAL_PROVIDER_EXTENSION = fileURLToPath(
  new URL("../fixtures/terminal-faux-provider.ts", import.meta.url),
);
const TERMINAL_PROVIDER = "terminal-faux";
const TERMINAL_MODEL_ID = "terminal-faux-1";
const TERMINAL_API = "terminal-faux-api";

export const STANDARD_SKILL = "acceptance-skill";
export const STANDARD_SKILL_MARKER = "STANDARD_WORKFLOW_SKILL_BODY_MARKER";
export const STANDARD_EXTENSION_TOOL = "acceptance_probe";

export interface StandardWorkflowFixtureOptions {
  backend?: ExecutionBackendKind;
  /** Deliberately distinct from the configured backend in profile-default tests. */
  requestedBackend?: ExecutionBackendKind;
  settings?: Omit<WorkflowExecutorSettings, "backend">;
  delegate?: "embedded" | "terminal";
}

export interface StandardWorkflowFixture {
  readonly root: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly ctx: ExtensionContext;
  readonly model: Model<string>;
  readonly alternateModel: Model<string>;
  readonly modelKey: string;
  readonly alternateModelKey: string;
  readonly probeFile: string;
  readonly identities: readonly WorkflowExecutorIdentity[];
  readonly executions: readonly WorkflowExecutorExecution[];
  calls(): number;
  script(...steps: FauxResponseStep[]): TranscriptContext[];
  cleanup(): Promise<void>;
}

export function standardWorkflowFixture(
  options: StandardWorkflowFixtureOptions = {},
): StandardWorkflowFixture {
  const backend = options.backend ?? "embedded";
  const root = realpathSync(mkdtempSync(join(tmpdir(), `workflow-standard-${backend}-`)));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const piDir = join(cwd, ".pi");
  const probeFile = join(root, "extension-probe.txt");
  mkdirSync(join(piDir, "extensions"), { recursive: true });
  mkdirSync(join(piDir, "skills", STANDARD_SKILL), { recursive: true });
  mkdirSync(join(piDir, "agents"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(home, { recursive: true });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  const previousOffline = process.env.PI_OFFLINE;
  const previousVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = home;
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";

  const faux = registerFauxProvider({
    provider: "workflow-standard-faux",
    models: [
      { id: "primary", contextWindow: 200_000, reasoning: true },
      { id: "alternate", contextWindow: 200_000, reasoning: true },
    ],
    tokenSize: { min: 8, max: 8 },
  });
  const model = faux.getModel("primary")!;
  const alternateModel = faux.getModel("alternate")!;
  const terminalModel: Model<string> = {
    id: TERMINAL_MODEL_ID,
    name: "Terminal Faux Model",
    api: TERMINAL_API,
    provider: TERMINAL_PROVIDER,
    baseUrl: "faux://offline",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  const models = [model, alternateModel, terminalModel];
  const runtime = fauxModelBackend(model);
  runtime.modelRegistry.runtime = runtime.modelRuntime;
  runtime.modelRegistry.find = (provider: string, id: string) =>
    models.find(candidate => candidate.provider === provider && candidate.id === id);
  runtime.modelRegistry.getAll = () => [...models];
  runtime.modelRegistry.getAvailable = () => [...models];
  runtime.modelRuntime.getModel = (provider: string, id: string) =>
    models.find(candidate => candidate.provider === provider && candidate.id === id);
  runtime.modelRuntime.getModels = () => [...models];
  runtime.modelRuntime.getAvailable = async () => [...models];
  runtime.modelRuntime.getAvailableSnapshot = () => [...models];

  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: model.provider,
    defaultModel: model.id,
    defaultThinkingLevel: "off",
    defaultTools: [],
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    enableInstallTelemetry: false,
  }, null, 2)}\n`);
  writeFileSync(join(piDir, "subagents.json"), `${JSON.stringify({
    backend,
    backgroundByDefault: false,
    maxConcurrent: 2,
    maxSubagentDepth: 2,
    rememberAgents: true,
    outputTranscript: false,
  }, null, 2)}\n`);
  writeFileSync(join(piDir, "skills", STANDARD_SKILL, "SKILL.md"), `---\nname: ${STANDARD_SKILL}\ndescription: Standard workflow acceptance skill.\n---\n\n${STANDARD_SKILL_MARKER}\nUse the acceptance_probe tool with the requested value.\n`);
  writeFileSync(join(piDir, "extensions", "acceptance-probe.ts"), `
import { writeFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
export default function (pi) {
  pi.registerTool({
    name: ${JSON.stringify(STANDARD_EXTENSION_TOOL)},
    label: "Acceptance Probe",
    description: "Record a standard workflow acceptance value.",
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, params) => {
      writeFileSync(${JSON.stringify(probeFile)}, params.value);
      return { content: [{ type: "text", text: "acceptance-probe:" + params.value }], details: { value: params.value } };
    },
  });
}
`);

  const delegateMode = options.delegate ?? backend;
  const delegateModel = delegateMode === "terminal"
    ? `${TERMINAL_PROVIDER}/${TERMINAL_MODEL_ID}`
    : `${model.provider}/${model.id}`;
  const delegateExtensions = delegateMode === "terminal"
    ? JSON.stringify(TERMINAL_PROVIDER_EXTENSION)
    : "false";
  writeFileSync(join(piDir, "agents", "delegate.md"), `---
name: delegate
description: Standard workflow nested delegate.
tools: none
skills: false
extensions: ${delegateExtensions}
model: ${delegateModel}
persist_session: true
max_turns: 4
---
Return the delegated result directly.
`);

  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    cwd,
    mode: "json",
    hasUI: false,
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    model,
    thinkingLevel: "off",
    modelRegistry: runtime.modelRegistry,
    sessionManager: SessionManager.inMemory(cwd),
    getSystemPrompt: () => "Offline standard workflow observer",
    isProjectTrusted: () => true,
    waitForIdle: async () => {},
    maxConcurrency: 1,
    spawnChild: async () => { throw new Error("root observer must not execute workflow children"); },
  } as unknown as ExtensionContext;

  const bus = new Map<string, Set<(data: unknown) => void>>();
  const hooks = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const listen = <T>(map: Map<string, Set<T>>, name: string, fn: T) => {
    let listeners = map.get(name);
    if (!listeners) map.set(name, listeners = new Set());
    listeners.add(fn);
    return () => { listeners!.delete(fn); };
  };
  const pi = {
    events: {
      on: (name: string, fn: (data: unknown) => void) => listen(bus, name, fn),
      emit: (name: string, data: unknown) => {
        for (const fn of [...bus.get(name) ?? []]) fn(data);
      },
    },
    on: (name: string, fn: (...args: unknown[]) => unknown) => listen(hooks, name, fn),
  } as unknown as ExtensionAPI;

  const registration = registerWorkflowExecutor(pi, {
    createRuntime: ({ backend: selected }) => createWorkflowAgentRuntime({ backend: selected }),
  });
  const identities: WorkflowExecutorIdentity[] = [];
  const executions: WorkflowExecutorExecution[] = [];
  const settings: WorkflowExecutorSettings = {
    maxConcurrency: 1,
    ...options.settings,
    ...(options.requestedBackend ? { backend: options.requestedBackend } : {}),
  };
  const provider: WorkflowExecutionProvider = {
    async createHost(observer, run) {
      const offers: WorkflowExecutorOffer[] = [];
      pi.events.emit(WORKFLOW_EXECUTOR_DISCOVERY, {
        version: 1,
        offer: (offer: WorkflowExecutorOffer) => offers.push(offer),
      });
      const offer = offers.find(candidate => candidate.id === SUBAGENT_EXECUTOR_ID);
      if (!offer) throw new Error("standard workflow executor was not discovered synchronously");
      const execution = await offer.createExecution({
        observer: observer as WorkflowExecutorRequest["observer"],
        run,
        settings,
        cancellationError: run.cancellationError,
        signal: run.signal,
        identity: run.identity as WorkflowExecutorIdentity | undefined,
      });
      identities.push(execution.identity);
      executions.push(execution);
      return execution;
    },
  };
  const unregisterProvider = registerWorkflowExecutionHost(provider);
  let closed = false;

  return {
    root,
    cwd,
    agentDir,
    ctx,
    model,
    alternateModel,
    modelKey: `${model.provider}/${model.id}`,
    alternateModelKey: `${alternateModel.provider}/${alternateModel.id}`,
    probeFile,
    identities,
    executions,
    calls: () => faux.state.callCount,
    script(...steps) {
      const requests: TranscriptContext[] = [];
      faux.setResponses(steps.map(step => (context, responseOptions, state, requestModel) => {
        requests.push(context);
        return typeof step === "function"
          ? step(context, responseOptions, state, requestModel)
          : step;
      }));
      return requests;
    },
    async cleanup() {
      if (closed) return;
      closed = true;
      unregisterProvider();
      try {
        await Promise.allSettled(executions.map(execution => execution.close()));
        await registration.close();
      } finally {
        cleanupHeadlessProcesses();
        faux.unregister();
        registerAgents(new Map());
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousOffline === undefined) delete process.env.PI_OFFLINE;
        else process.env.PI_OFFLINE = previousOffline;
        if (previousVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
        else process.env.PI_SKIP_VERSION_CHECK = previousVersionCheck;
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
