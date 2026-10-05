import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager,
  type AgentSession, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "../child-context.js";
import { i18n } from "../i18n.js";
import type { CompiledSchema } from "../workflow/json-schema.js";
import { createEmbeddedExecutionBackend } from "./embedded-adapter.js";
import {
  createEmbeddedInvocationPolicy, embeddedStructuredTools, invokeEmbeddedSession, rememberEmbeddedPolicy,
  type EmbeddedInvocationOptions, type EmbeddedInvocationResult, type EmbeddedInvocationPolicy,
} from "./embedded-invocation.js";
import type { RunOptions } from "./embedded.js";
import { inspectManagedSession, ManagedSession } from "./managed-session.js";
import { prepareManagedPolicy, type ManagedPolicy } from "./managed-policy.js";
import { modelFingerprint } from "./model-identity.js";
import type { PersistentSessionReference } from "./session-reference.js";
import { sessionWitness } from "./session-witness.js";
import type { AgentExecutionBackend, ExecutionRestoreOptions } from "./types.js";

export interface ManagedEmbeddedConfig {
  agentDir?: string;
  sessionDir?: string;
  shutdownTimeoutMs?: number;
}

/** Trusted SDK injection for offline lifecycle tests, not serialized launch configuration. */
export interface ManagedEmbeddedPorts {
  createSession?: typeof createAgentSession;
}

export const MANAGED_EMBEDDED_CAPABILITIES = Object.freeze({
  isolated: true, fresh: true, resumeOwnedSession: true, reattach: true, fork: true,
  structuredOutput: true, maxTurns: true, steer: true, managedSessionsOnly: true,
  inheritContext: false, crashRecovery: false,
});

type Store = ManagedSession<"embedded">;
interface State {
  native: AgentSession;
  managed: Store;
  tools: string[];
  closed: boolean;
  poisoned: boolean;
  running: boolean;
  controller?: AbortController;
  operation?: Promise<EmbeddedInvocationResult>;
  preparation?: Promise<unknown>;
  controls: Promise<void>[];
  invocationPolicy: EmbeddedInvocationPolicy;
  acceptingSteer: boolean;
  started: boolean;
  shutdown?: Promise<void>;
}
const error = (key: string) => new Error(i18n.t(key));
const validPath = (path: unknown): path is string => typeof path === "string" && path.trim().length > 0 && isAbsolute(path);

function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(error("managedEmbedded.retirementTimeout")), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, failure => { clearTimeout(timer); reject(failure); });
  });
}

/** Cancellation cannot cancel SDK construction itself. A late native session is retired separately. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, late?: (value: T) => void): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const abort = () => { cancelled = true; signal.removeEventListener("abort", abort); reject(signal.reason ?? error("managedEmbedded.cancelled")); };
    promise.then(value => {
      signal.removeEventListener("abort", abort);
      if (cancelled) late?.(value); else resolve(value);
    }, failure => { signal.removeEventListener("abort", abort); if (!cancelled) reject(failure); });
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Private managed profile. The default embedded factory and legacy raw runner remain unchanged. */
export function createManagedEmbeddedExecutionBackend(
  config: ManagedEmbeddedConfig = {}, ports: ManagedEmbeddedPorts = {},
): AgentExecutionBackend {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw error("managedEmbedded.invalidConfig");
  const agentDir = config.agentDir ?? getAgentDir();
  const sessionDir = config.sessionDir ?? (validPath(agentDir) ? join(agentDir, "embedded-subagents", "sessions") : "");
  const shutdownTimeout = config.shutdownTimeoutMs ?? 3_000;
  if (!validPath(agentDir) || !validPath(sessionDir) || !Number.isSafeInteger(shutdownTimeout)
    || shutdownTimeout <= 0 || shutdownTimeout > 2_147_483_647) throw error("managedEmbedded.invalidConfig");
  const createSession = ports.createSession ?? createAgentSession;
  const states = new WeakMap<AgentSession, State>();
  const files = new Map<string, State>();

  const seed = (policy: ManagedPolicy): PersistentSessionReference<"embedded"> => {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const sessionId = randomUUID();
    const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
    const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: policy.cwd };
    writeFileSync(sessionFile, JSON.stringify(header) + "\n", { flag: "wx", mode: 0o600 });
    return Object.freeze({ backend: "embedded", sessionId, sessionFile });
  };
  const runtimeFor = (ctx: ExtensionContext | undefined): AgentSession["modelRuntime"] => {
    const runtime = (ctx?.modelRegistry as unknown as { runtime?: AgentSession["modelRuntime"] } | undefined)?.runtime;
    if (!runtime || typeof runtime.stream !== "function" || typeof runtime.getModel !== "function") throw error("managedEmbedded.contextRequired");
    return runtime;
  };
  const modelFor = (ctx: ExtensionContext | undefined, policy: ManagedPolicy, selected?: Model<any>): Model<any> => {
    runtimeFor(ctx);
    if (!ctx?.modelRegistry || typeof ctx.modelRegistry.find !== "function") throw error("managedEmbedded.contextRequired");
    const model = selected ?? ctx.modelRegistry.find(policy.model.provider, policy.model.id);
    if (!model || model.provider !== policy.model.provider || model.id !== policy.model.id
      || (policy.modelFingerprint !== undefined && modelFingerprint(model) !== policy.modelFingerprint)) throw error("managedEmbedded.modelMismatch");
    return model;
  };
  const assertIdentity = (state: State, allowThinkingClamp = false) => {
    const { native, managed, tools } = state;
    const policy = managed.policy;
    if (native.sessionId !== managed.reference.sessionId || native.sessionFile !== managed.reference.sessionFile
      || resolve(native.sessionManager.getCwd()) !== resolve(policy.cwd)
      || native.model?.provider !== policy.model.provider || native.model?.id !== policy.model.id
      || (policy.modelFingerprint !== undefined && modelFingerprint(native.model) !== policy.modelFingerprint)
      || (!allowThinkingClamp && policy.thinkingLevel !== undefined && native.thinkingLevel !== policy.thinkingLevel)
      || JSON.stringify([...native.getActiveToolNames()].sort()) !== JSON.stringify([...tools].sort())) throw error("managedEmbedded.policyMismatch");
  };
  const hasQueuedInput = (native: AgentSession) => native.agent.hasQueuedMessages() || native.pendingMessageCount !== 0;
  const checkReady = (state: State) => {
    if (state.poisoned) throw error("managedEmbedded.quarantined");
    assertIdentity(state);
    const snapshot = state.managed.readReady();
    if (!state.native.isIdle || hasQueuedInput(state.native) || JSON.stringify(sessionWitness(state.native.sessionManager)) !== JSON.stringify(sessionWitness(snapshot.manager))) {
      throw error("sessionStore.invalidFile");
    }
  };
  const open = (native: AgentSession): State => {
    const state = states.get(native);
    if (!state) throw error("backend.invalidSession");
    if (state.closed) throw error("backend.closedSession");
    return state;
  };

  const retire = (state: State): Promise<void> => {
    if (state.shutdown) return state.shutdown;
    state.closed = true;
    let done!: () => void;
    let failed!: (failure: unknown) => void;
    const shutdown = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    state.shutdown = shutdown;
    // Arm ownership before abort can re-enter lifecycle callbacks.
    state.controller?.abort();
    let disposalAttempted = false;
    const disposeNative = () => {
      if (!disposalAttempted) { disposalAttempted = true; state.native.dispose(); }
    };
    const work = async () => {
      await state.preparation?.catch(() => {});
      await state.operation?.catch(() => {});
      await state.native.abort();
      await state.native.waitForIdle();
      if (!state.native.isIdle) throw error("managedEmbedded.retirementTimeout");
      const runner = state.native.extensionRunner;
      if (runner?.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
    };
    void deadline(work(), shutdownTimeout).then(() => {
      try {
        if (!state.poisoned) checkReady(state);
        disposeNative();
        if (state.poisoned) state.managed.quarantine(); else state.managed.release();
        done();
      } catch (failure) {
        state.poisoned = true;
        state.managed.quarantine();
        try { disposeNative(); } catch { /* ownership remains quarantined */ }
        failed(failure);
      } finally { if (files.get(state.managed.reference.sessionFile) === state) files.delete(state.managed.reference.sessionFile); }
    }, failure => {
      state.poisoned = true;
      state.managed.quarantine();
      try { disposeNative(); } catch { /* never release uncertain writers */ }
      if (files.get(state.managed.reference.sessionFile) === state) files.delete(state.managed.reference.sessionFile);
      failed(failure);
    });
    return shutdown;
  };

  const boot = async (managed: Store, options: ExecutionRestoreOptions, selected?: Model<any>, fresh = false): Promise<State> => {
    let begun = false;
    let state: State | undefined;
    try {
      options.signal?.throwIfAborted();
      const policy = managed.policy;
      const model = modelFor(options.ctx, policy, selected);
      const invocationPolicy = createEmbeddedInvocationPolicy({ maxTurns: policy.maxTurns, graceTurns: policy.graceTurns, structuredOutput: options.structuredOutput });
      if (!isDeepStrictEqual(invocationPolicy.schema?.schema, policy.structuredSchema)) throw error("sessionStore.schemaMismatch");
      const structured = embeddedStructuredTools(invocationPolicy);
      const tools = [...policy.tools, ...structured.map(tool => tool.name)];
      // No discovered resources or settings writes. Idle cache warming would mutate checkpoints.
      const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
      const loader = new DefaultResourceLoader({
        cwd: policy.cwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPromptOverride: () => policy.systemPrompt, appendSystemPromptOverride: () => [],
      });
      await abortable(runInChildSessionContext(() => loader.reload()), options.signal);
      options.signal?.throwIfAborted();
      managed.beginRun(randomUUID());
      begun = true;
      // Only our already-validated v3 file is opened, with a lifetime writer lease held.
      const manager = SessionManager.open(managed.reference.sessionFile, dirname(managed.reference.sessionFile), policy.cwd);
      const runtime = runtimeFor(options.ctx);
      const creating = runInChildSessionContext(() => createSession({
        cwd: policy.cwd, agentDir, sessionManager: manager, settingsManager, resourceLoader: loader,
        model, modelRuntime: runtime, tools, customTools: structured,
        ...(policy.thinkingLevel !== undefined ? { thinkingLevel: policy.thinkingLevel } : {}),
      }));
      const createState = (native: AgentSession): State => ({ native, managed, tools, invocationPolicy,
        closed: false, poisoned: false, running: false, controls: [], acceptingSteer: false, started: false });
      const { session: native } = await abortable(creating, options.signal, ({ session }) => {
        const late = createState(session);
        late.poisoned = true;
        void retire(late).catch(() => {});
      });
      state = createState(native);
      rememberEmbeddedPolicy(native, invocationPolicy);
      state.preparation = native.bindExtensions({});
      await abortable(state.preparation, options.signal);
      native.setActiveToolsByName(tools);
      assertIdentity(state, fresh);
      if (fresh) native.setSessionName(policy.name);
      await abortable(native.waitForIdle(), options.signal);
      options.signal?.throwIfAborted();
      managed.checkpoint(native.thinkingLevel, sessionWitness(native.sessionManager));
      states.set(native, state);
      files.set(managed.reference.sessionFile, state);
      return state;
    } catch (failure) {
      if (begun) managed.quarantine();
      if (state) { state.poisoned = true; await retire(state).catch(() => {}); }
      else if (!begun) { try { managed.release(); } catch { managed.quarantine(); } }
      throw failure;
    }
  };

  const invoke = (state: State, prompt: string, options: EmbeddedInvocationOptions = {}, onStarted?: () => void): Promise<EmbeddedInvocationResult> => {
    if (state.closed) return Promise.reject(error("backend.closedSession"));
    if (state.running) return Promise.reject(error("invocation.busy"));
    if (state.poisoned) return Promise.reject(error("managedEmbedded.quarantined"));
    state.running = true;
    state.controls = [];
    state.acceptingSteer = false;
    state.started = false;
    const controller = new AbortController();
    state.controller = controller;
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    let unsubscribe: (() => void) | undefined;
    try {
      if (!controller.signal.aborted) {
        checkReady(state);
        state.managed.beginRun(randomUUID());
        // Early steering is admitted only after the writer transaction is reserved.
        state.acceptingSteer = true;
        unsubscribe = state.native.subscribe(event => { if (event.type === "agent_start") state.started = true; });
      }
    } catch (failure) {
      options.signal?.removeEventListener("abort", abort);
      state.running = false;
      state.acceptingSteer = false;
      state.controller = undefined;
      state.poisoned = true;
      state.managed.quarantine();
      return Promise.reject(failure);
    }
    // Defer execution so onStarted can shut down a handle without losing its in-flight promise.
    const operation = Promise.resolve().then(async () => {
      try {
        if (!unsubscribe) return { text: "", aborted: true, steered: false };
        const result: EmbeddedInvocationResult = controller.signal.aborted
          ? { text: "", aborted: true, steered: false }
          : await invokeEmbeddedSession(state.native, prompt, { ...options, signal: controller.signal }, onStarted);
        state.acceptingSteer = false;
        for (let index = 0; index < state.controls.length; index++) await state.controls[index];
        await state.native.waitForIdle();
        if (state.poisoned) throw error("managedEmbedded.quarantined");
        assertIdentity(state);
        if (!state.native.isIdle) throw error("managedEmbedded.retirementTimeout");
        // SDK abort leaves undelivered steer/follow-up queues intact. They belong to this invocation.
        if ((result.aborted || result.failure) && hasQueuedInput(state.native)) state.native.clearQueue();
        if (hasQueuedInput(state.native)) throw error("managedEmbedded.policyMismatch");
        state.managed.checkpoint(state.native.thinkingLevel, sessionWitness(state.native.sessionManager));
        return result;
      } catch (failure) {
        state.poisoned = true;
        state.managed.quarantine();
        throw failure;
      } finally {
        options.signal?.removeEventListener("abort", abort);
        unsubscribe?.();
        state.running = false;
        state.acceptingSteer = false;
        state.controller = undefined;
      }
    });
    state.operation = operation;
    return operation;
  };

  const ownedReference = (reference: PersistentSessionReference): State | undefined => {
    if (!reference || reference.backend !== "embedded" || !validPath(reference.sessionFile)
      || typeof reference.sessionId !== "string" || !reference.sessionId.trim()) throw error("sessionStore.invalidRecord");
    let path: string;
    try { path = realpathSync(reference.sessionFile); } catch { throw error("sessionStore.invalidFile"); }
    const state = files.get(path);
    if (state && reference.sessionId !== state.managed.reference.sessionId) throw error("sessionStore.invalidRecord");
    return state;
  };

  return createEmbeddedExecutionBackend({
    inspectSession: (file) => inspectManagedSession(file, "embedded"),
    async runAgent(ctx, type, prompt, options: RunOptions) {
      options.signal?.throwIfAborted();
      runtimeFor(ctx);
      // Capture both wire data and validator binding before environment preparation can yield.
      const structuredOutput = createEmbeddedInvocationPolicy({ structuredOutput: options.structuredOutput }).schema;
      const policy = await prepareManagedPolicy(ctx, type, { ...options, structuredOutput, onSessionCreated: undefined }, "managedEmbedded");
      options.signal?.throwIfAborted();
      const managed = ManagedSession.create(policy, seed);
      const state = await boot(managed, { ctx, structuredOutput, signal: options.signal }, options.model, true);
      try {
        const { text, ...result } = await invoke(state, prompt, options, () => options.onSessionCreated?.(state.native));
        return { responseText: text, session: state.native, ...result };
      } catch (failure) { await retire(state).catch(() => {}); throw failure; }
    },
    async reattachSession(reference, options = {}) {
      options.signal?.throwIfAborted();
      if (ownedReference(reference)) throw error("sessionStore.alreadyOwned");
      return (await boot(ManagedSession.open(reference, "embedded", options), options)).native;
    },
    async forkSession(reference, options = {}) {
      options.signal?.throwIfAborted();
      const owned = ownedReference(reference);
      if (owned?.running) throw error("invocation.busy");
      if (owned?.closed) throw error("backend.closedSession");
      if (owned) checkReady(owned);
      const source = owned?.managed ?? ManagedSession.open(reference, "embedded", options);
      let forked: Store | undefined;
      try {
        modelFor(options.ctx, source.policy);
        forked = source.fork(seed, options);
      } finally {
        if (!owned) {
          try { source.release(); }
          catch (failure) { try { forked?.release(); } catch { forked?.quarantine(); } throw failure; }
        }
      }
      return (await boot(forked, options)).native;
    },
    resumeAgent(native, prompt, options) { return invoke(open(native), prompt, options); },
    async steerEmbeddedSession(native, text) {
      const state = open(native);
      if (!state.running || !state.acceptingSteer || state.poisoned || state.controller?.signal.aborted
        || (state.started && !native.isStreaming) || (native.isStreaming && native.agent.signal?.aborted)
        || state.invocationPolicy.active?.stopping || state.invocationPolicy.active?.finished
        || typeof text !== "string" || !text.trim()) throw error("invocation.notRunning");
      // Literal control input must not finish async command/template expansion in a later run.
      const delivery = native.sendCustomMessage({ customType: "pi-subagents-steer", content: text, display: true }, { deliverAs: "steer" }).catch(failure => {
        state.poisoned = true;
        state.managed.quarantine();
        state.controller?.abort();
        throw failure;
      });
      state.controls.push(delivery);
      await delivery;
    },
    shutdownEmbeddedSession(native) {
      if (!native) return Promise.resolve();
      const state = states.get(native);
      return state ? retire(state) : Promise.reject(error("backend.invalidSession"));
    },
  });
}
