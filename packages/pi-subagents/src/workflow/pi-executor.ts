import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createManagedEmbeddedExecutionBackend } from "../backends/embedded-managed.js";
import { inspectManagedSession } from "../backends/managed-session.js";
import { assertPromptBindingMatches, snapshotPromptBinding, type PromptBinding } from "../backends/prompt-binding.js";
import type { ExecutionBackendKind } from "../backends/session-reference.js";
import { createTerminalExecutionBackend } from "../backends/terminal/backend.js";
import { snapshotRequiredTools } from "../backends/tool-requirements.js";
import type { AgentExecutionBackend } from "../backends/types.js";
import { inChildSessionContext } from "../child-context.js";
import { i18n } from "../i18n.js";
import { createWorkflowExecutionProvider } from "./execution-provider.js";
import {
  SUBAGENT_EXECUTOR_ID, WORKFLOW_EXECUTOR_DISCOVERY, WORKFLOW_EXECUTOR_VERSION,
  type WorkflowExecutorDiscovery, type WorkflowExecutorExecution, type WorkflowExecutorIdentity,
  type WorkflowExecutorOffer, type WorkflowExecutorRequest,
} from "./executor-protocol.js";
import { createWorkflowSkillPreparer } from "./skill-resources.js";

export interface WorkflowExecutorRegistrationOptions {
  /** Explicit composition/test injection; the default uses the real managed factories. */
  createBackend?: (kind: ExecutionBackendKind, sessionDir: string) => AgentExecutionBackend;
}

interface Generation {
  readonly controller: AbortController;
  readonly executions: Set<WorkflowExecutorExecution>;
  readonly retiring: Set<Promise<void>>;
  closing?: Promise<void>;
}

/** Pi-facing executor only. The workflow package owns commands, definitions and run journals. */
export function registerWorkflowExecutor(pi: ExtensionAPI, options: WorkflowExecutorRegistrationOptions = {}): { close(): Promise<void> } {
  if (inChildSessionContext()) return { close: async () => {} };
  const createBackend = options.createBackend ?? ((kind, sessionDir) => kind === "embedded"
    ? createManagedEmbeddedExecutionBackend({ sessionDir })
    : createTerminalExecutionBackend({ sessionDir, artifactDir: join(sessionDir, "artifacts") }));
  const generations = new Set<Generation>();
  function newGeneration(): Generation {
    const owner: Generation = { controller: new AbortController(), executions: new Set(), retiring: new Set() };
    generations.add(owner);
    return owner;
  }
  let generation = newGeneration();
  let closed = false;
  let closing: Promise<void> | undefined;

  function stopGeneration(owner: Generation): Promise<void> {
    if (owner.closing) return owner.closing;
    const pending = deferredClose();
    owner.closing = pending.promise;
    owner.controller.abort();
    // Abort callbacks may already have moved executions into retiring.
    for (const execution of [...owner.executions]) void execution.close();
    void settleAll([...owner.retiring]).then(pending.resolve, pending.reject);
    void pending.promise.then(() => generations.delete(owner), () => generations.delete(owner));
    return pending.promise;
  }
  const rotateGeneration = () => {
    if (closed) return closing;
    const previous = generation;
    generation = newGeneration();
    return stopGeneration(previous);
  };

  const unlisten = pi.events.on(WORKFLOW_EXECUTOR_DISCOVERY, data => {
    if (closed || !isDiscovery(data)) return;
    const owner = generation;
    const offer: WorkflowExecutorOffer = Object.freeze({
      version: WORKFLOW_EXECUTOR_VERSION, id: SUBAGENT_EXECUTOR_ID,
      backends: Object.freeze(["embedded", "terminal"] as const),
      createExecution: (request: WorkflowExecutorRequest) => {
        if (closed || owner !== generation || owner.controller.signal.aborted) throw failure("closed");
        validateRequest(request);
        const settings = request.settings;
        const requiredTools = snapshotRequiredTools(settings.requiredTools) ?? Object.freeze([]);
        const prepareSkill = createWorkflowSkillPreparer(settings.skills ?? []);
        const promptBinding: PromptBinding = Object.freeze({
          resolverId: "pi-subagents/workflow-executor@1",
          resourceSetDigest: createHash("sha256").update(JSON.stringify({
            version: 1, skills: prepareSkill.promptBinding,
            requiredTools: [...requiredTools].sort(),
          })).digest("hex"),
          assetMode: "live",
        });
        const previous = request.identity;
        if (previous) {
          if (previous.version !== 1 || previous.executor !== SUBAGENT_EXECUTOR_ID || !isBackend(previous.backend)) throw failure("identity");
          assertPromptBindingMatches(snapshotPromptBinding(previous.promptBinding), promptBinding);
        }
        // Backend selection is a new-run preference. Existing run identity always wins.
        const backend = previous?.backend ?? settings.backend;
        const identity: WorkflowExecutorIdentity = Object.freeze({
          version: 1, executor: SUBAGENT_EXECUTOR_ID, backend, promptBinding,
        });
        const signals = [owner.controller.signal, request.signal, request.observer.signal].filter((signal): signal is AbortSignal => signal !== undefined);
        const signal = AbortSignal.any(signals);
        if (signal.aborted) throw cancellation(request, signal);
        const observer = Object.create(request.observer, { signal: { value: signal } });
        const provider = createWorkflowExecutionProvider({
          pi,
          getContext: current => current as unknown as ExtensionContext,
          createBackend: ({ sessionDir }) => {
            const actual = createBackend(backend, sessionDir);
            if (actual.kind !== backend) throw failure("identity");
            return actual;
          },
          inspectSession: file => inspectManagedSession(file, backend),
          agentType: settings.agentType,
          maxConcurrency: settings.maxConcurrency,
          maxTurns: settings.maxTurns,
          promptBinding,
          cancellationError: request.cancellationError,
          preparePrompt: async (input, context) => {
            const prepared = await prepareSkill(input, context);
            return { ...prepared, requiredTools: [...requiredTools, ...(prepared.requiredTools ?? [])] };
          },
        });
        const execution = provider.createHost(observer, request.run);
        let closePromise: Promise<void> | undefined;
        const wrapped: WorkflowExecutorExecution = {
          ...execution, identity,
          readSessionBranch: file => provider.readSessionBranch?.(file),
          close: () => {
            if (closePromise) return closePromise;
            const pending = deferredClose();
            closePromise = pending.promise;
            owner.executions.delete(wrapped);
            owner.retiring.add(closePromise);
            void closePromise.then(() => owner.retiring.delete(pending.promise), () => owner.retiring.delete(pending.promise));
            // Publish the barrier before a synchronous/reentrant shutdown callback.
            try { pending.resolve(execution.close()); } catch (error) { pending.reject(error); }
            return closePromise;
          },
          dispose: () => { void wrapped.close(); },
        };
        if (closed || owner !== generation || owner.controller.signal.aborted) {
          void wrapped.close();
          throw cancellation(request, signal);
        }
        owner.executions.add(wrapped);
        return wrapped;
      },
    });
    data.offer(offer);
  });

  const offStart = pi.on("session_start", rotateGeneration);
  // Rotate even if another handler cancels navigation: new discovery remains usable.
  const offSwitch = pi.on("session_before_switch", rotateGeneration);
  const offFork = pi.on("session_before_fork", rotateGeneration);
  const offTree = pi.on("session_before_tree", rotateGeneration);
  const offShutdown = pi.on("session_shutdown", async () => { await close(); });

  function close(): Promise<void> {
    if (closing) return closing;
    const pending = deferredClose();
    closing = pending.promise;
    closed = true;
    unlisten();
    offStart(); offSwitch(); offFork(); offTree(); offShutdown();
    void settleAll([...generations].map(stopGeneration)).then(pending.resolve, pending.reject);
    return closing;
  }
  return { close };
}

function deferredClose() {
  let resolve!: (value?: void | PromiseLike<void>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

async function settleAll(promises: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, i18n.t("workflowExecutor.cleanup"));
}

function isDiscovery(data: unknown): data is WorkflowExecutorDiscovery {
  return !!data && typeof data === "object" && (data as WorkflowExecutorDiscovery).version === 1
    && typeof (data as WorkflowExecutorDiscovery).offer === "function";
}

function isBackend(value: unknown): value is ExecutionBackendKind { return value === "embedded" || value === "terminal"; }

function validateRequest(request: WorkflowExecutorRequest): void {
  if (!request || typeof request !== "object" || !request.settings || !isBackend(request.settings.backend)
    || typeof request.cancellationError !== "function" || !request.observer
    || (request.signal !== undefined && !(request.signal instanceof AbortSignal))
    || (request.observer.signal !== undefined && !(request.observer.signal instanceof AbortSignal))
    || (request.identity !== undefined && (!request.identity || typeof request.identity !== "object"))) throw failure("request");
  const ctx = request.observer as unknown as Partial<ExtensionContext>;
  if (!ctx.modelRegistry || typeof ctx.modelRegistry.find !== "function" || typeof ctx.getSystemPrompt !== "function") throw failure("context");
}

function cancellation(request: WorkflowExecutorRequest, signal: AbortSignal): Error {
  try {
    const error = request.cancellationError(signal);
    return error instanceof Error ? error : failure("request");
  } catch (error) { return error instanceof Error ? error : failure("request"); }
}

function failure(key: string): Error { return new Error(i18n.t(`workflowExecutor.${key}`)); }
