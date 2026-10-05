import type { ModelSelection, WorkflowHostContext } from "./host.js";
import type { BranchEntry } from "./transcript.js";

/** Local mirror of the versioned public executor protocol. No product runtime import. */
export const WORKFLOW_EXECUTOR_DISCOVERY = "pi-workflow:executor:discover:v1";
export const WORKFLOW_EXECUTOR_VERSION = 1 as const;

export type WorkflowExecutorBackend = "embedded" | "terminal";

export interface WorkflowExecutorSkillApproval {
  readonly name: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly format: "pi" | "positional-v1";
  readonly requiredTools?: readonly string[];
  readonly expectedSha256?: string;
}

export interface WorkflowExecutorSettings {
  readonly backend: WorkflowExecutorBackend;
  readonly agentType?: string;
  readonly maxConcurrency?: number;
  readonly maxTurns?: number;
  readonly requiredTools?: readonly string[];
  readonly skills?: readonly WorkflowExecutorSkillApproval[];
}

export interface WorkflowExecutorPromptBinding {
  readonly resolverId: string;
  readonly resourceSetDigest: string;
  readonly assetMode: "live";
}

export interface WorkflowExecutorIdentity {
  readonly version: 1;
  readonly executor: string;
  readonly backend: WorkflowExecutorBackend;
  readonly promptBinding: WorkflowExecutorPromptBinding;
}

export interface WorkflowExecutorRunOptions {
  readonly runId: string;
  readonly childSessionsDir: string;
  readonly name?: string;
  readonly workflow?: string;
  readonly input?: string;
}

export interface WorkflowExecutorRequest {
  /** The real current Pi observer object is forwarded without a wrapper. */
  readonly observer: WorkflowHostContext;
  readonly run: WorkflowExecutorRunOptions;
  readonly settings: WorkflowExecutorSettings;
  readonly cancellationError: (signal: AbortSignal) => Error;
  readonly signal?: AbortSignal;
  readonly identity?: WorkflowExecutorIdentity;
}

export interface WorkflowExecutorExecution {
  readonly host: WorkflowHostContext;
  readonly signal?: AbortSignal;
  readonly identity: WorkflowExecutorIdentity;
  close(): Promise<void>;
  dispose(): void;
  readSessionBranch(file: string): BranchEntry[] | undefined;
  resolveModel?(id: { workflow: string; stage: string; skill: string }): ModelSelection | undefined;
}

export interface WorkflowExecutorOffer {
  readonly version: 1;
  readonly id: string;
  readonly backends: readonly WorkflowExecutorBackend[];
  createExecution(request: WorkflowExecutorRequest): WorkflowExecutorExecution | Promise<WorkflowExecutorExecution>;
}

export interface WorkflowExecutorDiscovery {
  readonly version: 1;
  /** Only calls made synchronously during `events.emit()` are admitted. */
  offer(executor: WorkflowExecutorOffer): void;
}
