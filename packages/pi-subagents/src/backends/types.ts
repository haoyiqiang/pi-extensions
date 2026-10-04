import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentType } from "../types.js";
import type { RunOptions, RunResult, resumeAgent } from "./embedded.js";

/**
 * Private extraction seam, not a public terminal/workflow protocol yet.
 * Pi session types remain explicit until the terminal implementation joins.
 * Queues, run IDs, ownership, worktrees, and result delivery belong to the manager.
 */
export interface AgentExecutionBackend {
  readonly kind: "embedded";
  /** Completes when this invocation settles. signal cancels execution, not just waiting. */
  run(ctx: ExtensionContext, type: SubagentType, prompt: string, options: RunOptions): Promise<RunResult>;
  resume(
    session: AgentSession,
    prompt: string,
    options?: Parameters<typeof resumeAgent>[2],
  ): ReturnType<typeof resumeAgent>;
  /** Resolves on delivery; rejects on failure so callers do not report false success. */
  steer(session: AgentSession, message: string): Promise<void>;
  /** Best-effort, idempotent lifecycle shutdown; must settle even if a handler hangs. */
  shutdown(session: AgentSession | undefined): Promise<void>;
}
