/** Explicit opt-in executor entry; does not register the legacy Agent UI or workflow engine. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowExecutor } from "./src/workflow/pi-executor.js";

export default function workflowExecutor(pi: ExtensionAPI): void {
  registerWorkflowExecutor(pi);
}
