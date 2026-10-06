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
import { getConfiguredBackend, initializeSubagentsRuntime } from "../runtime.js";
import { createWorkflowExecutionProvider } from "./execution-provider.js";
import {
  SUBAGENT_EXECUTOR_ID, WORKFLOW_EXECUTOR_DISCOVERY, WORKFLOW_EXECUTOR_VERSION,
  type WorkflowExecutorDiscovery, type WorkflowExecutorExecution, type WorkflowExecutorIdentity,
  type WorkflowExecutorOffer, type WorkflowExecutorProfile, type WorkflowExecutorRequest,
  type WorkflowExecutorSettings,
} from "./executor-protocol.js";
import { createWorkflowSkillPreparer } from "./skill-resources.js";
import { createStandardWorkflowExecutionProvider } from "./standard-execution-provider.js";
import type {
  StandardWorkflowRuntimeFactory,
  StandardWorkflowRuntimeInitializer,
} from "./standard-resources.js";

export interface WorkflowExecutorRegistrationOptions {
  /** Explicit composition/test injection; used only by the optional managed profile. */
  createBackend?: (kind: ExecutionBackendKind, sessionDir: string) => AgentExecutionBackend;
  /** Fixed runtime-only Agent/RPC extension; retained for simple embedders. */
  initializeRuntime?: StandardWorkflowRuntimeInitializer;
  /** Preferred factory: receives the run identity and backend that nested Agent calls must pin. */
  createRuntime?: StandardWorkflowRuntimeFactory;
  /** The owning entry already called initializeSubagentsRuntime for the active cwd. */
  runtimeInitialized?: boolean;
}

interface Generation {
  readonly controller: AbortController;
  readonly executions: Map<WorkflowExecutorExecution, WorkflowExecutorProfile>;
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
  const initializedCwds = new Set<string>();
  function newGeneration(): Generation {
    const owner: Generation = { controller: new AbortController(), executions: new Map(), retiring: new Set() };
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
    for (const execution of [...owner.executions.keys()]) void execution.close();
    void settleAll([...owner.retiring]).then(pending.resolve, pending.reject);
    void pending.promise.then(() => generations.delete(owner), () => generations.delete(owner));
    return pending.promise;
  }
  function pruneGeneration(owner: Generation): void {
    if (owner !== generation && owner.executions.size === 0 && owner.retiring.size === 0) {
      generations.delete(owner);
    }
  }

  function supersedeGeneration(): Promise<void> | undefined {
    if (closed) return closing;
    const previous = generation;
    generation = newGeneration();
    // Managed hosts retain launcher-bound policy and must retire. Standard hosts
    // own snapshotted SDK/runtime resources and may drain across replacement.
    previous.controller.abort();
    const retiring = [...previous.executions]
      .filter(([, profile]) => profile === "managed")
      .map(([execution]) => execution.close());
    pruneGeneration(previous);
    return settleAll(retiring);
  }

  function configuredBackendFor(cwd: string): ExecutionBackendKind {
    if (!initializedCwds.has(cwd)) {
      if (!options.runtimeInitialized) initializeSubagentsRuntime(cwd);
      initializedCwds.add(cwd);
    }
    return getConfiguredBackend(cwd);
  }

  function createManagedProvider(
    settings: WorkflowExecutorSettings,
    requiredTools: readonly string[],
    backend: ExecutionBackendKind,
    promptBinding: PromptBinding,
    prepareSkill: ReturnType<typeof createWorkflowSkillPreparer>,
    request: WorkflowExecutorRequest,
  ) {
    return createWorkflowExecutionProvider({
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
  }

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
        const configuredBackend = configuredBackendFor(request.observer.cwd);
        const requiredTools = snapshotRequiredTools(settings.requiredTools) ?? Object.freeze([]);
        const previous = request.identity;
        if (previous && (previous.version !== 1 || previous.executor !== SUBAGENT_EXECUTOR_ID
          || !isBackend(previous.backend) || !isOptionalProfile(previous.profile))) throw failure("identity");

        // Old managed identities have no profile. A standard identity that
        // passed through an older consumer can still be recognized by its
        // profile-specific live binding.
        const profile: WorkflowExecutorProfile = previous
          ? (previous.profile ?? (previous.promptBinding.resolverId === "pi-subagents/workflow-standard@1"
              ? "standard"
              : "managed"))
          : (settings.profile ?? "standard");
        if (profile === "standard") validateStandardContext(request.observer);
        const backend = previous?.backend
          ?? (profile === "managed" ? (settings.backend ?? configuredBackend) : configuredBackend);
        const prepareSkill = profile === "managed"
          ? createWorkflowSkillPreparer(settings.skills ?? [])
          : undefined;
        const promptBinding = prepareSkill
          ? managedPromptBinding(prepareSkill.promptBinding, requiredTools)
          : standardPromptBinding(requiredTools);
        if (previous) assertPromptBindingMatches(snapshotPromptBinding(previous.promptBinding), promptBinding);
        const identity: WorkflowExecutorIdentity = Object.freeze({
          version: 1, executor: SUBAGENT_EXECUTOR_ID, backend, profile, promptBinding,
        });
        const signals = [
          ...(profile === "managed" ? [owner.controller.signal] : []),
          request.signal,
          request.observer.signal,
        ].filter((candidate): candidate is AbortSignal => candidate !== undefined);
        const signal = AbortSignal.any(signals);
        if (signal.aborted) throw cancellation(request, signal);
        const observer = Object.create(request.observer, { signal: { value: signal } });

        const provider = profile === "managed"
          ? createManagedProvider(settings, requiredTools, backend, promptBinding, prepareSkill!, request)
          : createStandardWorkflowExecutionProvider({
              getContext: current => current as unknown as ExtensionContext,
              initializeRuntime: options.initializeRuntime,
              createRuntime: options.createRuntime,
              backend,
              maxConcurrency: settings.maxConcurrency,
              maxTurns: settings.maxTurns,
              requiredTools,
              cancellationError: request.cancellationError,
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
            const retired = () => {
              owner.retiring.delete(pending.promise);
              pruneGeneration(owner);
            };
            void closePromise.then(retired, retired);
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
        owner.executions.set(wrapped, profile);
        return wrapped;
      },
    });
    data.offer(offer);
  });

  const offShutdown = pi.on("session_shutdown", async event => {
    if (event.reason === "quit" || event.reason === "reload") await close();
    else await supersedeGeneration();
  });

  function close(): Promise<void> {
    if (closing) return closing;
    const pending = deferredClose();
    closing = pending.promise;
    closed = true;
    unlisten();
    offShutdown();
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

function managedPromptBinding(
  skillBinding: PromptBinding,
  requiredTools: readonly string[],
): PromptBinding {
  return Object.freeze({
    resolverId: "pi-subagents/workflow-executor@1",
    resourceSetDigest: createHash("sha256").update(JSON.stringify({
      version: 1,
      skills: skillBinding,
      requiredTools: [...requiredTools].sort(),
    })).digest("hex"),
    assetMode: "live",
  });
}

/** Standard resources remain live; this binds only the profile and declared tool preconditions. */
function standardPromptBinding(requiredTools: readonly string[]): PromptBinding {
  return Object.freeze({
    resolverId: "pi-subagents/workflow-standard@1",
    resourceSetDigest: createHash("sha256").update(JSON.stringify({
      version: 1,
      profile: "standard",
      requiredTools: [...requiredTools].sort(),
    })).digest("hex"),
    assetMode: "live",
  });
}

function isDiscovery(data: unknown): data is WorkflowExecutorDiscovery {
  return !!data && typeof data === "object" && (data as WorkflowExecutorDiscovery).version === 1
    && typeof (data as WorkflowExecutorDiscovery).offer === "function";
}

function isBackend(value: unknown): value is ExecutionBackendKind { return value === "embedded" || value === "terminal"; }
function isOptionalProfile(value: unknown): value is WorkflowExecutorProfile | undefined {
  return value === undefined || value === "standard" || value === "managed";
}

function validateRequest(request: WorkflowExecutorRequest): void {
  if (!request || typeof request !== "object" || !request.settings
    || (request.settings.backend !== undefined && !isBackend(request.settings.backend))
    || !isOptionalProfile(request.settings.profile)
    || typeof request.cancellationError !== "function" || !request.observer
    || (request.signal !== undefined && !(request.signal instanceof AbortSignal))
    || (request.observer.signal !== undefined && !(request.observer.signal instanceof AbortSignal))
    || (request.identity !== undefined && (!request.identity || typeof request.identity !== "object"))) throw failure("request");
  const ctx = request.observer as unknown as Partial<ExtensionContext>;
  if (!ctx.modelRegistry || typeof ctx.modelRegistry.find !== "function" || typeof ctx.getSystemPrompt !== "function") throw failure("context");
}

function validateStandardContext(observer: WorkflowExecutorRequest["observer"]): void {
  const ctx = observer as unknown as Partial<ExtensionContext>;
  const runtime = (ctx.modelRegistry as unknown as { runtime?: unknown } | undefined)?.runtime;
  if (typeof ctx.isProjectTrusted !== "function" || !runtime) throw failure("context");
}

function cancellation(request: WorkflowExecutorRequest, signal: AbortSignal): Error {
  try {
    const error = request.cancellationError(signal);
    return error instanceof Error ? error : failure("request");
  } catch (error) { return error instanceof Error ? error : failure("request"); }
}

function failure(key: string): Error { return new Error(i18n.t(`workflowExecutor.${key}`)); }
