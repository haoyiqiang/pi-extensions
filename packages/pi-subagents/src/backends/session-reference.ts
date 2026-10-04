/** Data-only identities. A new invocation must not masquerade as a new conversation. */
export type ExecutionBackendKind = "embedded" | "terminal";

export interface SessionReference<Backend extends ExecutionBackendKind = ExecutionBackendKind> {
  readonly backend: Backend;
  readonly sessionId: string;
  /** Absent only for embedded in-memory conversations. */
  readonly sessionFile?: string;
}

export interface PersistentSessionReference<Backend extends ExecutionBackendKind = ExecutionBackendKind>
  extends SessionReference<Backend> {
  readonly sessionFile: string;
}

export interface RunReference<Backend extends ExecutionBackendKind = ExecutionBackendKind> {
  /** Coordinator-assigned invocation ID; changes on resume, unlike the session identity. */
  readonly runId: string;
  readonly session: Backend extends "terminal"
    ? PersistentSessionReference<Backend>
    : SessionReference<Backend>;
}
