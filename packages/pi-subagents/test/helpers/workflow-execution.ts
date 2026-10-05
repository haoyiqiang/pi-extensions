import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { ManagedPolicy } from "../../src/backends/managed-policy.js";
import type { ExecutionSession } from "../../src/backends/session.js";
import type { PersistentSessionReference } from "../../src/backends/session-reference.js";
import type {
  AgentExecutionBackend, ExecutionResumeOptions, ExecutionResumeResult, ExecutionRunOptions,
  ExecutionRunResult, ExecutionSessionSnapshot,
} from "../../src/backends/types.js";
import type { WorkflowHostContext } from "../../src/workflow/execution-contract.js";
import { SubagentWorkflowExecutionHost, type WorkflowExecutionHostOptions } from "../../src/workflow/execution-host.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Drain promise-only scheduling; never sleeps, polls the wall clock, or launches Pi. */
export async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

export class ConsumerCancellation extends Error {
  constructor(readonly signal: AbortSignal) {
    super("consumer cancellation", { cause: signal.reason });
  }
}

export function rawBranch() {
  return [
    { type: "message", id: "system", parentId: null, timestamp: "first", message: {
      role: "system", content: "", sections: { preamble: "saved system" }, timestamp: 1,
    } },
    { type: "message", id: "user", parentId: "system", message: { role: "user", content: "original user", timestamp: 2 } },
    { type: "message", id: "assistant", parentId: "user", opaqueEnvelope: { keep: true }, message: {
      role: "assistant", stopReason: "stop", providerMetadata: { trace: "saved" }, content: [
        { type: "text", text: "answer" },
        { type: "toolCall", id: "call", name: "read", arguments: { path: "example.txt", extra: { keep: [1, 2] } } },
      ],
    } },
    { type: "compaction", id: "compact", parentId: "assistant", summary: "saved summary", firstKeptEntryId: "user", tokensBefore: 42, details: { preserved: true } },
    { type: "context_edit", id: "edit", parentId: "compact", targetId: "user", patch: { content: "projected replacement" } },
    { type: "custom", id: "opaque", parentId: "edit", customType: "workflow-offset", data: { offset: 17, nested: ["keep"] } },
  ];
}

export function executionFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-execution-")));
  const sessionDir = join(root, "children", "managed");
  mkdirSync(sessionDir, { recursive: true });
  let sequence = 0;
  const snapshots = new Map<string, ExecutionSessionSnapshot>();
  const handles: ExecutionSession[] = [];
  const hosts: SubagentWorkflowExecutionHost[] = [];
  const cleanup: (() => void)[] = [];
  const model: Model<any> = {
    provider: "fixture", id: "family/model", name: "fixture model", api: "openai-completions",
    baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const otherModel: Model<any> = { ...model, provider: "other", id: "family/model" };
  const find = vi.fn((provider: string, id: string) => [model, otherModel].find(candidate => candidate.provider === provider && candidate.id === id));
  const pi = { setModel: vi.fn(), setThinkingLevel: vi.fn(), exec: vi.fn(() => { throw new Error("must not launch a process"); }) } as unknown as ExtensionAPI;
  const ctx = { cwd: root, mode: "json", hasUI: false, model, getSystemPrompt: vi.fn(() => "parent system"),
    modelRegistry: { find, getAll: () => [model, otherModel] } } as unknown as ExtensionContext;
  const rootBranch = rawBranch();
  const observer: WorkflowHostContext = {
    cwd: root, hasUI: false, maxConcurrency: 99, ui: { notify: vi.fn() },
    sessionManager: { getSessionId: vi.fn(() => "observer-id"), getSessionFile: vi.fn(() => join(root, "observer.jsonl")), getBranch: vi.fn(() => rootBranch) },
    waitForIdle: vi.fn(async () => {}), spawnChild: vi.fn(async () => { throw new Error("observer must not execute children"); }),
  };

  function seed(options: { file?: string; id?: string; policy?: Partial<ManagedPolicy>; branch?: ExecutionSessionSnapshot["branch"] } = {}) {
    const sessionId = options.id ?? `persistent-${++sequence}`;
    const sessionFile = options.file ?? join(sessionDir, `${sessionId}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    // Only realpath/storage checks need a file: backend observations come from the shared map.
    writeFileSync(sessionFile, "fixture placeholder\n");
    const reference: PersistentSessionReference = { backend: "embedded", sessionId, sessionFile };
    const snapshot: ExecutionSessionSnapshot = {
      reference,
      policy: { type: "general-purpose", name: "saved", cwd: root, model: { provider: model.provider, id: model.id },
        thinkingLevel: "off", tools: ["read"], systemPrompt: "saved policy", ...options.policy },
      branch: options.branch ?? rawBranch(),
    };
    snapshots.set(sessionFile, snapshot);
    return snapshot;
  }

  function handle(snapshot: ExecutionSessionSnapshot): ExecutionSession {
    const session: ExecutionSession = {
      reference: snapshot.reference, model: snapshot.policy.model, thinkingLevel: snapshot.policy.thinkingLevel,
      // Deliberately not the raw branch; projecting these would lose entries and offsets.
      messages: [{ role: "user", content: "projected replacement" }],
      getBranch: () => snapshots.get(snapshot.reference.sessionFile)!.branch,
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }), subscribe: () => () => {},
    };
    handles.push(session);
    return session;
  }

  function fresh(options: ExecutionRunOptions) {
    return handle(seed({ policy: {
      ...(options.model ? { model: { provider: options.model.provider, id: options.model.id } } : {}),
      ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
    } }));
  }

  function result(session: ExecutionSession, extra: Partial<ExecutionRunResult> = {}): ExecutionRunResult {
    return { session, responseText: "answer", aborted: false, steered: false, ...extra };
  }

  const backend = {
    kind: "embedded" as const,
    run: vi.fn<AgentExecutionBackend["run"]>(async (_ctx, _type, _prompt, options) => {
      const session = fresh(options);
      options.onSessionCreated?.(session);
      return result(session);
    }),
    resume: vi.fn<AgentExecutionBackend["resume"]>(async () => ({ text: "resumed" })),
    inspect: vi.fn<NonNullable<AgentExecutionBackend["inspect"]>>(file => {
      const snapshot = snapshots.get(file);
      if (!snapshot) throw new Error("fixture snapshot missing");
      return snapshot;
    }),
    reattach: vi.fn<NonNullable<AgentExecutionBackend["reattach"]>>(async ref => handle(snapshots.get(ref.sessionFile)!)),
    fork: vi.fn<NonNullable<AgentExecutionBackend["fork"]>>(async ref => {
      const source = snapshots.get(ref.sessionFile)!;
      return handle(seed({ policy: structuredClone(source.policy), branch: structuredClone(source.branch) }));
    }),
    steer: vi.fn<AgentExecutionBackend["steer"]>(async () => {}),
    shutdown: vi.fn<AgentExecutionBackend["shutdown"]>(async () => {}),
  };

  function blockRun(publish = true) {
    const started = deferred<{ session: ExecutionSession; options: ExecutionRunOptions; prompt: string }>();
    const settled = deferred<ExecutionRunResult>();
    let session!: ExecutionSession;
    let options!: ExecutionRunOptions;
    backend.run.mockImplementationOnce((_ctx, _type, prompt, input) => {
      options = input;
      session = fresh(options);
      if (publish) options.onSessionCreated?.(session);
      started.resolve({ session, options, prompt });
      return settled.promise;
    });
    const finish = (extra: Partial<ExecutionRunResult> = {}) => { if (session) settled.resolve(result(session, extra)); };
    cleanup.push(() => finish({ aborted: true }));
    return { started: started.promise, finish, reject: settled.reject, publish: () => options.onSessionCreated?.(session) };
  }

  function blockResume() {
    const started = deferred<{ session: ExecutionSession; options: ExecutionResumeOptions; prompt: string }>();
    const settled = deferred<ExecutionResumeResult>();
    backend.resume.mockImplementationOnce((session, prompt, options) => {
      started.resolve({ session, options, prompt });
      return settled.promise;
    });
    const finish = (extra: Partial<ExecutionResumeResult> = {}) => settled.resolve({ text: "resumed", ...extra });
    cleanup.push(() => finish({ aborted: true }));
    return { started: started.promise, finish, reject: settled.reject };
  }

  function gate() {
    const pending = deferred<void>();
    cleanup.push(() => pending.resolve());
    return pending;
  }

  function host(extra: Partial<WorkflowExecutionHostOptions> = {}) {
    const subject = new SubagentWorkflowExecutionHost({ pi, ctx, observer, backend, runId: "workflow-run", sessionDir,
      cancellationError: signal => new ConsumerCancellation(signal), ...extra });
    hosts.push(subject);
    return subject;
  }

  async function close() {
    for (const done of cleanup) done();
    await Promise.all(hosts.map(subject => subject.dispose()));
    await flush();
    rmSync(root, { recursive: true, force: true });
  }
  return { root, sessionDir, snapshots, handles, model, otherModel, find, pi, ctx, observer, rootBranch,
    backend, seed, handle, fresh, result, host, blockRun, blockResume, gate, close };
}
