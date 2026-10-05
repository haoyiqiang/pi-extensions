import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentExecutionBackend, ExecutionSessionSnapshot } from "../backends/types.js";
import { i18n } from "../i18n.js";
import type { CompiledSchema } from "./json-schema.js";
import type {
  ManagedWorkflowExecution, WorkflowBranchEntry, WorkflowExecutionProvider,
  WorkflowModelSelection, WorkflowObserverContext, WorkflowRunOptions,
} from "./execution-contract.js";
import { SubagentWorkflowExecutionHost } from "./execution-host.js";

export interface WorkflowExecutionProviderOptions {
  pi: ExtensionAPI;
  /** Resolve the CURRENT context at host creation; no registry/auth is persisted. */
  getContext(observer: WorkflowObserverContext, run: WorkflowRunOptions): ExtensionContext;
  /** One fresh managed backend per host, shared by every child within that host. */
  createBackend(options: { sessionDir: string; run: WorkflowRunOptions }): AgentExecutionBackend;
  /** Read-only inspection for this provider's backend kind; never open or acquire a writer. */
  inspectSession(file: string): ExecutionSessionSnapshot;
  agentType?: string;
  maxConcurrency?: number;
  maxTurns?: number;
  structuredOutput?: CompiledSchema;
  cancellationError?: (signal: AbortSignal) => Error;
  resolveModel?: (id: { workflow: string; stage: string; skill: string }) => WorkflowModelSelection | undefined;
}

export interface ManagedWorkflowExecutionProvider extends WorkflowExecutionProvider {
  createHost(observer: WorkflowObserverContext, run: WorkflowRunOptions): ManagedWorkflowExecution;
}

/** Private factory only: deliberately no rpiv import, global registration or activation side effects. */
export function createWorkflowExecutionProvider(options: WorkflowExecutionProviderOptions): ManagedWorkflowExecutionProvider {
  options = Object.freeze({ ...options });
  return {
    createHost(observer, input) {
      if (!input?.runId?.trim() || typeof input.childSessionsDir !== "string" || !isAbsolute(input.childSessionsDir)) {
        throw new Error(i18n.t("workflowExecution.invalidOptions"));
      }
      const run = Object.freeze({ ...input });
      // The reference runner prunes top-level *.jsonl without understanding locks/sidecars.
      // Keep managed files beneath its sweep and report their exact paths in session references.
      const sessionDir = join(run.childSessionsDir, "managed");
      assertManagedDirectory(sessionDir);
      const ctx = options.getContext(observer, run);
      const backend = options.createBackend({ sessionDir, run });
      const host = new SubagentWorkflowExecutionHost({
        pi: options.pi, ctx, observer, backend, runId: run.runId, sessionDir,
        agentType: options.agentType, maxConcurrency: options.maxConcurrency,
        maxTurns: options.maxTurns, structuredOutput: options.structuredOutput,
        cancellationError: options.cancellationError,
      });
      return { host, signal: host.signal, dispose: () => { void host.dispose(); }, close: () => host.dispose() };
    },
    ...(options.resolveModel ? { resolveModel: options.resolveModel } : {}),
    readSessionBranch(file): WorkflowBranchEntry[] | undefined {
      try {
        const branch = options.inspectSession(file).branch;
        // Only a consumer-facing narrowing. No envelope synthesis, filtering, or offset changes.
        return structuredClone(branch) as WorkflowBranchEntry[];
      } catch { return undefined; }
    },
  };
}

function assertManagedDirectory(path: string): void {
  try {
    // In particular, a managed -> . symlink would put files back into the unsafe raw sweep.
    if (lstatSync(path).isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  }
  throw new Error(i18n.t("workflowExecution.invalidStorage"));
}
