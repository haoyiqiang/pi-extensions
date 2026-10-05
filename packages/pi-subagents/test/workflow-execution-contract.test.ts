import { expectTypeOf, it } from "vitest";
import type {
  ManagedWorkflowExecution, ManagedWorkflowHost,
  ManagedWorkflowSessionContext, WorkflowModelSelection,
} from "../src/workflow/execution-contract.js";
import type { ManagedWorkflowExecutionProvider as Provider } from "../src/workflow/execution-provider.js";

// Structural fixture for rpiv-workflow 2.12.0, commit 68d9a0014b70006d7b04b57933752338a2716db7.
// Adapted from host.ts/execution-host.ts; attribution: docs/LICENSE.rpiv-workflow.
// No checkout path, installed rpiv package, Pi 0.80.6 dependency or runner registration.
type Selection = { model?: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
interface ConsumerHost {
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
  readonly maxConcurrency: number;
  spawnChild<T>(options: {
    prompt: string;
    model?: Selection;
    signal?: AbortSignal;
    reattach?: { sessionFile: string };
    fork?: { sessionFile: string };
    unitIndex?: number;
    withSession: (child: ConsumerSession) => Promise<T>;
  }): Promise<T>;
}
interface ConsumerSession extends ConsumerHost {
  sendUserMessage(content: string): Promise<void>;
  toolTimeout?(): { reason: string } | undefined;
  resetToolTimeout?(): void;
}
interface ConsumerExecution { host: ConsumerHost; signal?: AbortSignal; dispose?: () => void }
interface ConsumerProvider {
  createHost(observer: ConsumerHost, options: {
    runId: string; childSessionsDir: string; name?: string; workflow?: string; input?: string;
  }): ConsumerExecution | Promise<ConsumerExecution>;
  resolveModel?(id: { workflow: string; stage: string; skill: string }): Selection | undefined;
  readSessionBranch?(file: string): {
    type: string;
    message?: {
      role?: string;
      content?: { type: string; text?: string; name?: string; input?: Record<string, unknown>; arguments?: Record<string, unknown> }[];
      stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
    };
  }[] | undefined;
}

it("keeps the private provider structurally assignable without confusing shape with capability parity", () => {
  expectTypeOf<WorkflowModelSelection>().toEqualTypeOf<Selection>();
  expectTypeOf<ManagedWorkflowHost>().toExtend<ConsumerHost>();
  expectTypeOf<ManagedWorkflowSessionContext>().toExtend<ConsumerSession>();
  expectTypeOf<ManagedWorkflowExecution>().toExtend<ConsumerExecution>();
  expectTypeOf<Provider>().toExtend<ConsumerProvider>();
});
