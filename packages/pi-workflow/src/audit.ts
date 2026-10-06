/**
 * Terminal-outcome orchestration — the impure half of the audit layer.
 * Turns a halt reason into the full bundle a terminal outcome owes the
 * user and the system: the JSONL failure row (via `audit-rows.ts`), the
 * status-line clear, the notify toast, the `terminate()` state write, and
 * the `onStageError` lifecycle fire.
 *
 * Depends on audit-rows + audit-ctx + state + messages + events + handle.
 * The pure ctx half (`AuditContext`, `runIdentityOf`, `auditCtxFor`,
 * `currentStageRef`) now lives in `audit-ctx.ts`; the terminal-args builders
 * (`failedArgs`/`abortedArgs`/`FatalFailureArgs`) live in `messages.ts`.
 * Both are re-exported below so existing audit-layer consumers keep one
 * import site; new code may import `audit-ctx.ts` / `messages.ts` directly.
 * Shared by the runner + sessions; neither imports back. Pure row
 * persistence (the allocator, `recordStage`, success persistence) lives in
 * `audit-rows.ts`.
 */

import { auditWriteIsActive, type AuditContext } from "./audit-ctx.js";
import { recordStage, unitRowFields } from "./audit-rows.js";
import { writeDeathSceneArtifact } from "./death-scene.js";
import { lifecycleCtxFromSession, scriptStageRef, skillStageRef } from "./events.js";
import { appendFailureMemo } from "./failure-memos.js";
import { handleToString } from "./handle.js";
import {
	assertNever,
	isAbortError,
	nowIso,
	raceWithWorkflowCancellation,
} from "./internal-utils.js";
import { i18n } from "./i18n.js";
import {
	abortedArgs,
	FAIL_AUDIT_WRITE,
	FAIL_STAGE_ABORTED,
	FAIL_STAGE_NO_RESPONSE,
	FAIL_STAGE_TOOL_STALLED,
	FAIL_STAGE_TRUNCATED,
	type FatalFailureArgs,
	failedArgs,
	MSG_FAILURE_ROW_DROPPED,
	MSG_PARTIAL_ARTIFACTS,
	MSG_STAGE_FAILED,
} from "./messages.js";
import { listArtifacts } from "./state/index.js";
import type { StopSignal } from "./transcript.js";
import type { RunState, RunTermination, WorkflowHostContext } from "./types.js";

// Preserving barrel — the pre-split import surface is unchanged. Consumers
// (`sessions/`, `runner/`, `loop-kinds`, `loop-parallel`, `internal.ts`,
// `audit.test.ts`) keep importing `AuditContext`/`runIdentityOf`/`auditCtxFor`/
// `currentStageRef`/`failedArgs`/`abortedArgs`/`FatalFailureArgs` from
// "./audit.js" with no edit. Symbols now live in their post-split homes:
export type { AuditContext } from "./audit-ctx.js";
export { auditCtxFor, auditWriteIsActive, currentStageRef, runIdentityOf } from "./audit-ctx.js";
// Re-export the persistence half so existing audit-layer consumers keep one
// import site; new code may import audit-rows.js directly.
export { allocateStageNumber, decorateStage, recordStage, unitRowFields } from "./audit-rows.js";
export type { FatalFailureArgs } from "./messages.js";
export { abortedArgs, failedArgs } from "./messages.js";

/** Low-level `state.termination` mutator retained for compatible internal/test
 * callers. Production terminal paths use `claimRunTermination` below so only
 * one async continuation can own the logical run's terminal transition. */
export function terminate(state: RunState, outcome: Exclude<RunTermination, { status: "running" }>): void {
	state.termination = outcome;
}

/** Claim and publish the run's single terminal outcome. A scope claim is
 * allowed after its signal aborts (the abort writer must still land), but never
 * after another terminal owner or retirement sealing. Scope-less structural
 * contexts fall back to the historical state-only first-writer guard. */
export function claimRunTermination(
	owner: Pick<AuditContext, "state" | "scope">,
	outcome: Exclude<RunTermination, { status: "running" }>,
): boolean {
	if (owner.state.termination.status !== "running") return false;
	if (owner.scope && !owner.scope.claimTerminal()) return false;
	terminate(owner.state, outcome);
	return true;
}

/**
 * Terminal halt for "the success row failed to persist." The audit JSONL is the
 * run's system of record, so a dropped append leaves state un-advanced and ends
 * the run. Notify+terminate idiom shared by the skill/unit success
 * path (`recordStageSuccess`, sessions.ts) and the script path
 * (`runScript`, script-stage.ts); each caller maps the void return to its own
 * halt token (`false` / `"halted"`). `subject` is the skill (or stage) the
 * failure message names.
 */
export function failAuditWrite(
	ctx: WorkflowHostContext,
	state: RunState,
	subject: string,
	scope?: AuditContext["scope"],
): void {
	const failure = FAIL_AUDIT_WRITE(subject);
	if (!claimRunTermination({ state, scope }, { status: "failed", error: failure.error })) return;
	ctx.ui.notify(failure.toast, "error");
}

/** Surface every artifact recorded so far — recap on stage failure. */
export function notifyPartialArtifacts(ctx: WorkflowHostContext, cwd: string, runId: string): void {
	const items = listArtifacts(cwd, runId);
	if (items.length === 0) return;
	const artifactList = items.map((i) => `  • ${i.stage}: ${handleToString(i.artifact.handle)}`).join("\n");
	ctx.ui.notify(MSG_PARTIAL_ARTIFACTS(artifactList), "info");
}

/**
 * Terminal/halt/cancellation row-write authority. `recordStage` + the
 * dropped-row guard (notify + telemetry) — the side effects the three writers
 * (`recordFatalFailure` / `recordUnitHalt` / `recordCancellation`) share.
 * Each caller builds its row fields (terminal `args.status`; halt
 * `collected:true`; cancellation `status:"skipped"`) and delegates the write +
 * guard here, so the dropped-failure-row invariant — a dropped row corrupts
 * resume: the trail's last row reads "completed" and a later resume routes
 * onward past the stage — is enforced ONCE (parity contract, precedent
 * `advanceCursor` at loop.ts). Returns the assigned stageNumber on success
 * (undefined on drop), matching `audit-rows.ts:recordStage`'s contract.
 *
 * "terminal" here is the RUN-OUTCOME sense (a failure/cancellation that ends
 * the run) — distinct from the `terminal()` stage factory (stage-def.ts) and
 * the graph-sink `edge.mode: "terminal"` (loop-constructors.ts). See the
 * glossary on `stage-def.ts`'s `terminal` export.
 */
function recordFailureRow(
	ctx: WorkflowHostContext,
	audit: AuditContext,
	row: Parameters<typeof recordStage>[2],
): number | undefined {
	const written = recordStage(audit.cwd, audit.runId, row, audit.state, audit.allocatedStageNumber);
	if (written === undefined) {
		ctx.ui.notify(MSG_FAILURE_ROW_DROPPED(audit.stageName), "warning");
		audit.state.telemetry.droppedFailureRows.push(audit.stageName);
	}
	return written;
}

/**
 * Record the two failure-forensics sidecars for a failed stage/unit — the
 * in-memory failure memo (`appendFailureMemo`) and the death-scene `.md`
 * artifact (`writeDeathSceneArtifact`) — immediately after the failure-row
 * write. Peer helper to `recordFailureRow`; the two terminal writers
 * (`recordFatalFailure`, `recordUnitHalt`) both delegate here.
 *
 * Fail-soft: the death-scene artifact reads the just-failed session's persisted
 * JSONL via the host-injected `audit.readSessionBranch`; skips silently when
 * sessionless / no reader; notifies + continues on any miss/throw so the
 * already-persisted failure row is never masked. The memo append is in-memory
 * only and does not throw.
 */
function recordFailureForensics(ctx: WorkflowHostContext, audit: AuditContext, errMsg: string): void {
	appendFailureMemo(audit.state, audit, errMsg);
	writeDeathSceneArtifact(ctx, audit, errMsg);
}

export async function recordFatalFailure(
	ctx: WorkflowHostContext,
	audit: AuditContext,
	args: FatalFailureArgs,
	onFailure?: (ctx: WorkflowHostContext) => void,
): Promise<void> {
	// First terminal owner wins across parallel failures, cancellation races,
	// and abandoned callbacks. Claim BEFORE the row append so every competing
	// ordinary writer is fenced synchronously; signal abortion does not bar the
	// abort writer's claim.
	if (!claimRunTermination(audit, { status: args.status, error: args.errMsg })) return;
	recordFailureRow(ctx, audit, {
		stage: audit.stageName,
		// Script-stage failure rows omit `skill` (the row split landed in A.0);
		// skill rows continue to carry it. `undefined` is dropped by JSON.stringify.
		// `errMsg` mirrors `state.termination.error` so the failure reason
		// survives in JSONL even when the `ctx.ui.notify` toast is missed.
		skill: audit.isScript ? undefined : audit.skill,
		status: args.status,
		ts: nowIso(),
		errMsg: args.errMsg,
		session: audit.session,
		...unitRowFields(audit.unit),
	});
	recordFailureForensics(ctx, audit, args.errMsg);
	ctx.ui.notify(args.notifyMsg, args.notifyLevel);
	onFailure?.(ctx);
	const ref = audit.isScript
		? scriptStageRef(audit.stageName, audit.state.lastAllocatedStageNumber)
		: skillStageRef(audit.stageName, audit.state.lastAllocatedStageNumber, audit.skill);
	// Fire the terminal observer even when cancellation already won, but do not
	// let an uncooperative listener keep cancellation pending forever. Starting
	// the promise before the race preserves the event; the detached catch keeps
	// every late rejection observed after the run's write fence has closed.
	const observed = Promise.resolve().then(() =>
		audit.lifecycle.fire(ctx, "onStageError", ref, args.errMsg, lifecycleCtxFromSession(audit)),
	);
	void observed.catch(() => {});
	try {
		await raceWithWorkflowCancellation(() => observed, audit.scope?.signal);
	} catch (error) {
		if (!isAbortError(error)) throw error;
	}
}

/**
 * Persist a NON-TERMINAL failed unit row (collect-all fanout): the unit halted,
 * but the run survives and the synthesis stage sees a failed slot. Mirrors
 * `recordFatalFailure`'s `recordStage` write (same unit fields, same
 * pre-allocated number) WITHOUT `terminate()` (the only state mutation it skips)
 * and WITHOUT the `onStageError` fire (this is not a hard fail). The row carries
 * `collected: true` so the resume fold can tell it apart from a hard
 * `recordFatalFailure` row (byte-identical otherwise) and rebuild the
 * `failedOutput` sentinel by `unitIndex` instead of re-dispatching it.
 */
export function recordUnitHalt(ctx: WorkflowHostContext, audit: AuditContext, errMsg: string): void {
	if (!auditWriteIsActive(audit)) return;
	recordFailureRow(ctx, audit, {
		stage: audit.stageName,
		skill: audit.isScript ? undefined : audit.skill,
		status: "failed",
		collected: true, // distinguishes a soft collect-all halt from a hard terminal failure on resume
		ts: nowIso(),
		errMsg,
		session: audit.session,
		...unitRowFields(audit.unit),
		// The failed unit's label — additive, collected rows only. The resume
		// fold threads it into the rebuilt sentinel's dimension so the live and
		// replayed sentinels stay byte-identical (rebuildCollectedSentinel).
		...(audit.unit ? { unitLabel: audit.unit.label } : {}),
		// The failed attempt's 1-based ordinal — the resume fold's budget input:
		// an under-budget collected row leaves its slot unfilled so resume
		// re-dispatches the unit while `retryHaltedUnits` budget remains.
		...(audit.attemptOrdinal !== undefined ? { attemptOrdinal: audit.attemptOrdinal } : {}),
	});
	recordFailureForensics(ctx, audit, errMsg);
}

/**
 * One arm per StopSignal variant (minus `"stop"`, the success path).
 * JSONL `status` stays `"aborted" | "failed"` for downstream-reader
 * compatibility; the per-signal distinction surfaces via MSG_STAGE_*
 * and state.termination.error.
 */
export async function recordStopFailure(
	ctx: WorkflowHostContext,
	audit: AuditContext,
	stop: Exclude<StopSignal, "stop">,
	errorMessage: string,
	onFailure?: (ctx: WorkflowHostContext) => void,
): Promise<void> {
	await recordFatalFailure(ctx, audit, stopFailureArgs(audit.skill, stop, errorMessage), onFailure);
}

function stopFailureArgs(skill: string, stop: Exclude<StopSignal, "stop">, errorMessage: string): FatalFailureArgs {
	switch (stop) {
		case "aborted":
			return abortedArgs(FAIL_STAGE_ABORTED(skill));
		case "length":
			return failedArgs(FAIL_STAGE_TRUNCATED(skill));
		case "toolUse":
			return failedArgs(FAIL_STAGE_TOOL_STALLED(skill));
		case "noResponse":
			return failedArgs(FAIL_STAGE_NO_RESPONSE(skill));
		case "error":
			return failedArgs(MSG_STAGE_FAILED(skill), errorMessage);
		default:
			return assertNever(stop);
	}
}

export function recordCancellation(ctx: WorkflowHostContext, audit: AuditContext): void {
	// Cancellation is a first-class termination outcome: the canonical in-memory
	// name is `RunTermination.status: "cancelled"` (types.ts), but the JSONL row
	// is written with the FROZEN `StageStatus: "skipped"` (state/state.ts) — a
	// deliberate split (the row value is a versioned on-disk contract; renaming
	// it would break resume + every past-run reader). THIS is the sole writer of
	// a `"skipped"` row. `errMsg` is mirrored into the row so post-mortems work
	// from the trail alone (same posture as `recordFatalFailure`).
	const errMsg = `${audit.skill} cancelled by user`;
	if (!claimRunTermination(audit, { status: "cancelled", error: errMsg })) return;
	recordFailureRow(ctx, audit, {
		stage: audit.stageName,
		skill: audit.skill,
		status: "skipped",
		ts: nowIso(),
		errMsg,
		session: audit.session,
		...unitRowFields(audit.unit),
	});
	ctx.ui.notify(i18n.t("messages.workflowCancelled"), "info");
}
