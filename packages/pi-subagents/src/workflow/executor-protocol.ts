import type { PromptBinding } from "../backends/prompt-binding.js";
import type { ExecutionBackendKind } from "../backends/session-reference.js";
import type { ManagedWorkflowExecution, WorkflowBranchEntry, WorkflowObserverContext, WorkflowRunOptions } from "./execution-contract.js";
import type { WorkflowSkillApproval } from "./skill-resources.js";

/** Public in-process protocol. No product imports, private global slots or implicit registration. */
export const WORKFLOW_EXECUTOR_DISCOVERY = "pi-workflow:executor:discover:v1";
export const WORKFLOW_EXECUTOR_VERSION = 1 as const;
export const SUBAGENT_EXECUTOR_ID = "pi-subagents";

export interface WorkflowExecutorSettings {
  readonly backend: ExecutionBackendKind;
  readonly agentType?: string;
  readonly maxConcurrency?: number;
  readonly maxTurns?: number;
  readonly requiredTools?: readonly string[];
  readonly skills?: readonly WorkflowSkillApproval[];
}

export interface WorkflowExecutorIdentity {
  readonly version: 1;
  readonly executor: string;
  readonly backend: ExecutionBackendKind;
  readonly promptBinding: PromptBinding;
}

export interface WorkflowExecutorRequest {
  readonly observer: WorkflowObserverContext;
  readonly run: WorkflowRunOptions;
  readonly settings: WorkflowExecutorSettings;
  /** Supplied by the executing consumer, not imported from another module instance. */
  readonly cancellationError: (signal: AbortSignal) => Error;
  readonly signal?: AbortSignal;
  /** Persisted run identity: backend stays sticky and resource changes reject on resume. */
  readonly identity?: WorkflowExecutorIdentity;
}

export interface WorkflowExecutorExecution extends ManagedWorkflowExecution {
  readonly identity: WorkflowExecutorIdentity;
  readSessionBranch(file: string): WorkflowBranchEntry[] | undefined;
}

export interface WorkflowExecutorOffer {
  readonly version: 1;
  readonly id: string;
  readonly backends: readonly ExecutionBackendKind[];
  createExecution(request: WorkflowExecutorRequest): WorkflowExecutorExecution | Promise<WorkflowExecutorExecution>;
}

export interface WorkflowExecutorDiscovery {
  readonly version: 1;
  /** Only synchronous offers within this discovery turn are admitted by the consumer. */
  offer(executor: WorkflowExecutorOffer): void;
}
