import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSessionSnapshot } from "../backends/session-reader.js";
import type { ExecutionBackendKind } from "../backends/session-reference.js";
import { i18n } from "../i18n.js";
import type {
  WorkflowBranchEntry,
  WorkflowExecution,
  WorkflowExecutionProvider,
  WorkflowObserverContext,
  WorkflowRunOptions,
} from "./execution-contract.js";
import {
  StandardWorkflowExecutionHost,
} from "./standard-execution-host.js";
import type {
  StandardWorkflowRuntimeFactory,
  StandardWorkflowRuntimeInitializer,
} from "./standard-resources.js";

export interface StandardWorkflowExecutionProviderOptions {
  getContext(observer: WorkflowObserverContext, run: WorkflowRunOptions): ExtensionContext;
  initializeRuntime?: StandardWorkflowRuntimeInitializer;
  createRuntime?: StandardWorkflowRuntimeFactory;
  backend: ExecutionBackendKind;
  maxConcurrency?: number;
  maxTurns?: number;
  requiredTools?: readonly string[];
  projectTrusted?: boolean;
  cancellationError: (signal: AbortSignal) => Error;
}

export interface StandardWorkflowExecution extends WorkflowExecution {
  readonly host: StandardWorkflowExecutionHost;
  readonly signal: AbortSignal;
  dispose(): void;
  close(): Promise<void>;
}

export interface StandardWorkflowExecutionProvider extends WorkflowExecutionProvider {
  createHost(observer: WorkflowObserverContext, run: WorkflowRunOptions): StandardWorkflowExecution;
}

/** No command/UI registration: the independent workflow package owns the run. */
export function createStandardWorkflowExecutionProvider(
  options: StandardWorkflowExecutionProviderOptions,
): StandardWorkflowExecutionProvider {
  return {
    createHost(observer, input) {
      if (!input?.runId?.trim() || typeof input.childSessionsDir !== "string"
        || !isAbsolute(input.childSessionsDir)) {
        throw new Error(i18n.t("workflowExecution.invalidOptions"));
      }
      const run = Object.freeze({ ...input });
      const ctx = options.getContext(observer, run);
      const host = new StandardWorkflowExecutionHost({
        ctx,
        observer,
        runId: run.runId,
        backend: options.backend,
        childSessionsDir: run.childSessionsDir,
        maxConcurrency: options.maxConcurrency,
        maxTurns: options.maxTurns,
        requiredTools: options.requiredTools,
        projectTrusted: options.projectTrusted,
        initializeRuntime: options.initializeRuntime,
        createRuntime: options.createRuntime,
        signal: observer.signal,
        cancellationError: options.cancellationError,
      });
      return {
        host,
        signal: host.signal,
        dispose: () => { void host.close(); },
        close: () => host.close(),
      };
    },
    readSessionBranch(file): WorkflowBranchEntry[] | undefined {
      try {
        return structuredClone(readSessionSnapshot(file).branch) as WorkflowBranchEntry[];
      } catch {
        return undefined;
      }
    },
  };
}
