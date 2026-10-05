import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentType } from "../types.js";
import type { RunOptions, RunResult, resumeAgent } from "./embedded.js";
import type { ExecutionBackendKind, PersistentSessionReference } from "./session-reference.js";
import type { CompiledSchema } from "../workflow/json-schema.js";
import type { ExecutionSession, SessionBranchEntry } from "./session.js";
import type { ManagedPolicy } from "./managed-policy.js";
import type { PromptBinding } from "./prompt-binding.js";

export type ExecutionRunOptions = Omit<RunOptions, "onSessionCreated"> & {
  onSessionCreated?: (session: ExecutionSession) => void;
};
export type ExecutionRunResult = Omit<RunResult, "session"> & { session: ExecutionSession };
export type ExecutionResumeOptions = Parameters<typeof resumeAgent>[2];
export interface ExecutionRestoreOptions {
  /** Expected saved resolver/resource identity. Presence must also match. */
  promptBinding?: PromptBinding;
  /** Embedded restoration rebinds the current model runtime/auth; never persisted. */
  ctx?: ExtensionContext;
  signal?: AbortSignal;
  /** Re-supply non-serializable caller validation for structured managed sessions. */
  structuredOutput?: CompiledSchema;
}
/** Validated read-only managed source; inspection never acquires writer ownership. */
export interface ExecutionSessionSnapshot {
  readonly reference: PersistentSessionReference;
  readonly policy: ManagedPolicy;
  readonly branch: readonly SessionBranchEntry[];
}
export interface ExecutionResumeResult {
  text: string;
  failure?: string;
  aborted?: boolean;
  steered?: boolean;
  structuredJson?: string;
  structuredRetried?: boolean;
}

/**
 * Private execution port. Session controls are opaque; request preparation still uses Pi context.
 * Queues, agent IDs, ownership, worktrees, and result delivery belong to the manager.
 */
export interface AgentExecutionBackend {
  readonly kind: ExecutionBackendKind;
  /** Completes when this invocation settles. signal cancels execution, not just waiting. */
  run(ctx: ExtensionContext, type: SubagentType, prompt: string, options: ExecutionRunOptions): Promise<ExecutionRunResult>;
  resume(session: ExecutionSession, prompt: string, options?: ExecutionResumeOptions): Promise<ExecutionResumeResult>;
  /** Resolve a managed source file without opening, repairing or acquiring its lease. */
  inspect?(sessionFile: string): ExecutionSessionSnapshot;
  /** Optional private managed-session restoration. These operations return idle handles. */
  reattach?(reference: PersistentSessionReference, options?: ExecutionRestoreOptions): Promise<ExecutionSession>;
  fork?(reference: PersistentSessionReference, options?: ExecutionRestoreOptions): Promise<ExecutionSession>;
  /** Resolves on delivery; rejects on failure so callers do not report false success. */
  steer(session: ExecutionSession, message: string): Promise<void>;
  /** Best-effort, idempotent lifecycle shutdown; must settle even if a handler hangs. */
  shutdown(session: ExecutionSession | undefined): Promise<void>;
}
