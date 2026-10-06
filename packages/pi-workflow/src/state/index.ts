/**
 * JSONL state public surface. Internal layout lives in `state.ts`'s
 * header; this barrel re-exports only the symbols the rest of the
 * package consumes.
 */

export type {
	ClaimResult,
	LoopCapRow,
	NamesIndex,
	RoutingDecision,
	RunRecap,
	RunSummary,
	RunTerminalRow,
	SessionRef,
	StageStatus,
	WorkflowHeader,
	WorkflowStage,
} from "./state.js";
export {
	appendHeader,
	appendLoopCap,
	appendRoutingDecision,
	appendRunTerminal,
	appendStage,
	claimName,
	generateRunId,
	isValidName,
	listArtifacts,
	listRuns,
	MAX_NAME_LENGTH,
	namesFilePath,
	readAllStages,
	readAllStagesForResume,
	readHeader,
	readLastStage,
	readLoopCaps,
	readNamesIndex,
	readRoutingDecisions,
	readRunTerminal,
	rebuildIndex,
	releaseName,
	resolveRun,
	runFileFor,
	runsDir,
	STATE_SCHEMA_VERSION,
	stateFilePath,
	summarizeRun,
	VALID_NAME,
} from "./state.js";
