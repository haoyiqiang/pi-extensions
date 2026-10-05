import type { ProgressValue } from "./api.js";
import { i18n } from "./i18n.js";
import { MAX_NAME_LENGTH } from "./state/index.js";

export interface FailureText {
  toast: string;
  error: string;
}

const failure = (
  toastKey: string,
  errorKey: string,
  params?: Record<string, string | number>,
): FailureText => ({ toast: i18n.t(toastKey, params), error: i18n.t(errorKey, params) });

export const MSG_STAGE_FAILED = (skill: string) => i18n.t("messages.stageFailed", { skill });
export const FAIL_STAGE_ABORTED = (skill: string): FailureText =>
  failure("messages.stageAbortedToast", "messages.stageAbortedError", { skill });
export const FAIL_STAGE_TRUNCATED = (skill: string): FailureText =>
  failure("messages.stageTruncatedToast", "messages.stageTruncatedError", { skill });
export const FAIL_STAGE_TOOL_STALLED = (skill: string): FailureText =>
  failure("messages.stageToolStalledToast", "messages.stageToolStalledError", { skill });
export const FAIL_STAGE_NO_RESPONSE = (skill: string): FailureText =>
  failure("messages.stageNoResponseToast", "messages.stageNoResponseError", { skill });

export const MSG_WORKFLOW_COMPLETE = (stages: number) => i18n.t("messages.workflowComplete", { stages });
export const MSG_WORKFLOW_CANCELLED = i18n.t("messages.workflowCancelled");
export const FAIL_WORKFLOW_ABORTED = (stage: string): FailureText =>
  failure("messages.workflowAbortedToast", "messages.workflowAbortedError", { stage });
export const FAIL_VALIDATION_EXHAUSTED = (skill: string, failures: string): FailureText =>
  failure("messages.validationExhaustedToast", "messages.validationExhaustedError", { skill, failures });
export const ERR_VALIDATE_RETRY_UNCHANGED = (skill: string) =>
  i18n.t("messages.validateRetryUnchanged", { skill });
export const FAIL_VALIDATE_GATE_SKIPPED = (skill: string): FailureText =>
  failure("messages.validateGateSkippedToast", "messages.validateGateSkippedError", { skill });
export const FAIL_INPUT_VALIDATION = (currentSkill: string, prevSkill: string, failures: string): FailureText =>
  failure("messages.inputValidationToast", "messages.inputValidationError", { currentSkill, prevSkill, failures });
export const ERR_SCHEMA_TIMEOUT = (slot: "outputSchema" | "inputSchema", ms: number) =>
  i18n.t("messages.schemaTimeout", { slot, ms });
export const FAIL_MISSING_ARTIFACT = (currentSkill: string, stageNumber: number): FailureText =>
  failure("messages.missingArtifactToast", "messages.missingArtifactError", { currentSkill, stageNumber });
export const FAIL_MISSING_NAMED_READ = (currentSkill: string, name: string, stageNumber: number): FailureText =>
  failure("messages.missingNamedReadToast", "messages.missingNamedReadError", { currentSkill, name, stageNumber });

export type BackwardJumpLimitKind = "cap" | "ceiling";
export interface BackwardJumpHaltInfo {
  stage: string;
  limitKind: BackwardJumpLimitKind;
  count: number;
  max: number;
  progress: readonly ProgressValue[];
}

/** Stable machine-readable prefix used by external replay tooling. */
export const BACKWARD_JUMP_LIMIT_HEAD = i18n.t("messages.backwardJumpHead");
const backwardJumpProgressClause = (progress: readonly ProgressValue[]): string =>
  progress.length > 0 ? i18n.t("messages.backwardJumpProgress", { progress: progress.join(", ") }) : "";

export const FAIL_BACKWARD_JUMP_EXHAUSTED = (info: BackwardJumpHaltInfo): FailureText => {
  const params = {
    stage: info.stage,
    count: info.count,
    max: info.max,
    clause: backwardJumpProgressClause(info.progress),
    head: BACKWARD_JUMP_LIMIT_HEAD,
  };
  return info.limitKind === "ceiling"
    ? failure("messages.backwardJumpCeilingToast", "messages.backwardJumpCeilingError", params)
    : failure("messages.backwardJumpCapToast", "messages.backwardJumpCapError", params);
};

export const FAIL_GATE_STOP = (stage: string, note: string, runId: string): FailureText =>
  failure("messages.gateStopToast", "messages.gateStopError", { stage, note, runId });
export const MSG_LOOP_ZERO_UNITS = (skill: string) => i18n.t("messages.loopZeroUnits", { skill });
export const FAIL_LOOP_CAP_HALT = (count: number, max: number): FailureText =>
  failure("messages.loopCapHaltToast", "messages.loopCapHaltError", { count, max });
export const FAIL_FANOUT_ALL_FAILED = (skill: string, failed: number, total: number): FailureText =>
  failure("messages.fanoutAllFailedToast", "messages.fanoutAllFailedError", { skill, failed, total });
export const MSG_LOOP_CAP_ADVANCE = (skill: string, max: number) =>
  i18n.t("messages.loopCapAdvance", { skill, max });
export const FAIL_VERIFY_FAILED = (stage: string, attempts: number): FailureText => {
  const key = attempts === 1 ? "messages.verifyFailedOne" : "messages.verifyFailedMany";
  const errorKey = attempts === 1 ? "messages.verifyFailedErrorOne" : "messages.verifyFailedErrorMany";
  return failure(key, errorKey, { stage, attempts });
};
export const FAIL_AUDIT_WRITE = (skill: string): FailureText =>
  failure("messages.auditWriteToast", "messages.auditWriteError", { skill });
export const MSG_FAILURE_ROW_DROPPED = (stage: string) => i18n.t("messages.failureRowDropped", { stage });
export const MSG_CHAIN_ADVANCE_FAILED = (fromStage: string, reason: string) =>
  i18n.t("messages.chainAdvanceFailed", { fromStage, reason });
export const MSG_STAGE_THREW = (skill: string, reason: string) => i18n.t("messages.stageThrew", { skill, reason });
export const MSG_LOOP_CURSOR_CORRUPT = (stage: string, detail: string) =>
  i18n.t("messages.loopCursorCorrupt", { stage, detail });
export const ERR_COLLECTOR_THREW = (skill: string, reason: string) =>
  i18n.t("messages.collectorThrew", { skill, reason });
export const ERR_PARSER_THREW = (skill: string, reason: string) =>
  i18n.t("messages.parserThrew", { skill, reason });
export const FAIL_SKILL_NOT_REGISTERED = (skill: string, stageNumber: number): FailureText =>
  failure("messages.skillNotRegisteredToast", "messages.skillNotRegisteredError", { skill, stageNumber });
export const MSG_ROUTING_AUDIT_DROPPED = (fromStage: string, decision: string) =>
  i18n.t("messages.routingAuditDropped", { fromStage, decision });
export const MSG_PARTIAL_ARTIFACTS = (artifactList: string) =>
  i18n.t("messages.partialArtifacts", { artifactList });
export const MSG_LIFECYCLE_THREW = (event: string, reason: string) =>
  i18n.t("messages.lifecycleThrew", { event, reason });
export const MSG_SNAPSHOT_FAILED = (stage: string, reason: string) =>
  i18n.t("messages.snapshotFailed", { stage, reason });
export const FAIL_SCRIPT_THREW = (stage: string, reason: string): FailureText =>
  failure("messages.scriptThrewToast", "messages.scriptThrewError", { stage, reason });

export const ERR_RESUME_NO_ROWS = (runId: string) => i18n.t("messages.resumeNoRows", { runId });
export const ERR_RESUME_MALFORMED_ROW = (detail: string) => i18n.t("messages.resumeMalformedRow", { detail });
export const ERR_RESUME_VERSION_MISMATCH = (detail: string, expected: number) =>
  i18n.t("messages.resumeVersionMismatch", { detail, expected });
export const ERR_RESUME_STAGE_GONE = (stage: string, workflow: string) =>
  i18n.t("messages.resumeStageGone", { stage, workflow });
export const ERR_RESUME_LOOP_MISMATCH = (stage: string) => i18n.t("messages.resumeLoopMismatch", { stage });
export const MSG_RESUME_LOOP_MISMATCH = (stage: string) => i18n.t("messages.resumeLoopMismatchToast", { stage });
export const MSG_RESUME_PROMOTED = (skill: string) => i18n.t("messages.resumePromoted", { skill });
export const MSG_RESUME_REATTACHED = (skill: string) => i18n.t("messages.resumeReattached", { skill });
export const MSG_RESUME_SESSION_FALLBACK = (skill: string, why: string) =>
  i18n.t("messages.resumeSessionFallback", { skill, why });
export const MSG_CONTINUE_FALLBACK = (skill: string) => i18n.t("messages.continueFallback", { skill });
export const REATTACH_PROMPT = (skill: string) => i18n.t("messages.reattachPrompt", { skill });

export const MSG_RESUME_USAGE = i18n.t("messages.resumeUsage");
export const MSG_RUN_NOT_FOUND = (ref: string) => i18n.t("messages.runNotFound", { ref });
export const MSG_RESUME_WORKFLOW_GONE = (workflow: string, ref: string) =>
  i18n.t("messages.resumeWorkflowGone", { workflow, ref });
export const MSG_INTERACTIVE_ONLY = i18n.t("messages.interactiveOnly");
export const MSG_WORKFLOW_THREW = (reason: string) => i18n.t("messages.workflowThrew", { reason });
export const MSG_NAME_INVALID = (name: string) =>
  i18n.t("messages.nameInvalid", { name, max: MAX_NAME_LENGTH });
export const MSG_NAME_COLLISION = (name: string, runId: string) =>
  i18n.t("messages.nameCollision", { name, runId });
export const MSG_NAME_INDEX_WRITE_FAILED = (name: string) => i18n.t("messages.nameIndexWriteFailed", { name });
export const MSG_HEADER_WRITE_FAILED = (runId: string) => i18n.t("messages.headerWriteFailed", { runId });
export const MSG_NAME_IGNORED_ON_RESUME = i18n.t("messages.nameIgnoredOnResume");
export const MSG_NAME_FLAG_MID_INPUT = i18n.t("messages.nameFlagMidInput");
export const MSG_FLAG_REPEATED = (flag: string) => i18n.t("messages.flagRepeated", { flag });
export const MSG_JUMP_CAP_ABOVE_LAP_CEILING = (cap: number, ceiling: number) =>
  i18n.t("messages.jumpCapAboveLapCeiling", { cap, ceiling });
export const MSG_BUDGET_INVALID = (option: string, value: number) =>
  i18n.t("messages.budgetInvalid", { option, value: String(value) });
export const MSG_LOAD_ABORTED = (count: number) =>
  i18n.t(count === 1 ? "messages.loadAbortedOne" : "messages.loadAbortedMany", { count });
export const MSG_WORKFLOW_NOT_FOUND = (name: string) => i18n.t("messages.workflowNotFound", { name });
export const MSG_NO_WORKFLOWS_REGISTERED = i18n.t("messages.noWorkflowsRegistered");

export interface FatalFailureArgs {
  status: "failed" | "aborted";
  notifyMsg: string;
  notifyLevel: "warning" | "error";
  errMsg: string;
}

function fatalArgsOf(status: "failed" | "aborted", a: FailureText | string, b?: string): FatalFailureArgs {
  const f = typeof a === "string" ? { toast: a, error: b as string } : a;
  return { status, notifyMsg: f.toast, notifyLevel: status === "failed" ? "error" : "warning", errMsg: f.error };
}

export function failedArgs(failure: FailureText): FatalFailureArgs;
export function failedArgs(notifyMsg: string, errMsg: string): FatalFailureArgs;
export function failedArgs(a: FailureText | string, b?: string): FatalFailureArgs {
  return fatalArgsOf("failed", a, b);
}

export function abortedArgs(failure: FailureText): FatalFailureArgs;
export function abortedArgs(notifyMsg: string, errMsg: string): FatalFailureArgs;
export function abortedArgs(a: FailureText | string, b?: string): FatalFailureArgs {
  return fatalArgsOf("aborted", a, b);
}
