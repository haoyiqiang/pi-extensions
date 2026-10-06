import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { resumeAgent as resumeEmbeddedAgent, runAgent as runEmbeddedAgent } from "../agent-runner.js";
import { i18n } from "../i18n.js";
import {
  shutdownEmbeddedSession,
  steerEmbeddedSession,
} from "./embedded-lifecycle.js";
import type { ExecutionSession, SessionViewEvent, TranscriptMessage } from "./session.js";
import type {
  AgentExecutionBackend,
  ExecutionRunOptions,
  ExecutionRestoreOptions,
  ExecutionRunResult,
  ExecutionSessionSnapshot,
} from "./types.js";

import type { PersistentSessionReference } from "./session-reference.js";

export interface EmbeddedExecutionBackendPorts {
  runAgent?: typeof runEmbeddedAgent;
  resumeAgent?: typeof resumeEmbeddedAgent;
  steerEmbeddedSession?: typeof steerEmbeddedSession;
  shutdownEmbeddedSession?: typeof shutdownEmbeddedSession;
  interruptEmbeddedSession?: (session: AgentSession) => Promise<void>;
  reattachSession?: (reference: PersistentSessionReference, options?: ExecutionRestoreOptions) => Promise<AgentSession>;
  forkSession?: (reference: PersistentSessionReference, options?: ExecutionRestoreOptions) => Promise<AgentSession>;
  inspectSession?: (sessionFile: string) => ExecutionSessionSnapshot;
}

const EMPTY_MESSAGES: readonly TranscriptMessage[] = Object.freeze([]);
const EMPTY_STATS = Object.freeze({
  tokens: Object.freeze({ input: 0, output: 0, cacheWrite: 0 }),
  contextUsage: Object.freeze({ percent: null }),
});

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readSessionId(session: AgentSession): string {
  try {
    const sessionId = normalizeString((session as { sessionId?: unknown }).sessionId);
    if (sessionId) return sessionId;
  } catch {
    // Partial test doubles may expose throwing accessors.
  }
  try {
    const sessionId = normalizeString(session.sessionManager?.getSessionId?.());
    if (sessionId) return sessionId;
  } catch {
    // A generated identity keeps partial test doubles usable without exposing them.
  }
  return randomUUID();
}

function readSessionFile(session: AgentSession): string | undefined {
  try {
    const sessionFile = normalizeString((session as { sessionFile?: unknown }).sessionFile);
    if (sessionFile) return sessionFile;
  } catch {
    // Fall through to the manager used by older/partial session shapes.
  }
  try {
    return normalizeString(session.sessionManager?.getSessionFile?.());
  } catch {
    return undefined;
  }
}

function mapSessionEvent(event: AgentSessionEvent): SessionViewEvent {
  if (event.type === "turn_end") return { type: "turn_end" };
  if (event.type === "compaction_start") return { type: "compaction_start" };
  if (event.type === "compaction_end") {
    return {
      type: "compaction_end",
      aborted: event.aborted,
      result: Boolean(event.result),
    };
  }
  return { type: "changed" };
}

/**
 * Adapt native embedded AgentSessions into backend-owned, observation-only handles.
 * Every factory owns its own identity and lifecycle maps; handles are never portable
 * between managers/backends.
 */
export function createEmbeddedExecutionBackend(
  ports: EmbeddedExecutionBackendPorts = {},
): AgentExecutionBackend {
  const runAgent = ports.runAgent ?? ((...args) => runEmbeddedAgent(...args));
  const resumeAgent = ports.resumeAgent ?? ((...args) => resumeEmbeddedAgent(...args));
  const steerSession = ports.steerEmbeddedSession ?? ((...args) => steerEmbeddedSession(...args));
  const shutdownSession = ports.shutdownEmbeddedSession
    ?? ((...args) => shutdownEmbeddedSession(...args));
  const interruptSession = ports.interruptEmbeddedSession ?? ((session: AgentSession) => session.abort());

  const reattachSession = ports.reattachSession;
  const forkSession = ports.forkSession;
  const nativeToHandle = new WeakMap<AgentSession, ExecutionSession>();
  const handleToNative = new WeakMap<ExecutionSession, AgentSession>();
  const closedHandles = new WeakSet<ExecutionSession>();
  const shutdowns = new WeakMap<ExecutionSession, Promise<void>>();
  const subscriptions = new WeakMap<ExecutionSession, Set<() => void>>();

  const wrapSession = (native: AgentSession): ExecutionSession => {
    if (native === null || typeof native !== "object") {
      throw new Error(i18n.t("backend.missingSession"));
    }
    const existing = nativeToHandle.get(native);
    if (existing) return existing;

    const sessionFile = readSessionFile(native);
    const reference = Object.freeze({
      backend: "embedded" as const,
      sessionId: readSessionId(native),
      ...(sessionFile !== undefined ? { sessionFile } : {}),
    });

    let getBranch: ExecutionSession["getBranch"];
    try {
      const manager = native.sessionManager;
      if (typeof manager?.getBranch === "function") getBranch = () => manager.getBranch();
    } catch {
      // Partial test doubles may not expose native branch observations.
    }
    let handle!: ExecutionSession;
    handle = Object.freeze({
      reference,
      ...(getBranch ? { getBranch } : {}),
      get model() {
        const model = native.model;
        if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
          return undefined;
        }
        return Object.freeze({
          provider: model.provider,
          id: model.id,
          ...(typeof model.name === "string" ? { name: model.name } : {}),
        });
      },
      get thinkingLevel() {
        return native.thinkingLevel;
      },
      get messages() {
        const messages = (native as { messages?: unknown }).messages;
        return Array.isArray(messages)
          ? messages as readonly TranscriptMessage[]
          : EMPTY_MESSAGES;
      },
      getSessionStats() {
        try {
          const getSessionStats = (native as { getSessionStats?: unknown }).getSessionStats;
          if (typeof getSessionStats === "function") {
            const stats = getSessionStats.call(native);
            const tokens = stats?.tokens;
            if (
              typeof tokens?.input === "number"
              && typeof tokens.output === "number"
              && typeof tokens.cacheWrite === "number"
            ) {
              return stats;
            }
          }
        } catch {
          // Observation must remain safe for intentionally partial session doubles.
        }
        return EMPTY_STATS;
      },
      subscribe(listener: (event: SessionViewEvent) => void) {
        if (closedHandles.has(handle)) return () => {};

        let active = true;
        let nativeUnsubscribe: (() => void) | undefined;
        const tracked = subscriptions.get(handle) ?? new Set<() => void>();
        subscriptions.set(handle, tracked);

        const unsubscribe = () => {
          if (!active) return;
          active = false;
          tracked.delete(unsubscribe);
          try { nativeUnsubscribe?.(); } catch { /* best-effort listener cleanup */ }
        };
        tracked.add(unsubscribe);

        const nativeSubscribe = (native as { subscribe?: unknown }).subscribe;
        if (typeof nativeSubscribe !== "function") return unsubscribe;
        try {
          const returnedUnsubscribe = nativeSubscribe.call(native, (event: AgentSessionEvent) => {
            if (!active || closedHandles.has(handle)) return;
            listener(mapSessionEvent(event));
          });
          if (typeof returnedUnsubscribe === "function") nativeUnsubscribe = returnedUnsubscribe;
          // A synchronous first callback may have shut the handle down before
          // subscribe() returned its native cleanup function.
          if (!active) {
            try { nativeUnsubscribe?.(); } catch { /* best-effort listener cleanup */ }
          }
        } catch (error) {
          unsubscribe();
          throw error;
        }
        return unsubscribe;
      },
    });

    nativeToHandle.set(native, handle);
    handleToNative.set(handle, native);
    return handle;
  };

  const openNative = (handle: ExecutionSession): AgentSession => {
    const native = handleToNative.get(handle);
    if (!native) throw new Error(i18n.t("backend.invalidSession"));
    if (closedHandles.has(handle)) throw new Error(i18n.t("backend.closedSession"));
    return native;
  };

  const reject = <T>(error: unknown): Promise<T> => Promise.reject(error);

  return {
    kind: "embedded",
    ...(ports.inspectSession ? { inspect: ports.inspectSession } : {}),
    ...(reattachSession ? { reattach: async (reference: PersistentSessionReference, options?: ExecutionRestoreOptions) =>
      wrapSession(await reattachSession(reference, options)) } : {}),
    ...(forkSession ? { fork: async (reference: PersistentSessionReference, options?: ExecutionRestoreOptions) =>
      wrapSession(await forkSession(reference, options)) } : {}),
    run(ctx, type, prompt, options: ExecutionRunOptions): Promise<ExecutionRunResult> {
      const onSessionCreated = options.onSessionCreated;
      const nativeOptions: Parameters<typeof runEmbeddedAgent>[3] = onSessionCreated
        ? {
            ...options,
            onSessionCreated: (session: AgentSession) => onSessionCreated(wrapSession(session)),
          }
        : options as unknown as Parameters<typeof runEmbeddedAgent>[3];
      // A synchronous launch failure belongs to the manager's startup gate, not
      // its later settlement path. Preserve the raw facade's throw/reject timing.
      return runAgent(ctx, type, prompt, nativeOptions).then((result) => ({
        ...result,
        session: wrapSession(result.session),
      }));
    },
    resume(handle, prompt, options) {
      try {
        return resumeAgent(openNative(handle), prompt, options);
      } catch (error) {
        return reject(error);
      }
    },
    steer(handle, message) {
      try {
        return steerSession(openNative(handle), message);
      } catch (error) {
        return reject(error);
      }
    },
    interrupt(handle) {
      try {
        return interruptSession(openNative(handle));
      } catch (error) {
        return reject(error);
      }
    },
    shutdown(handle) {
      if (handle === undefined) {
        try {
          return shutdownSession(undefined);
        } catch (error) {
          return reject(error);
        }
      }

      const native = handleToNative.get(handle);
      if (!native) return reject(new Error(i18n.t("backend.invalidSession")));
      const existing = shutdowns.get(handle);
      if (existing) return existing;
      if (closedHandles.has(handle)) {
        return reject(new Error(i18n.t("backend.closedSession")));
      }

      let resolveShutdown!: () => void;
      let rejectShutdown!: (error: unknown) => void;
      const shutdown = new Promise<void>((resolve, rejectPromise) => {
        resolveShutdown = resolve;
        rejectShutdown = rejectPromise;
      });
      shutdowns.set(handle, shutdown);
      closedHandles.add(handle);

      const tracked = subscriptions.get(handle);
      if (tracked) {
        for (const unsubscribe of [...tracked]) unsubscribe();
        subscriptions.delete(handle);
      }

      try {
        void shutdownSession(native).then(resolveShutdown, rejectShutdown);
      } catch (error) {
        rejectShutdown(error);
      }
      return shutdown;
    },
  };
}
