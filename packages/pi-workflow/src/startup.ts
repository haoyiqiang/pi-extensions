/**
 * rpiv-workflow — ultra-thin startup-registration entry (~9ms): only the
 * lifecycle + built-in registrars a sibling wires up at extension load, with no
 * loader/DSL/runner graph. Pair `registerBuiltInsProvider` with a thunk that
 * dynamically imports your definitions so they build on first `/wf`, not startup.
 */

export { registerBuiltIns, registerBuiltInsProvider } from "./built-ins.js";
export { registerLifecycle } from "./events.js";
export {
	registerWorkflowExecutionHost,
	type UnregisterWorkflowExecutionHost,
	type WorkflowExecution,
	type WorkflowExecutionIdentity,
	type WorkflowExecutionProvider,
} from "./execution-host.js";
export { createWorkflowCancellationError, workflowCancellationError } from "./internal-utils.js";
export {
	getBucketKindMappings,
	registerBucketKindMapping,
	registerCompositionComparator,
	registerOutcomeDeriver,
	registerSkillContracts,
	registerSkillContractsProvider,
} from "./skill-contracts/index.js";
export { summarizeRun } from "./state/index.js";
