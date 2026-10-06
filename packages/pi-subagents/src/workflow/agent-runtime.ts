/** Workflow stages use the same runtime-only Agent tools as terminal children. */
import { createAgentRuntime, type AgentRuntimeOptions } from "../agent-runtime.js";

/** Stage-owned delegates participate in the stage unless background is explicit. */
export function createWorkflowAgentRuntime(options: AgentRuntimeOptions = {}) {
  return createAgentRuntime({ ...options, defaultRunInBackground: options.defaultRunInBackground ?? false });
}
