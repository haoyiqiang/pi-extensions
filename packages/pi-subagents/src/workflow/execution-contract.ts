import type { EffectiveThinkingLevel } from "../types.js";
import type { PersistentSessionReference } from "../backends/session-reference.js";

/** Private, structurally compatible with the rpiv-workflow host seam; see docs/workflow-execution.md. */
export interface WorkflowModelSelection {
  model?: string;
  thinking?: EffectiveThinkingLevel;
}

/** Consumer narrowing only. Raw entry fields, tool arguments and metadata are never projected away. */
export interface WorkflowBranchEntry {
  type: string;
  message?: {
    role?: string;
    content?: { type: string; text?: string; name?: string; input?: Record<string, unknown>; arguments?: Record<string, unknown> }[];
    stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  };
}

export interface WorkflowObserverContext {
  cwd: string;
  hasUI: boolean;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  sessionManager: {
    getBranch(): unknown;
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
  waitForIdle(): Promise<void>;
  signal?: AbortSignal;
}

export interface WorkflowChildOptions<T> {
  prompt: string;
  model?: WorkflowModelSelection;
  signal?: AbortSignal;
  reattach?: { sessionFile: string };
  fork?: { sessionFile: string };
  unitIndex?: number;
  withSession: (child: WorkflowSessionContext) => Promise<T>;
}

export interface WorkflowHostContext extends WorkflowObserverContext {
  /** Bounds active calls, NOT callback lifetimes. Routing may recurse inside withSession. */
  readonly maxConcurrency: number;
  spawnChild<T>(options: WorkflowChildOptions<T>): Promise<T>;
}

export interface WorkflowSessionContext extends WorkflowHostContext {
  /** Idle-only, one new invocation. Concurrent sends reject rather than becoming steer. */
  sendUserMessage(content: string): Promise<void>;
  toolTimeout?(): { reason: string } | undefined;
  resetToolTimeout?(): void;
}

export type ManagedWorkflowChildOptions<T> = Omit<WorkflowChildOptions<T>, "withSession"> & {
  withSession: (child: ManagedWorkflowSessionContext) => Promise<T>;
};

/** Local additions are not required of an external workflow consumer. */
export interface ManagedWorkflowSessionContext extends WorkflowSessionContext {
  readonly reference: PersistentSessionReference;
  abort(): Promise<void>;
}

export interface WorkflowRunOptions {
  runId: string;
  childSessionsDir: string;
  name?: string;
  workflow?: string;
  input?: string;
}

export interface WorkflowExecution {
  host: WorkflowHostContext;
  signal?: AbortSignal;
  /** Synchronous admission closure/cancellation, matching consumers that do not await dispose. */
  dispose?: () => void;
}

export interface ManagedWorkflowExecution extends WorkflowExecution {
  host: ManagedWorkflowHost;
  signal: AbortSignal;
  dispose(): void;
  /** Explicit awaited teardown barrier; the reference workflow runner does not await it. */
  close(): Promise<void>;
}

export interface ManagedWorkflowHost extends WorkflowHostContext {
  spawnChild<T>(options: ManagedWorkflowChildOptions<T>): Promise<T>;
  readonly capabilities: typeof WORKFLOW_EXECUTION_CAPABILITIES;
  dispose(): Promise<void>;
}

export interface WorkflowExecutionProvider {
  createHost(observer: WorkflowHostContext, options: WorkflowRunOptions): WorkflowExecution | Promise<WorkflowExecution>;
  resolveModel?(id: { workflow: string; stage: string; skill: string }): WorkflowModelSelection | undefined;
  readSessionBranch?(file: string): WorkflowBranchEntry[] | undefined;
}

export const WORKFLOW_EXECUTION_CAPABILITIES = Object.freeze({
  isolated: true,
  persistent: true,
  managedSessionsOnly: true,
  fresh: true,
  reattach: true,
  fork: true,
  rawBranch: true,
  plainPromptsOnly: true,
  restoredPolicyOverrides: false,
  nestedChildren: false,
  toolTimeoutRecovery: false,
  crashRecovery: false,
  consumerAbortBridgeRequired: true,
} as const);
