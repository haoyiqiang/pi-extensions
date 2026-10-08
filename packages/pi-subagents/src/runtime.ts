import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEmbeddedExecutionBackend } from "./backends/embedded-adapter.js";
import type { ExecutionSession } from "./backends/session.js";
import type { ExecutionBackendKind, PersistentSessionReference } from "./backends/session-reference.js";
import type {
  AgentExecutionBackend,
  ExecutionRestoreOptions,
  ExecutionRunOptions,
  ExecutionRunResult,
  ExecutionSessionSnapshot,
} from "./backends/types.js";
import {
  buildAgentRegistry,
  registerAgents,
  setDefaultsDisabled,
  setFallbackSubagent,
} from "./agent-types.js";
import {
  setDefaultMaxTurns,
  setGraceTurns,
  setRememberAgents,
} from "./agent-runner.js";
import { loadCustomAgents } from "./custom-agents.js";
import { i18n } from "./i18n.js";
import { setScopeModelsEnabled } from "./model-scope.js";
import { setMaxSubagentDepth } from "./nested-tools.js";
import { setOutputTranscriptDefault } from "./output-file.js";
import {
  applySettings,
  loadSettings,
  type SettingsAppliers,
  type SettingsEmit,
  type SubagentBackend,
  type SubagentsConfig,
} from "./settings.js";
import type { AgentConfig } from "./types.js";
import { setWorktreeIsolationEnabled } from "./worktree.js";

let configuredBackend: SubagentBackend = "embedded";

/** Backend preference for one cwd, or the initialized fallback when cwd is absent. */
export function getConfiguredBackend(cwd?: string, options?: { projectTrusted?: boolean }): SubagentBackend {
  return cwd ? loadSettings(cwd, options).backend ?? "embedded" : configuredBackend;
}

/** Update the no-cwd fallback; owned sessions are unaffected. */
export function setConfiguredBackend(backend: SubagentBackend): void {
  configuredBackend = backend;
}

export interface InitializeSubagentsRuntimeOptions {
  /** Instance-local settings, for example an AgentManager's concurrency setters. */
  appliers?: Partial<SettingsAppliers>;
  /** Optional lifecycle outlet. Initialization itself does not load or require UI. */
  emit?: SettingsEmit;
  projectTrusted?: boolean;
  /** Already validated invocation/saved settings; presence suppresses config I/O. */
  settings?: Readonly<SubagentsConfig>;
}

export interface InitializedSubagentsRuntime {
  readonly cwd: string;
  readonly backend: SubagentBackend;
  readonly settings: Readonly<SubagentsConfig>;
  readonly agents: ReadonlyMap<string, AgentConfig>;
}

const COMMON_APPLIERS: Partial<SettingsAppliers> = {
  setDefaultMaxTurns,
  setGraceTurns,
  setScopeModels: setScopeModelsEnabled,
  setDisableDefaultAgents: setDefaultsDisabled,
  setRememberAgents,
  setOutputTranscript: setOutputTranscriptDefault,
  setWorktreeIsolation: setWorktreeIsolationEnabled,
  setMaxSubagentDepth,
  setFallbackSubagent,
};

/** Reset process-wide non-UI state before applying one canonical config view. */
function resetCommonState(): void {
  setDefaultMaxTurns(undefined);
  setGraceTurns(5);
  setScopeModelsEnabled(false);
  setDefaultsDisabled(false);
  setRememberAgents(true);
  setOutputTranscriptDefault(true);
  setWorktreeIsolationEnabled(true);
  setMaxSubagentDepth(2);
  setFallbackSubagent(undefined);
  setConfiguredBackend("embedded");
}

/**
 * Load canonical settings and the shared agent registry without activating the
 * Agent tools, commands, widgets, or other UI. Agent/RPC and standalone
 * workflow entries should call this before constructing execution backends.
 */
export function initializeSubagentsRuntime(
  cwd: string = process.cwd(),
  options: InitializeSubagentsRuntimeOptions = {},
): InitializedSubagentsRuntime {
  const runtimeCwd = resolve(cwd);
  const settings = options.settings ?? loadSettings(runtimeCwd, { projectTrusted: options.projectTrusted });

  resetCommonState();
  applySettings(settings, COMMON_APPLIERS);
  if (options.appliers) applySettings(settings, options.appliers);
  setConfiguredBackend(settings.backend ?? "embedded");

  const strict = settings.strictAgentFiles === true;
  const userAgents = loadCustomAgents(runtimeCwd, strict, { projectTrusted: options.projectTrusted });
  registerAgents(userAgents);
  const agents = buildAgentRegistry(userAgents);

  const snapshot = Object.freeze({ ...settings });
  options.emit?.("subagents:settings_loaded", { settings: snapshot });
  return Object.freeze({
    cwd: runtimeCwd,
    backend: configuredBackend,
    settings: snapshot,
    agents,
  });
}

export { resolveAgentLaunchBehavior, type AgentLaunchOverrides, type ResolvedAgentLaunchBehavior } from "./invocation-config.js";

export type ExecutionBackendFactory = () => AgentExecutionBackend;

export interface ExecutionBackendFactories {
  /** Defaults to the existing embedded adapter. */
  embedded?: ExecutionBackendFactory;
  /** Inject the product's standard terminal factory; absence is an explicit error. */
  terminal?: ExecutionBackendFactory;
}

export interface ExecutionBackendSelectionContext {
  ctx?: ExtensionContext;
  cwd?: string;
  runOptions?: ExecutionRunOptions;
}

export interface ExecutionBackendSelectionOptions extends ExecutionBackendFactories {
  /** Stable fallback for operations that do not carry a run context. */
  cwd?: string;
  /** Read at each fresh run by the router, and once by the pinned factory. */
  selectBackend?: (ctx?: ExtensionContext, cwd?: string, runOptions?: ExecutionRunOptions) => ExecutionBackendKind;
}

export interface InterruptibleExecutionBackend extends AgentExecutionBackend {
  interrupt?(session: ExecutionSession): Promise<void>;
}

export interface RoutedExecutionBackend extends AgentExecutionBackend {
  /** Interrupt the current turn without retiring the conversation. */
  interrupt(session: ExecutionSession): Promise<void>;
  /** Exposed for lifecycle facades that need to display the pinned owner. */
  backendKindFor(session: ExecutionSession): ExecutionBackendKind | undefined;
}

function backendResolver(options: ExecutionBackendSelectionOptions) {
  const factories: Record<ExecutionBackendKind, ExecutionBackendFactory | undefined> = {
    embedded: options.embedded ?? createEmbeddedExecutionBackend,
    terminal: options.terminal,
  };
  const instances = new Map<ExecutionBackendKind, AgentExecutionBackend>();

  const get = (kind: ExecutionBackendKind): AgentExecutionBackend => {
    const existing = instances.get(kind);
    if (existing) return existing;
    const factory = factories[kind];
    if (!factory) {
      throw new Error(i18n.t("terminalBackend.unsupported", { feature: `${kind} backend factory` }));
    }
    const backend = factory();
    if (backend.kind !== kind) throw new Error(i18n.t("managerRestore.backendMismatch"));
    instances.set(kind, backend);
    return backend;
  };

  const selected = (selection: ExecutionBackendSelectionContext = {}): ExecutionBackendKind => {
    const cwd = selection.cwd ?? selection.ctx?.cwd ?? options.cwd;
    if (options.selectBackend) return options.selectBackend(selection.ctx, cwd, selection.runOptions);
    if (selection.runOptions?.runtimePolicy) return selection.runOptions.runtimePolicy.settings.backend ?? "embedded";
    if (selection.runOptions?.extensionDefaults) return selection.runOptions.extensionDefaults.settings.backend ?? "embedded";
    if (cwd) return loadSettings(cwd).backend ?? "embedded";
    return getConfiguredBackend();
  };

  return { get, selected };
}

/**
 * Create one backend pinned to the current preference. Workflow executions use
 * this shape so a run cannot change backend halfway through its child graph.
 */
export function createSelectedExecutionBackend(
  options: ExecutionBackendSelectionOptions = {},
  selection: ExecutionBackendSelectionContext = {},
): AgentExecutionBackend {
  const resolver = backendResolver(options);
  return resolver.get(resolver.selected(selection));
}

/**
 * Create the AgentManager-facing router. Backend selection is read for every
 * fresh run, while resume/control/retirement are dispatched through the backend
 * that created or restored that exact session handle.
 */
export function createRoutedExecutionBackend(
  options: ExecutionBackendSelectionOptions = {},
): RoutedExecutionBackend {
  const resolver = backendResolver(options);
  const owners = new WeakMap<ExecutionSession, AgentExecutionBackend>();

  const remember = (session: ExecutionSession, backend: AgentExecutionBackend): void => {
    if (session.reference.backend !== backend.kind) throw new Error(i18n.t("managerRestore.backendMismatch"));
    const previous = owners.get(session);
    if (previous && previous !== backend) throw new Error(i18n.t("backend.invalidSession"));
    owners.set(session, backend);
  };

  const owner = (session: ExecutionSession): AgentExecutionBackend => {
    const backend = owners.get(session);
    if (!backend) throw new Error(i18n.t("backend.invalidSession"));
    return backend;
  };

  const restore = async (
    mode: "reattach" | "fork",
    reference: PersistentSessionReference,
    restoreOptions?: ExecutionRestoreOptions,
  ): Promise<ExecutionSession> => {
    const backend = resolver.get(reference.backend);
    const operation = backend[mode];
    if (!operation) {
      throw new Error(i18n.t("terminalBackend.unsupported", { feature: `${reference.backend} ${mode}` }));
    }
    const session = await operation.call(backend, reference, restoreOptions);
    remember(session, backend);
    return session;
  };

  return {
    restorationBackends: Object.freeze<ExecutionBackendKind[]>(options.terminal ? ["embedded", "terminal"] : ["embedded"]),
    get kind() {
      return resolver.selected({ cwd: options.cwd });
    },
    run(ctx, type, prompt, runOptions: ExecutionRunOptions): Promise<ExecutionRunResult> {
      const requested = (runOptions as ExecutionRunOptions & { backend?: ExecutionBackendKind }).backend;
      const backend = resolver.get(requested ?? resolver.selected({ ctx, cwd: ctx.cwd, runOptions }));
      const onSessionCreated = runOptions.onSessionCreated;
      return backend.run(ctx, type, prompt, {
        ...runOptions,
        onSessionCreated(session) {
          remember(session, backend);
          onSessionCreated?.(session);
        },
      }).then(result => {
        remember(result.session, backend);
        return result;
      });
    },
    resume(session, prompt, resumeOptions) {
      return owner(session).resume(session, prompt, resumeOptions);
    },
    inspect(sessionFile): ExecutionSessionSnapshot {
      const backend = resolver.get(resolver.selected({ cwd: options.cwd }));
      if (!backend.inspect) {
        throw new Error(i18n.t("terminalBackend.unsupported", { feature: `${backend.kind} inspection` }));
      }
      return backend.inspect(sessionFile);
    },
    reattach(reference, restoreOptions) {
      return restore("reattach", reference, restoreOptions);
    },
    fork(reference, restoreOptions) {
      return restore("fork", reference, restoreOptions);
    },
    steer(session, message) {
      return owner(session).steer(session, message);
    },
    interrupt(session) {
      const backend = owner(session) as InterruptibleExecutionBackend;
      if (!backend.interrupt) {
        return Promise.reject(new Error(i18n.t("terminalBackend.unsupported", { feature: `${backend.kind} turn interruption` })));
      }
      return backend.interrupt(session);
    },
    shutdown(session) {
      // A missing handle has no backend identity. Active invocations still own
      // the abort signal passed to run(), so there is nothing safe to guess here.
      if (!session) return Promise.resolve();
      return owner(session).shutdown(session);
    },
    backendKindFor(session) {
      return owners.get(session)?.kind;
    },
  };
}
