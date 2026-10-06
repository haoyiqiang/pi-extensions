/**
 * Workflow orchestration entry points. `runWorkflow` walks a `Workflow`'s
 * edge graph stage-by-stage; `resumeWorkflow` rebuilds state from a past
 * run's JSONL trail and re-enters the chain at the right seam. Per-stage
 * work (sessions, extraction, validation, audit row writes) lives in
 * sessions.ts + audit.ts; this directory owns graph traversal, per-stage
 * prerequisites, and routing; imports point strictly downward — the walk's
 * mutual recursion is composed by injection in run-stage.ts, never as a
 * module cycle.
 *
 * Ctx lifecycle: the launcher ctx threaded into `runWorkflow`/`resumeWorkflow`
 * STAYS VALID for the whole run — it is never swapped. Every stage runs in its
 * own detached child session opened via `ctx.spawnChild({ withSession })`; the
 * parent ctx only observes (progress, status). Continue policy spawns a child
 * like any other stage — its only divergence is the preserved branch offset.
 *
 * Vocabulary: "stage" = one stage activation in this run; "phase" = one
 * `## Phase N:` subdivision inside an implement plan artifact.
 */

import type { Workflow } from "../api.js";
import { currentPrimaryArtifact } from "../chain-state.js";
import { type LifecycleListeners, lifecycleCtxFor } from "../events.js";
import {
	getWorkflowExecutionProvider,
	type WorkflowExecution,
	type WorkflowExecutionIdentity,
} from "../execution-host.js";
import { handleToString } from "../handle.js";
import type { ModelSelection, WorkflowHost, WorkflowHostContext } from "../host.js";
import {
	formatError,
	isAbortError,
	nowIso,
	raceWithWorkflowCancellation,
	workflowCancellationError,
} from "../internal-utils.js";
import { i18n } from "../i18n.js";
import {
	MSG_HEADER_WRITE_FAILED,
	MSG_NAME_COLLISION,
	MSG_NAME_INDEX_WRITE_FAILED,
	MSG_NAME_INVALID,
	MSG_WORKFLOW_COMPLETE,
} from "../messages.js";
import { pruneOrphanedChildSessions } from "../sessions/index.js";
import {
	appendHeader,
	appendRunTerminal,
	type ClaimResult,
	claimName,
	generateRunId,
	readAllStages,
	readRunTerminal,
	releaseName,
	STATE_SCHEMA_VERSION,
	type WorkflowHeader,
} from "../state/index.js";
import { childSessionsDir } from "../state/paths.js";
import type { BranchEntry } from "../transcript.js";
import { DEFAULT_TRIGGER } from "../triggers.js";
import type { RunContext, RunWorkflowOptions, RunWorkflowResult } from "../types.js";
import { reconstructState } from "./resume.js";
import { resumeRefusalError, selectResumeEntry } from "./resume-entry.js";
import { recordAbortedAtSeam } from "./failure.js";
import { buildRunContext, freshRunState, validateRunBudgets } from "./run-context.js";
import { dispatchStageOrRecordFailure } from "./run-stage.js";

// ---------------------------------------------------------------------------
// Shared run body + post-retirement tail
// ---------------------------------------------------------------------------

/** Fire the start bracket and enter the chain. The whole nonterminal body is
 * raced against cancellation so a held onWorkflowStart/onStageEnd/onRoute
 * observer cannot keep `/wf-cancel` pending forever. The abandoned body stays
 * observed by the race and is fenced by RunScope; exactly one canonical abort
 * writer owns the durable terminal row. Execution retirement remains caller-
 * owned and finishes before `finishRun` publishes the result/end event. */
async function executeRun(ctx: WorkflowHostContext, run: RunContext, entry: () => Promise<unknown>): Promise<void> {
	try {
		await raceWithWorkflowCancellation(
			async () => {
				await run.lifecycle.fire(ctx, "onWorkflowStart", lifecycleCtxFor(run));
				await entry();
			},
			run.signal,
		);
	} catch (error) {
		if (!isAbortError(error)) throw error;
		await recordAbortedAtSeam(ctx, run.scope?.activeStage ?? run.workflow.start, run);
	}
}

/** Assemble and publish the terminal envelope only after the execution host's
 * awaited close barrier has retired every child. This prevents a success toast,
 * end event, or orphan sweep from racing still-running callbacks. */
async function finishRun(ctx: WorkflowHostContext, run: RunContext): Promise<RunWorkflowResult> {
	// Every child is retired and every admitted callback has settled. Sweep child-
	// session files no row references (chiefly a continue fork whose stage threw
	// before its first row write). Best-effort.
	pruneOrphanedChildSessions(run.cwd, run.runId, referencedSessionIds(run));

	const { state } = run;
	const result: RunWorkflowResult = {
		runId: run.runId,
		stagesCompleted: state.stagesCompleted,
		success: state.termination.status === "completed",
		lastArtifact: (() => {
			const a = currentPrimaryArtifact(state);
			return a ? handleToString(a.handle) : undefined;
		})(),
		error: state.termination.error,
		termination: state.termination,
		...(state.telemetry.droppedRoutingRows.length > 0
			? { droppedRoutingRows: state.telemetry.droppedRoutingRows }
			: {}),
		...(state.telemetry.droppedFailureRows.length > 0
			? { droppedFailureRows: state.telemetry.droppedFailureRows }
			: {}),
	};

	if (result.success) ctx.ui.notify(MSG_WORKFLOW_COMPLETE(state.stagesCompleted), "info");
	// End observers still receive aborted results; cancellation stops waiting,
	// rather than suppressing the terminal lifecycle event altogether.
	const ended = Promise.resolve().then(() => run.lifecycle.fire(ctx, "onWorkflowEnd", result, lifecycleCtxFor(run)));
	void ended.catch(() => {});
	try {
		await raceWithWorkflowCancellation(() => ended, run.signal);
	} catch (error) {
		// The terminal result is already durable and executor retirement is complete.
		// Cancellation only stops awaiting this observer; the race keeps its late
		// rejection observed and no second terminal row is written.
		if (!isAbortError(error)) throw error;
	}
	return result;
}

/**
 * The keep-set for the run-end orphan sweep. Failed/aborted rows that carry a
 * session are reattach targets on resume, so every row's `session.id` is read
 * from the durable trail (success OR failure) and unioned with `lastSession`
 * (the live predecessor a resumed `continue` would fork). Anything NOT here is
 * a child-session file no row points at — safe to delete.
 */
function referencedSessionIds(run: RunContext): Set<string> {
	const ids = new Set<string>();
	for (const row of readAllStages(run.cwd, run.runId)) {
		if (row.session) ids.add(row.session.id);
	}
	if (run.state.lastSession) ids.add(run.state.lastSession.id);
	return ids;
}

/** Resolved execution plus the exact provider-owned handle that must retire. */
interface DetachedExecutor {
	execCtx: WorkflowHostContext;
	execution?: WorkflowExecution;
	resolveModel?: (id: { workflow: string; stage: string; skill: string }) => ModelSelection | undefined;
	readSessionBranch?: (file: string) => BranchEntry[] | undefined;
	signal?: AbortSignal;
}

const EXECUTION_CLEANUP_FAILED = (reason: string) => i18n.t("consumer.cleanupFailed", { reason });

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const unique = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
	if (unique.length === 0) return undefined;
	if (unique.length === 1) return unique[0];
	return AbortSignal.any(unique);
}

/** Copy only the generic credential-free identity fields before provider code
 * can mutate them. Throws on malformed present identity; `undefined` remains
 * the legacy/provider-free representation. */
function snapshotExecutionIdentity(
	value: WorkflowExecutionIdentity | undefined,
	invalidMessage: string,
): WorkflowExecutionIdentity | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(invalidMessage);
	if (value.version !== 1 || typeof value.executor !== "string" || value.executor.length === 0)
		throw new Error(invalidMessage);
	if (typeof value.backend !== "string" || value.backend.length === 0) throw new Error(invalidMessage);
	const binding = value.promptBinding;
	if (
		binding !== undefined &&
		(!binding ||
			typeof binding !== "object" ||
			Array.isArray(binding) ||
			typeof binding.resolverId !== "string" ||
			binding.resolverId.length === 0 ||
			typeof binding.resourceSetDigest !== "string" ||
			binding.resourceSetDigest.length === 0 ||
			binding.assetMode !== "live")
	)
		throw new Error(invalidMessage);
	return Object.freeze({
		version: 1,
		executor: value.executor,
		backend: value.backend,
		...(binding
			? {
					promptBinding: Object.freeze({
						resolverId: binding.resolverId,
						resourceSetDigest: binding.resourceSetDigest,
						assetMode: "live" as const,
					}),
				}
			: {}),
	});
}

function sameExecutionIdentity(a: WorkflowExecutionIdentity, b: WorkflowExecutionIdentity): boolean {
	return (
		a.version === b.version &&
		a.executor === b.executor &&
		a.backend === b.backend &&
		a.promptBinding?.resolverId === b.promptBinding?.resolverId &&
		a.promptBinding?.resourceSetDigest === b.promptBinding?.resourceSetDigest &&
		a.promptBinding?.assetMode === b.promptBinding?.assetMode
	);
}

/** Close admission and then await retirement. Both hooks run even if one fails. */
async function retireExecutor(detached: DetachedExecutor): Promise<void> {
	const execution = detached.execution;
	if (!execution) return;
	const errors: unknown[] = [];
	try {
		await execution.dispose?.();
	} catch (error) {
		errors.push(error);
	}
	try {
		await execution.close?.();
	} catch (error) {
		if (!errors.includes(error)) errors.push(error);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, i18n.t("consumer.cleanupAggregate"));
}

/** Run one body and ALWAYS await executor retirement. If both fail, preserve
 * both causes rather than letting `finally` mask the original failure. */
async function withExecutorRetirement<T>(
	detached: DetachedExecutor,
	body: () => Promise<T>,
	onCleanupFailure?: (error: unknown) => void,
): Promise<T> {
	let value!: T;
	let bodyFailed = false;
	let bodyError: unknown;
	let cleanupFailed = false;
	let cleanupError: unknown;
	try {
		value = await body();
	} catch (error) {
		bodyFailed = true;
		bodyError = error;
	} finally {
		try {
			await retireExecutor(detached);
		} catch (error) {
			cleanupFailed = true;
			cleanupError = error;
			try {
				onCleanupFailure?.(error);
			} catch {
				// Diagnostic persistence/notification is secondary: never replace the
				// body error or executor-cleanup error this helper must preserve.
			}
		}
	}
	if (bodyFailed && cleanupFailed)
		throw new AggregateError([bodyError, cleanupError], i18n.t("consumer.executionAndCleanupFailed"));
	if (bodyFailed) throw bodyError;
	if (cleanupFailed) throw cleanupError;
	return value;
}

/** Preserve a normal preflight refusal while still surfacing a failed close. */
async function failureAfterRetirement(
	detached: DetachedExecutor,
	error: string,
): Promise<RunWorkflowResult> {
	try {
		await retireExecutor(detached);
		return { stagesCompleted: 0, success: false, error };
	} catch (cleanupError) {
		return {
			stagesCompleted: 0,
			success: false,
			error: `${error}; ${EXECUTION_CLEANUP_FAILED(formatError(cleanupError))}`,
		};
	}
}

/** Persist the authoritative run-level override for a failed executor close.
 * Stage rows are deliberately left intact: they record effects that may already
 * have succeeded. Resume consumes this marker and refuses rather than replaying
 * those effects. The row is additive; older readers ignore it by shape. */
function recordCleanupFailure(ctx: WorkflowHostContext, run: RunContext, error: unknown): void {
	const durableError = EXECUTION_CLEANUP_FAILED(formatError(error));
	const written = appendRunTerminal(run.cwd, run.runId, {
		type: "run-terminal",
		status: "cleanup-failed",
		workflowStatus: run.state.termination.status,
		stagesCompleted: run.state.stagesCompleted,
		error: durableError,
		ts: nowIso(),
	});
	if (!written) ctx.ui.notify(i18n.t("consumer.cleanupMarkerWriteFailed", { runId: run.runId }), "warning");
}

/** Shared execution-host construction for fresh runs and resumes. Per-call
 * observers win, then execution-bound observers, then provider-wide fallbacks.
 * Caller and execution signals are combined; neither can mask the other. */
async function detachExecutor(
	ctx: WorkflowHostContext,
	cwd: string,
	runId: string,
	options: {
		resolveModel?: (id: { workflow: string; stage: string; skill: string }) => ModelSelection | undefined;
		readSessionBranch?: (file: string) => BranchEntry[] | undefined;
		signal?: AbortSignal;
		identity?: WorkflowExecutionIdentity;
		name?: string;
		workflow?: string;
		input?: string;
	},
): Promise<DetachedExecutor> {
	const provider = getWorkflowExecutionProvider();
	if (!provider)
		return {
			execCtx: ctx,
			resolveModel: options.resolveModel,
			readSessionBranch: options.readSessionBranch,
			signal: options.signal,
		};
	const execution = await provider.createHost(ctx, {
		runId,
		childSessionsDir: childSessionsDir(cwd, runId),
		name: options.name,
		workflow: options.workflow,
		input: options.input,
		signal: options.signal,
		identity: options.identity,
		cancellationError: workflowCancellationError,
	});
	return {
		execCtx: execution.host,
		execution,
		resolveModel: options.resolveModel ?? execution.resolveModel ?? provider.resolveModel,
		readSessionBranch: options.readSessionBranch ?? execution.readSessionBranch ?? provider.readSessionBranch,
		signal: combineSignals(options.signal, execution.signal),
	};
}

// ---------------------------------------------------------------------------
// runWorkflow — workflow entry point
// ---------------------------------------------------------------------------

/** Map a failed `claimName` outcome to its user-facing message. */
function nameClaimError(name: string, claim: Extract<ClaimResult, { ok: false }>): string {
	switch (claim.reason) {
		case "invalid":
			return MSG_NAME_INVALID(name);
		case "collision":
			return MSG_NAME_COLLISION(name, claim.runId);
		case "write-failed":
			return MSG_NAME_INDEX_WRITE_FAILED(name);
	}
}

/**
 * Walks the workflow's edge graph from `workflow.start`. The launcher `ctx`
 * stays valid throughout — each stage opens (and disposes) its own detached
 * child session via `spawnChild`, so the outer ctx is never swapped.
 */
export async function runWorkflow(ctx: WorkflowHostContext, options: RunWorkflowOptions): Promise<RunWorkflowResult> {
	const { workflow } = options;
	if (!workflow.stages[workflow.start]) {
		return {
			stagesCompleted: 0,
			success: false,
			error: `Workflow "${workflow.name}" start stage "${workflow.start}" is not declared`,
		};
	}

	// A malformed budget (`NaN`, a negative, a fraction) would make a ledger
	// compare fail open — refused here, before the name claim and the header,
	// so nothing is written for a run that could never halt.
	const budgetError = validateRunBudgets(options);
	if (budgetError !== undefined) return { stagesCompleted: 0, success: false, error: budgetError };

	const cwd = ctx.cwd;
	const runId = generateRunId();
	const trigger = options.trigger ?? DEFAULT_TRIGGER;

	// Reserve the name (validate → collision → persist) through the state
	// layer's single door, BEFORE the JSONL header so the collision guard's
	// truth-source can never lag the header. Nothing is written on failure.
	if (options.name) {
		const claim = claimName(cwd, options.name, runId);
		if (!claim.ok) return { stagesCompleted: 0, success: false, error: nameClaimError(options.name, claim) };
	}

	// Create the execution before the header so its returned identity can be
	// persisted in line one. Construction must not dispatch a child; the durable
	// header still lands before any prompt can run.
	let detached: DetachedExecutor;
	try {
		detached = await detachExecutor(ctx, cwd, runId, {
			...options,
			name: options.name ?? workflow.name,
			workflow: workflow.name,
			input: options.input,
		});
	} catch (error) {
		if (options.name) releaseName(cwd, options.name, runId);
		return { stagesCompleted: 0, success: false, error: formatError(error) };
	}

	let identity: WorkflowExecutionIdentity | undefined;
	try {
		identity = snapshotExecutionIdentity(detached.execution?.identity, i18n.t("consumer.invalidExecutionIdentity"));
	} catch (error) {
		if (options.name) releaseName(cwd, options.name, runId);
		return failureAfterRetirement(detached, formatError(error));
	}

	// A lost header makes the run unlistable and unresumable while stage rows
	// land. Refuse before execution, roll back the name, and retire the host that
	// was created only to obtain its identity.
	const headerWritten = appendHeader(cwd, {
		runId,
		workflow: workflow.name,
		input: options.input,
		ts: nowIso(),
		v: STATE_SCHEMA_VERSION,
		trigger,
		name: options.name,
		identity,
	});
	if (!headerWritten) {
		if (options.name) releaseName(cwd, options.name, runId);
		return failureAfterRetirement(detached, MSG_HEADER_WRITE_FAILED(runId));
	}

	const { execCtx, resolveModel, readSessionBranch, signal } = detached;
	let run: RunContext | undefined;
	try {
		await withExecutorRetirement(
			detached,
			async () => {
				// Construction stays under the retirement barrier too: a malformed graph
				// that throws here must not leak an execution host.
				run = buildRunContext(
					cwd,
					workflow,
					{ ...options, resolveModel, readSessionBranch, signal },
					{
						runId,
						state: freshRunState(options.input),
						visited: new Set(),
						trigger,
					},
				);
				await executeRun(execCtx, run, () => dispatchStageOrRecordFailure(execCtx, workflow.start, 0, run!));
			},
			(error) => {
				if (run) recordCleanupFailure(ctx, run, error);
			},
		);
	} finally {
		run?.scope?.seal();
	}
	return finishRun(ctx, run!);
}

export interface ResumeWorkflowOptions {
	/** Workflow whose run is being resumed — caller resolves by name from `LoadedWorkflows`. */
	workflow: Workflow;
	/** Header of the run to resume — caller resolves via `resolveRun`. */
	header: WorkflowHeader;
	/** Registry-level host — enumerated once for the skill-registration snapshot. */
	host?: WorkflowHost;
	/** Per-destination decision-edge re-entry cap. Defaults to MAX_BACKWARD_JUMPS. */
	maxBackwardJumps?: number;
	/**
	 * Per-destination ABSOLUTE ceiling on decision-edge re-entries — counts
	 * every re-entry (improved-waived laps included), unlike the waive-aware
	 * `maxBackwardJumps` cap. The `maxLaps + 1`-th re-entry of one stage
	 * halts. Defaults to MAX_LAPS; fresh per invocation (a resume starts
	 * both re-entry ledgers empty).
	 */
	maxLaps?: number;
	/** Run-wide safety cap on loop units (all kinds). Defaults to MAX_ITERATIONS. */
	maxIterations?: number;
	/** The user's `@<ref>` — surfaced in trigger.meta + refusal messages. */
	ref: string;
	/** Per-call lifecycle listener bundle. */
	lifecycle?: LifecycleListeners;
	/** Cooperative cancellation — see `RunWorkflowOptions.signal`. */
	signal?: AbortSignal;
	/**
	 * Per-stage model-override resolver — see `RunWorkflowOptions.resolveModel`.
	 * Resumed stages resolve per-child models exactly like live; when omitted the
	 * detached executor's own `provider.resolveModel` is used (so a resume from the
	 * Pi launcher still honors per-skill overrides without the caller re-threading
	 * it). Undefined + no provider ⇒ host default for every resumed stage.
	 */
	resolveModel?: (id: { workflow: string; stage: string; skill: string }) => ModelSelection | undefined;
	/** Per-call persisted-session observer — see `RunWorkflowOptions.readSessionBranch`. */
	readSessionBranch?: (file: string) => BranchEntry[] | undefined;
}

/**
 * Resume a failed (or cut-off) workflow run by rebuilding `RunState` from
 * the run's JSONL audit trail and re-entering the chain machinery at the
 * right seam — re-running the failed stage, or routing onward from the
 * last completed one.
 *
 * New rows **append to the same JSONL file** so the trail reads as one
 * story: *ran → failed → resumed → continued*.
 *
 * Exception: a trailing additive `run-terminal/cleanup-failed` marker is an
 * authoritative non-replayable outcome. Resume returns a preflight-style
 * failed envelope (no `runId`, so the command notifies once) before executor
 * construction and appends nothing: recorded stage effects may
 * already have succeeded, so the operator must fix cleanup and start a new run
 * rather than blindly replaying them.
 */
export async function resumeWorkflow(
	ctx: WorkflowHostContext,
	options: ResumeWorkflowOptions,
): Promise<RunWorkflowResult> {
	const { workflow, header } = options;
	const cwd = ctx.cwd;

	// Same pre-flight refusal as `runWorkflow` — a resume threads the same
	// budget options and appends to the same trail, so a malformed budget is
	// refused before any row lands.
	const budgetError = validateRunBudgets(options);
	if (budgetError !== undefined) return { stagesCompleted: 0, success: false, error: budgetError };

	const durableTerminal = readRunTerminal(cwd, header.runId);
	if (durableTerminal) {
		const error = i18n.t("consumer.resumeCleanupFailed", { reason: durableTerminal.error });
		return {
			// Preflight refusal contract: omit runId so the /wf command surface emits
			// this error exactly once. The referenced JSONL still exists; no executor
			// is constructed and no rows/effects are replayed.
			stagesCompleted: durableTerminal.stagesCompleted,
			success: false,
			error,
			termination: { status: "failed", error },
		};
	}

	let savedIdentity: WorkflowExecutionIdentity | undefined;
	try {
		savedIdentity = snapshotExecutionIdentity(header.identity, i18n.t("consumer.invalidSavedIdentity"));
	} catch (error) {
		return { stagesCompleted: 0, success: false, error: formatError(error) };
	}

	const recon = await reconstructState(cwd, workflow, header);
	if (!recon.ok) {
		return { stagesCompleted: 0, success: false, error: resumeRefusalError(recon, header.workflow) };
	}

	// Same run id ⇒ same childSessionsDir. The saved identity is supplied during
	// construction so the executor can keep backend choice sticky and reject
	// changed resources before any model resolution or journal append.
	let detached: DetachedExecutor;
	try {
		detached = await detachExecutor(ctx, cwd, header.runId, {
			...options,
			identity: savedIdentity,
			name: header.name ?? header.workflow,
			workflow: header.workflow,
			input: header.input,
		});
	} catch (error) {
		return { stagesCompleted: 0, success: false, error: formatError(error) };
	}

	let actualIdentity: WorkflowExecutionIdentity | undefined;
	try {
		actualIdentity = snapshotExecutionIdentity(detached.execution?.identity, i18n.t("consumer.invalidExecutionIdentity"));
	} catch (error) {
		return failureAfterRetirement(detached, formatError(error));
	}
	if (savedIdentity && (!actualIdentity || !sameExecutionIdentity(savedIdentity, actualIdentity))) {
		return failureAfterRetirement(detached, i18n.t("consumer.identityMismatch"));
	}

	const { execCtx, resolveModel, readSessionBranch, signal } = detached;
	let run: RunContext | undefined;
	try {
		await withExecutorRetirement(
			detached,
			async () => {
				run = buildRunContext(
					cwd,
					workflow,
					{ ...options, resolveModel, readSessionBranch, signal },
					{
						runId: header.runId,
						state: recon.state,
						visited: recon.visited,
						trigger: { kind: "command", name: "wf", meta: { resumedFrom: options.ref } },
					},
				);
				await executeRun(execCtx, run, selectResumeEntry(execCtx, recon, run));
			},
			(error) => {
				if (run) recordCleanupFailure(ctx, run, error);
			},
		);
	} finally {
		run?.scope?.seal();
	}
	return finishRun(ctx, run!);
}
