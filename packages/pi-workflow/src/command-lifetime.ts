import type { WorkflowHostContext } from "./host.js";

/** Internal command-to-run handoff; does not change the public workflow host API. */
export const COMMAND_LIFETIME = Symbol.for("pi-workflow.command-lifetime");

export interface CommandLifetime {
  track(run: Promise<unknown>): void;
}

/** Keep /wf cancellation attached to the whole floated run, not only its executor. */
export function trackCommandRun<T>(ctx: WorkflowHostContext, run: Promise<T>): Promise<T> {
  (ctx as WorkflowHostContext & { [COMMAND_LIFETIME]?: CommandLifetime })[COMMAND_LIFETIME]?.track(run);
  return run;
}
