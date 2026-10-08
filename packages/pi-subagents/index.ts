import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activateSubagents from "./src/index.js";
import { inChildSessionContext } from "./src/child-context.js";
import { createProductExecutionBackend } from "./src/product-backend.js";
import { createWorkflowAgentRuntime } from "./src/workflow/agent-runtime.js";
import { registerWorkflowExecutor } from "./src/workflow/pi-executor.js";

/** One subagent product. Workflow orchestration remains owned by pi-workflow. */
export default function (pi: ExtensionAPI): void {
  if (inChildSessionContext()) return;
  activateSubagents(pi, { legacyWorkflow: false, execution: createProductExecutionBackend() });
  registerWorkflowExecutor(pi, {
    runtimeInitialized: true,
    createRuntime: ({ backend, runtimePolicy }) => createWorkflowAgentRuntime({ backend, runtimePolicy }),
  });
}
