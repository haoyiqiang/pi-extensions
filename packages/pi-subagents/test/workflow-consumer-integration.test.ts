/** Real pi-workflow runner wired through the public executor discovery protocol. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acts, defineWorkflow, produces, STOP, type Workflow } from "../../pi-workflow/src/api.ts";
import { opaque } from "../../pi-workflow/src/handle.ts";
import { FAIL_WORKFLOW_ABORTED } from "../../pi-workflow/src/messages.ts";
import { resumeWorkflow, runWorkflow } from "../../pi-workflow/src/runner/index.ts";
import { readAllStages, readHeader, stateFilePath } from "../../pi-workflow/src/state/index.ts";
import {
  registerWorkflowExecutionHost,
  type WorkflowExecutionProvider,
} from "../../pi-workflow/src/startup.ts";
import { inspectManagedSession } from "../src/backends/managed-session.js";
import type { ExecutionBackendKind } from "../src/backends/session-reference.js";
import { i18n } from "../src/i18n.js";
import * as workflowProvider from "../src/workflow/execution-provider.js";
import {
  SUBAGENT_EXECUTOR_ID,
  WORKFLOW_EXECUTOR_DISCOVERY,
  type WorkflowExecutorExecution,
  type WorkflowExecutorIdentity,
  type WorkflowExecutorOffer,
  type WorkflowExecutorRequest,
} from "../src/workflow/executor-protocol.js";
import { registerWorkflowExecutor } from "../src/workflow/pi-executor.js";
import { within, workflowRealBackend } from "./helpers/workflow-real-backends.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const integrations: Integration[] = [];
let previousOffline: string | undefined;
let previousVersionCheck: string | undefined;

beforeEach(() => {
  previousOffline = process.env.PI_OFFLINE;
  previousVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
});

afterEach(async () => {
  try {
    for (const integration of integrations.splice(0)) await integration.cleanup();
  } finally {
    vi.restoreAllMocks();
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    if (previousVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
    else process.env.PI_SKIP_VERSION_CHECK = previousVersionCheck;
  }
});

interface Integration {
  readonly kind: ExecutionBackendKind;
  readonly real: ReturnType<typeof workflowRealBackend>;
  readonly observer: WorkflowExecutorRequest["observer"];
  readonly backendRequests: ExecutionBackendKind[];
  readonly executions: WorkflowExecutorExecution[];
  setBackend(kind: ExecutionBackendKind): void;
  setRequiredTools(tools: readonly string[]): void;
  retireLatest(): Promise<void>;
  cleanup(): Promise<void>;
}

function integration(kind: ExecutionBackendKind): Integration {
  const createProvider = workflowProvider.createWorkflowExecutionProvider;
  let captured!: workflowProvider.WorkflowExecutionProviderOptions;
  const capture = vi.spyOn(workflowProvider, "createWorkflowExecutionProvider").mockImplementation(options => {
    captured = options;
    return createProvider(options);
  });
  let real: ReturnType<typeof workflowRealBackend>;
  try { real = workflowRealBackend(kind); }
  finally { capture.mockRestore(); }
  if (!captured) throw new Error("real workflow provider construction was not captured");

  const seedRun = { runId: "consumer-seed", childSessionsDir: join(real.root, "consumer-seed") };
  const ctx = captured.getContext({} as never, seedRun);
  const notifications: Array<{ message: string; level?: string }> = [];
  const observer = Object.assign(Object.create(ctx) as ExtensionContext, {
    cwd: real.cwd,
    hasUI: false,
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    sessionManager: ctx.sessionManager,
    waitForIdle: async () => {},
    maxConcurrency: 1,
    spawnChild: async () => { throw new Error("workflow observer must not execute children"); },
  }) as unknown as WorkflowExecutorRequest["observer"];

  const eventListeners = new Map<string, Set<(data: unknown) => void>>();
  const lifecycleListeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const listen = <T>(map: Map<string, Set<T>>, name: string, listener: T) => {
    let listeners = map.get(name);
    if (!listeners) map.set(name, listeners = new Set());
    listeners.add(listener);
    return () => { listeners!.delete(listener); };
  };
  const pi = Object.assign(Object.create(captured.pi) as ExtensionAPI, {
    events: {
      on: (name: string, listener: (data: unknown) => void) => listen(eventListeners, name, listener),
      emit: (name: string, data: unknown) => {
        for (const listener of [...eventListeners.get(name) ?? []]) listener(data);
      },
    },
    on: (name: string, listener: (...args: unknown[]) => unknown) => listen(lifecycleListeners, name, listener),
  }) as ExtensionAPI;

  const backendRequests: ExecutionBackendKind[] = [];
  const executions: WorkflowExecutorExecution[] = [];
  let configuredBackend = kind;
  let requiredTools: readonly string[] = [];
  const executor = registerWorkflowExecutor(pi, {
    createBackend(requested, sessionDir) {
      backendRequests.push(requested);
      const childSessionsDir = dirname(sessionDir);
      return captured.createBackend({
        sessionDir,
        run: { runId: basename(dirname(childSessionsDir)), childSessionsDir },
      });
    },
  });

  const consumer: WorkflowExecutionProvider = {
    async createHost(currentObserver, options) {
      const offers: WorkflowExecutorOffer[] = [];
      pi.events.emit(WORKFLOW_EXECUTOR_DISCOVERY, {
        version: 1,
        offer: (offer: WorkflowExecutorOffer) => offers.push(offer),
      });
      const offer = offers.find(candidate => candidate.id === SUBAGENT_EXECUTOR_ID);
      if (!offer) throw new Error("pi-subagents workflow executor was not discovered synchronously");
      const execution = await offer.createExecution({
        observer: currentObserver as WorkflowExecutorRequest["observer"],
        run: {
          runId: options.runId,
          childSessionsDir: options.childSessionsDir,
          name: options.name,
          workflow: options.workflow,
          input: options.input,
        },
        settings: {
          backend: configuredBackend,
          agentType: "workflow-offline",
          maxConcurrency: 1,
          requiredTools,
        },
        cancellationError: options.cancellationError,
        signal: options.signal,
        identity: options.identity as WorkflowExecutorIdentity | undefined,
      });
      executions.push(execution);
      return execution;
    },
  };
  const unregisterConsumer = registerWorkflowExecutionHost(consumer);
  let closed = false;
  const subject: Integration = {
    kind, real, observer, backendRequests, executions,
    setBackend(value) { configuredBackend = value; },
    setRequiredTools(value) { requiredTools = [...value]; },
    async retireLatest() { await executions.at(-1)?.close(); },
    async cleanup() {
      if (closed) return;
      closed = true;
      unregisterConsumer();
      try {
        await Promise.allSettled(executions.map(execution => execution.close()));
        await executor.close();
      } finally {
        await real.cleanup();
      }
    },
  };
  integrations.push(subject);
  return subject;
}

function twoPromptWorkflow(): Workflow {
  return defineWorkflow({
    name: "real-two-prompt-stages",
    start: "first",
    stages: {
      first: acts.prompt({ prompt: "FIRST_REAL_PROMPT" }),
      second: acts.prompt({ prompt: "SECOND_REAL_PROMPT", sessionPolicy: "continue" }),
    },
    edges: { first: "second", second: STOP },
  });
}

function reattachWorkflow(): Workflow {
  return defineWorkflow({
    name: "real-saved-session-reattach",
    start: "build",
    stages: {
      build: produces.prompt({
        prompt: "BUILD_REAL_REATTACH_PROMPT",
        outcome: {
          collector: {
            collect(context) {
              const start = Math.max(context.branchOffset ?? 0, 0);
              const assistants = context.branch.slice(start).filter(entry =>
                entry.type === "message" && entry.message?.role === "assistant").length;
              return assistants >= 2
                ? { kind: "ok" as const, artifacts: [{ handle: opaque("reattached"), role: "primary" }] }
                : { kind: "fatal" as const, message: "fixture requires one saved-session continuation" };
            },
          },
        },
      }),
    },
    edges: { build: STOP },
  });
}

function cancellationWorkflow(): Workflow {
  return defineWorkflow({
    name: "real-cancellation",
    start: "cancel",
    stages: { cancel: acts.prompt({ prompt: "CANCEL_REAL_PROMPT" }) },
    edges: { cancel: STOP },
  });
}

function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap(block => block && typeof block === "object" && "text" in block
    && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []).join("\n");
}

function userTexts(branch: readonly unknown[]): string[] {
  return branch.flatMap(entry => {
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") return [];
    const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
    return message?.role === "user" ? [messageText(message)] : [];
  });
}

function expectPrompt(text: string, prompt: string): void {
  expect(text).toContain(prompt);
  expect(text.split(prompt)).toHaveLength(2);
}

function expectRetiredManagedFiles(files: readonly string[]): void {
  for (const file of files) {
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.pi-subagents.lock`)).toBe(false);
    expect(JSON.parse(readFileSync(`${file}.pi-subagents.json`, "utf8")).state).toBe("ready");
  }
  const managed = dirname(files[0]!);
  expect(readdirSync(managed).filter(name => name.endsWith(".pi-subagents.lock"))).toEqual([]);
}

for (const kind of ["embedded", "terminal"] as const) {
  describe.skipIf(kind === "terminal" && process.platform === "win32")(`real pi-workflow consumer over ${kind}`, () => {
    it("runs a fresh prompt then a real owned continue fork without mutating the persisted source", async () => {
      const f = integration(kind);
      const workflow = twoPromptWorkflow();
      let sourceBytes: Buffer | undefined;
      let sourceRecord: Buffer | undefined;

      const result = await runWorkflow(f.observer as never, {
        workflow,
        input: "consumer input",
        lifecycle: {
          onStageStart(stage, context) {
            if (stage.name === "second") {
              const source = readAllStages(context.cwd, context.runId)[0]?.session?.file;
              expect(source).toBeTypeOf("string");
              sourceBytes = readFileSync(source!);
              sourceRecord = readFileSync(`${source}.pi-subagents.json`);
            }
            f.real.scriptText(`done:${stage.name}`);
          },
        },
      });
      await f.retireLatest();

      expect(result).toMatchObject({ success: true, stagesCompleted: 2, termination: { status: "completed" } });
      const rows = readAllStages(f.real.cwd, result.runId!);
      expect(rows.map(row => row.status)).toEqual(["completed", "completed"]);
      const source = rows[0]!.session!;
      const continued = rows[1]!.session!;
      expect(source.file).toBeTypeOf("string");
      expect(continued.file).toBeTypeOf("string");
      expect(continued.id).not.toBe(source.id);
      expect(continued.file).not.toBe(source.file);
      expect(continued.branchOffset).toBeTypeOf("number");
      expect(readFileSync(source.file!)).toEqual(sourceBytes);
      expect(readFileSync(`${source.file}.pi-subagents.json`)).toEqual(sourceRecord);

      const sourceBranch = inspectManagedSession(source.file!, kind).branch;
      const continuedBranch = inspectManagedSession(continued.file!, kind).branch;
      expect(continued.branchOffset).toBe(sourceBranch.length);
      expect(continuedBranch.slice(0, sourceBranch.length)).toEqual(sourceBranch);
      const sourceUsers = userTexts(sourceBranch);
      const continuedUsers = userTexts(continuedBranch);
      expect(sourceUsers).toHaveLength(1);
      expect(continuedUsers).toHaveLength(2);
      expectPrompt(sourceUsers[0]!, "FIRST_REAL_PROMPT");
      expectPrompt(continuedUsers[0]!, "FIRST_REAL_PROMPT");
      expectPrompt(continuedUsers[1]!, "SECOND_REAL_PROMPT");
      expect(dirname(source.file!)).toBe(dirname(continued.file!));
      expect(readdirSync(dirname(source.file!)).filter(name => name.endsWith(".jsonl"))).toHaveLength(2);
      expectRetiredManagedFiles([source.file!, continued.file!]);
      expect(f.backendRequests).toEqual([kind]);
      await f.real.transport.assertRetired();
    });

    it("persists executor identity, keeps the backend sticky, and really reattaches the saved failed session", async () => {
      const f = integration(kind);
      const workflow = reattachWorkflow();
      f.real.scriptText("initial saved turn");
      const first = await runWorkflow(f.observer as never, { workflow, input: "reattach input" });
      await f.retireLatest();

      expect(first).toMatchObject({ success: false, termination: { status: "failed" } });
      const firstRows = readAllStages(f.real.cwd, first.runId!);
      expect(firstRows).toHaveLength(1);
      expect(firstRows[0]).toMatchObject({ status: "failed", session: { id: expect.any(String), file: expect.any(String) } });
      const source = firstRows[0]!.session!;
      const beforeBranch = inspectManagedSession(source.file!, kind).branch;
      const header = readHeader(f.real.cwd, first.runId!);
      expect(header?.identity).toMatchObject({
        version: 1,
        executor: SUBAGENT_EXECUTOR_ID,
        backend: kind,
        promptBinding: {
          resolverId: "pi-subagents/workflow-executor@1",
          resourceSetDigest: expect.any(String),
          assetMode: "live",
        },
      });
      expect(f.backendRequests).toEqual([kind]);
      expectRetiredManagedFiles([source.file!]);

      f.setBackend(kind === "embedded" ? "terminal" : "embedded");
      f.real.scriptText("done after real reattach");
      const resumed = await resumeWorkflow(f.observer as never, { workflow, header: header!, ref: "@saved" });
      await f.retireLatest();

      expect(resumed).toMatchObject({ success: true, runId: first.runId, termination: { status: "completed" } });
      const rows = readAllStages(f.real.cwd, first.runId!);
      expect(rows.map(row => row.status)).toEqual(["failed", "completed"]);
      expect(rows[1]!.session).toEqual(source);
      const afterBranch = inspectManagedSession(source.file!, kind).branch;
      expect(afterBranch.slice(0, beforeBranch.length)).toEqual(beforeBranch);
      expect(afterBranch.length).toBeGreaterThan(beforeBranch.length);
      expect(userTexts(afterBranch)).toHaveLength(2);
      expect(f.backendRequests).toEqual([kind, kind]);
      expect(readHeader(f.real.cwd, first.runId!)?.identity).toEqual(header!.identity);
      expectRetiredManagedFiles([source.file!]);
      await f.real.transport.assertRetired();
    });
  });
}

describe("real consumer cancellation and resume admission", () => {
  it("classifies the executor's canonical cancellation as an abort, not a generic stage failure", async () => {
    const f = integration("embedded");
    const controller = new AbortController();
    const gate = f.real.gateNextInvocation();
    const running = runWorkflow(f.observer as never, {
      workflow: cancellationWorkflow(),
      input: "cancel input",
      signal: controller.signal,
      lifecycle: { onStageStart: () => { f.real.scriptText("blocked until cancellation"); } },
    });
    const observed = running.then(result => result);
    await within(gate.entered, 15_000, "real workflow stage did not enter its model request");
    controller.abort(new Error("consumer requested cancellation"));
    gate.release();
    const result = await observed;
    await f.retireLatest();

    const expected = FAIL_WORKFLOW_ABORTED("cancel").error;
    expect(result).toMatchObject({ success: false, error: expected, termination: { status: "aborted", error: expected } });
    const rows = readAllStages(f.real.cwd, result.runId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "cancel", status: "aborted", errMsg: expected, session: null });
    expect(rows[0]!.errMsg).not.toContain("failed while entering");
    expectRetiredManagedFiles(readdirSync(join(f.real.cwd, ".rpiv", "workflows", "runs", result.runId!, "sessions", "managed"))
      .filter(name => name.endsWith(".jsonl"))
      .map(name => join(f.real.cwd, ".rpiv", "workflows", "runs", result.runId!, "sessions", "managed", name)));
  });

  it("rejects changed resources before another backend, model turn, or journal write", async () => {
    const f = integration("embedded");
    const workflow = reattachWorkflow();
    f.real.scriptText("saved turn before resource mismatch");
    const first = await runWorkflow(f.observer as never, { workflow, input: "resource input" });
    await f.retireLatest();
    const header = readHeader(f.real.cwd, first.runId!)!;
    const source = readAllStages(f.real.cwd, first.runId!)[0]!.session!.file!;
    const journal = stateFilePath(f.real.cwd, first.runId!);
    const before = {
      journal: readFileSync(journal),
      session: readFileSync(source),
      record: readFileSync(`${source}.pi-subagents.json`),
      calls: f.real.calls(),
      backendRequests: [...f.backendRequests],
      executions: f.executions.length,
    };

    f.setRequiredTools(["read"]);
    const refused = await resumeWorkflow(f.observer as never, { workflow, header, ref: "@resource-mismatch" });
    expect(refused).toEqual({
      stagesCompleted: 0,
      success: false,
      error: i18n.t("promptBinding.mismatch"),
    });

    expect(f.real.calls()).toBe(before.calls);
    expect(f.backendRequests).toEqual(before.backendRequests);
    expect(f.executions).toHaveLength(before.executions);
    expect(readFileSync(journal)).toEqual(before.journal);
    expect(readFileSync(source)).toEqual(before.session);
    expect(readFileSync(`${source}.pi-subagents.json`)).toEqual(before.record);
    expectRetiredManagedFiles([source]);
  });
});
