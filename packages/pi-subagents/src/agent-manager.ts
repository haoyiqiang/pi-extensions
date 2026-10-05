/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * There are two independent concurrency pools, never one:
 *
 * - Background (`maxConcurrent`, default 10) bounds detached agents.
 * - Foreground (`maxConcurrentForeground`, default 0 = unlimited) bounds
 *   agents a caller is blocking on inline — `spawnAndWait`.
 *
 * Independent by design: a foreground agent blocks the parent anyway, so
 * charging it to the background pool would let a saturated pool starve the main
 * session of work it could have done itself. Excess agents in either pool are
 * queued and auto-started as slots free up. Nested children take no slot in
 * either — see `occupiesPoolSlot` / `occupiesForegroundSlot`.
 */

import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolActivity } from "./agent-runner.js";
import { createEmbeddedExecutionBackend } from "./backends/embedded-adapter.js";
import { snapshotRequiredTools } from "./backends/tool-requirements.js";
import { snapshotPromptBinding, type PromptBinding } from "./backends/prompt-binding.js";
import type { ExecutionSession } from "./backends/session.js";
import type { PersistentSessionReference, SessionReference } from "./backends/session-reference.js";
import type { AgentExecutionBackend, ExecutionResumeResult, ExecutionRunOptions, ExecutionRunResult } from "./backends/types.js";
import { i18n } from "./i18n.js";
import { assignHandle, handleBase } from "./mention.js";
import { describeModel } from "./model-resolver.js";
import type { AgentInvocation, AgentRecord, AgentTombstone, IsolationMode, MentionResolution, SubagentType, EffectiveThinkingLevel } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import type { CompiledSchema } from "./workflow/json-schema.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
/**
 * Fired once per assistant `message_end`, for EVERY agent this manager owns —
 * top-level and nested alike, spawns and resumes. The one place where each
 * message is seen exactly once: `AgentRecord.lifetimeUsage` is deliberately
 * double-booked into ancestors (see `nested-tools.ts`) so a hidden child's spend
 * shows up on the record a human can see, which makes those records useless as
 * a basis for anything that must not count a message twice — parent-session
 * accounting above all.
 */
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/**
 * Default max concurrent background agents.
 *
 * Raised from 4 when top-level spawns started defaulting to background
 * (`backgroundByDefault`): foreground agents bypass this pool entirely, so
 * while foreground was the default a fan-out of six ran six. With background
 * as the default every top-level agent takes a slot, and a limit of 4 would
 * have silently queued the tail of exactly the parallel fan-outs the `Agent`
 * tool description tells the model to send.
 */
const DEFAULT_MAX_CONCURRENT = 10;

/**
 * Default max concurrent foreground (blocking) agents — `0` = unlimited, the
 * extension's existing convention for "no ceiling" (`defaultMaxTurns`).
 *
 * Off by default because nothing here ever bounded foreground work, and pi
 * dispatches a message's tool calls through `Promise.all`, so an unqualified
 * fan-out of blocking `Agent` calls has always run all at once. Users who want
 * it bounded — chiefly local models, where parallel agents thrash the prompt
 * cache (#253) — opt in; everyone else keeps today's behaviour exactly.
 */
const DEFAULT_MAX_CONCURRENT_FOREGROUND = 0;

/**
 * How many evicted agents stay addressable by name. Only a bound on memory —
 * a session that spawns hundreds of agents shouldn't retain every one — and
 * far above the handful anyone keeps in their head.
 */
const MAX_TOMBSTONES = 100;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

/**
 * Whether a record occupies one of the `maxConcurrent` background slots.
 * Nested children don't: their parent already holds a slot, so counting (and
 * therefore queueing) them would deadlock a parent that waits on its own child.
 *
 * Note this bounds nothing horizontally — the depth cap limits how DEEP nesting
 * goes, not how WIDE. A parent's only limit on concurrent children is that each
 * spawn costs it a turn, which is unbounded when max turns is unlimited.
 */
function occupiesPoolSlot(
  record: Pick<AgentRecord, "isBackground" | "parentAgentId" | "workflowId">,
): boolean {
  return !!record.isBackground && isTopLevelAgent(record);
}

/**
 * Whether a record is one of the session's own agents, rather than something
 * another agent or a workflow owns.
 *
 * The single definition behind every user-facing surface — the fleet list, the
 * widget, the `/agents` menus, `@handle` resolution, and the completion events
 * and session entries. An owned child reports through its owner, so surfacing
 * it separately would double-count the same work in the places a person reads.
 */
export function isTopLevelAgent(
  record: Pick<AgentRecord, "parentAgentId" | "workflowId">,
): boolean {
  return record.parentAgentId === undefined && record.workflowId === undefined;
}

/**
 * Whether a record occupies one of the `maxConcurrentForeground` slots.
 *
 * Keyed on `blocking` — a caller awaiting this record inline — rather than on
 * `isBackground === false`, because `spawn()` is also the funnel for DETACHED
 * starts (cross-extension RPC, `@handle` mentions, the registry) that may pass
 * `isBackground: false` and are documented to run immediately regardless. Those
 * block nobody, so bounding them buys nothing and would park a record with no
 * one waiting to release it.
 *
 * Nested children are excluded for the same reason as `occupiesPoolSlot`, and
 * more sharply: their parent is blocked *awaiting them*, so queueing a child
 * behind its own parent is a guaranteed deadlock rather than a possible one.
 * Enforced here rather than at the call site so no caller can reintroduce it.
 *
 * A workflow's children go out through `spawnAndWait` and so are `blocking`
 * too, and are excluded on the same `isTopLevelAgent` test as the background
 * pool: the run already caps how many of its agents run at once, and charging
 * them here as well would let one fan-out queue behind a limit meant for the
 * session's own work.
 *
 * Like the background pool this bounds width at the top level only — a parent's
 * own fan-out is limited by nothing but its turn budget.
 */
function occupiesForegroundSlot(
  record: Pick<AgentRecord, "blocking" | "parentAgentId" | "workflowId">,
): boolean {
  return !!record.blocking && isTopLevelAgent(record);
}

/** Which concurrency pool a spawn is charged to, if any. */
type Pool = "background" | "foreground";

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  promptBinding?: PromptBinding;
  /** Minimum active tool names for this invocation, not permission grants. */
  requiredTools?: readonly string[];
  /**
   * Optional memorable name for this instance, becoming a second handle
   * (`@auth-audit`) alongside the type-derived one. Slugged, not validated —
   * anything unusable degrades via `handleBase` rather than failing the spawn.
   */
  name?: string;
  /**
   * Reopen this pi session file instead of starting a fresh conversation, so a
   * mention of an evicted agent continues where it left off. The agent's
   * definition is still resolved from its type, so the continuation runs under
   * the type's CURRENT config.
   */
  resumeSessionFile?: string;
  /**
   * Take an evicted agent's names back verbatim instead of allocating fresh
   * ones, so a resumed conversation keeps the handle the user just typed —
   * `handleBase(type)` cannot reproduce a numbered `explore-2`. Safe without an
   * `assignHandle` pass because tombstoned names are excluded from allocation
   * (`takenHandles`), so nothing live can be holding them.
   *
   * Internal capability, like `resumeSessionFile`: a forged handle would
   * duplicate a live agent's name and make `resolveMention` ambiguous, so
   * `spawnTopLevel` strips it from anything a caller sends.
   */
  reclaim?: { handle: string; alias?: string };
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: EffectiveThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip whichever pool's queue check applies to this spawn — start immediately
   * even if the configured concurrency limit would otherwise queue it. The slot
   * is still COUNTED once the run starts, so a bypassing spawn transiently
   * exceeds the limit rather than being invisible to it.
   *
   * Used by the scheduler, so a fired job can't be deferred past its trigger
   * window, and by the `/agents` agent-file generator, which has no way to
   * cancel a wait (see its call site).
   */
  bypassQueue?: boolean;
  /**
   * A caller is awaiting this record inline (`spawnAndWait`) — what
   * `maxConcurrentForeground` bounds. Set only by `spawnAndWait`; stripped from
   * caller-supplied options by `spawnTopLevel`, since a forged `blocking` would
   * defer a detached start behind a queue its caller cannot see or release.
   */
  blocking?: boolean;
  /**
   * The workflow run this child belongs to, when a workflow spawned it.
   *
   * Ownership, not decoration. A workflow's children are the workflow's — they
   * report through its card, its notification and its dialog, so they are
   * filtered out of every top-level surface exactly as nested children are, and
   * they take no `maxConcurrent` slot: the run has its own concurrency cap, and
   * counting them twice would let one workflow starve the whole session.
   */
  workflowId?: string;
  /**
   * Make the child report through a `StructuredOutput` tool built from this
   * compiled schema. Set only by the workflow host, for `agent({ schema })`.
   */
  structuredOutput?: CompiledSchema;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /**
   * Last chance to look at an isolated agent's worktree, awaited immediately
   * before it is committed to a branch and removed.
   *
   * Exists because that removal happens inside the settle path, before
   * `spawnAndWait` resolves: by the time a caller has the finished record, the
   * directory the child actually wrote in is gone. Anything that must inspect
   * or verify that tree — a workflow `gate` is the motivating case — has to run
   * here or it silently inspects the main tree instead.
   *
   * Fires only on the normal settle path, and only when a worktree was created.
   * Not on the error path and not on the stop-during-copy guard: those are
   * already failing, and delaying cleanup there would leak a copy for no gain.
   * A rejection is swallowed — the hook can never keep the worktree alive.
   */
  onBeforeWorktreeCleanup?: (worktreePath: string) => Promise<void>;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /**
   * Called synchronously once the record is in the map and its promise is set,
   * before `onSessionCreated` fires — where callers attach the output file.
   *
   * Carried on the options rather than parked on the manager for the duration
   * of a spawn: with a foreground queue, `startAgent` can run at drain time,
   * long after any such field would have been restored, and the callback would
   * silently never fire (or fire into an unrelated caller's closure).
   */
  onSpawned?: (id: string) => void;
  /**
   * Called synchronously when the spawn is queued instead of started, with how
   * many entries in its own pool are ahead of it. The foreground UI uses it to
   * say so while it waits; nothing else needs it.
   */
  onQueued?: (id: string, ahead: number) => void;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: ExecutionSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Root session id, inherited by nested launches so transcripts stay grouped. */
  rootSessionId?: string;
}

/** Private managed adoption: metadata belongs to this manager, policy to the backend. */
export interface RestoreOptions {
  promptBinding?: PromptBinding;
  mode?: "reattach" | "fork";
  type: SubagentType;
  description: string;
  name?: string;
  ctx?: ExtensionContext;
  structuredOutput?: CompiledSchema;
  /** Cancels adoption only; resumed invocations receive their own signal. */
  signal?: AbortSignal;
  workflowId?: string;
  parentAgentId?: string;
  depth?: number;
  maxSubagentDepth?: number;
  rootSessionId?: string;
}

/** Backend leases enforce canonical filesystem ownership; this also guards local aliases. */
function sessionPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function sameSession(a: SessionReference, b: SessionReference): boolean {
  return a.backend === b.backend && (a.sessionId === b.sessionId ||
    (!!a.sessionFile && !!b.sessionFile && sessionPath(a.sessionFile) === sessionPath(b.sessionFile)));
}

function isPersistentReference(reference: unknown): reference is PersistentSessionReference {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return false;
  const value = reference as Partial<SessionReference>;
  return typeof value.sessionId === "string" && value.sessionId.trim().length > 0 &&
    typeof value.sessionFile === "string" && isAbsolute(value.sessionFile);
}

interface ResumeOptions {
  /** Minimum active tool names for this invocation, checked against the saved policy. */
  requiredTools?: readonly string[];
  /**
   * Run the resumed turn detached in the background: return immediately with
   * the record still "running" (or "queued" at the concurrency limit) and
   * notify on completion via onComplete, exactly like a background spawn.
   * Default (false/undefined) runs the resume inline and returns the settled
   * record — the historical behavior.
   */
  isBackground?: boolean;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /**
   * Background resume only: called synchronously when the run actually starts —
   * immediately, or later from drainQueue. Callers wire per-run side effects
   * (output-file streaming) here rather than at the call site, so a resume that
   * is stopped while still queued never leaves a subscription behind: `abort()`
   * drops a queued record without reaching `settle()`, which is what would have
   * torn that subscription down.
   */
  onStarted?: () => void;
}

/** Match fresh-run precedence, including an external stop during the await. */
function applyResumeResult(record: AgentRecord, result: ExecutionResumeResult): void {
  if (result.aborted && result.failure !== undefined) record.error = result.failure;
  if (record.status !== "stopped") {
    if (result.aborted) {
      record.status = "aborted";
    } else if (result.failure) {
      record.status = "error";
      record.error = result.failure;
    } else {
      record.status = result.steered ? "steered" : "completed";
    }
  }
  record.result = result.text;
  record.structuredJson = result.structuredJson;
  record.structuredRetried = result.structuredRetried;
}

function applyResumeError(record: AgentRecord, error: unknown): void {
  if (record.status !== "stopped") {
    record.status = "error";
    record.error = error instanceof Error ? error.message : String(error);
  }
  record.structuredJson = undefined;
  record.structuredRetried = undefined;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private maxConcurrent: number;
  private maxConcurrentForeground = DEFAULT_MAX_CONCURRENT_FOREGROUND;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();
  private disposed = false;
  /** Kept until acquisition AND any late-handle cleanup settle, even after caller cancellation. */
  private restorations = new Map<AbortController, Promise<void>>();
  private restoreReservations = new Set<SessionReference>();
  /** Eviction is detached, but disposal still awaits it and ownership stays reserved meanwhile. */
  private shutdowns = new Map<ExecutionSession, Promise<void>>();
  private closedSessions = new WeakMap<ExecutionSession, Promise<void>>();
  /** Status may already be stopped/completed while backend or manager cleanup still owns the run. */
  private invocations = new Map<string, Promise<void>>();
  /** Pins affect timed GC only; explicit owner boundaries always win. */
  private retained = new WeakMap<AgentRecord, Set<symbol>>();
  private releases = new Map<string, Promise<void>>();
  /** Backend completion has arrived; only manager-owned settlement remains. */
  private settling = new WeakSet<AgentRecord>();
  private recordShutdowns = new WeakMap<AgentRecord, Set<Promise<void>>>();
  /** Strict managed owners surface retirement failures without changing legacy best-effort cleanup. */
  private retirementFailures: unknown[] = [];
  private sessionRetirementFailures = new WeakMap<ExecutionSession, unknown[]>();
  private recordRetirementFailures = new WeakMap<AgentRecord, unknown[]>();

  /**
   * Startup phases, keyed by agent id. `spawn()` still returns synchronously,
   * but an agent using worktree isolation is not running yet when it does —
   * copying the repo is an awaited git call. This is what `awaitStartup` hands
   * callers that must fail their tool call on a startup failure, and what
   * `waitForAll` waits on while a record is "running" with no `promise` yet.
   * Entries are dropped once the run is underway, and kept (rejected) after a
   * startup failure so a late `awaitStartup` still sees it.
   */
  private startups = new Map<string, Promise<void>>();

  /**
   * Evicted agents that can still be reached by name, keyed by handle. Outlives
   * the 10-minute record cleanup — that timer exists to bound memory, not to
   * expire a conversation the user might still want — and is cleared alongside
   * completed records on session start/switch.
   */
  private tombstones = new Map<string, AgentTombstone>();

  /**
   * Agents waiting to start, tagged with the pool they wait on. One queue for
   * both pools: `drainQueue` picks the earliest entry whose own pool has room,
   * so neither can head-of-line-block the other, and every removal path
   * (`abort`, `abortAll`, `dispose`) stays a single filter.
   *
   * `release` wakes a caller blocked in `spawnAndWait`, and is fired once the
   * entry's `start` has SETTLED rather than at drain time: startup is async
   * now, so releasing earlier would wake the caller before `record.promise`
   * exists and it would read a still-starting agent as one that never ran.
   * Removing an entry from this array MUST release it — a queued record has no
   * promise to await, and pi has no tool-execution timeout to bail the caller
   * out.
   */
  private queue: { id: string; pool: Pool; start: () => Promise<void>; release: () => void }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Number of currently running foreground (blocking) agents. */
  private runningForeground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onUsage?: OnAgentUsage,
    private readonly execution: AgentExecutionBackend = createEmbeddedExecutionBackend(),
    private readonly strictRetirement = false,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onUsage = onUsage;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Update the max concurrent foreground (blocking) agents limit. 0 = unlimited. */
  setMaxConcurrentForeground(n: number) {
    // Floor 0, not 1: unlimited is a meaningful value here and the default.
    this.maxConcurrentForeground = Math.max(0, n);
    // Start queued agents if the new limit allows — including everything, when
    // the limit is cleared back to unlimited mid-run.
    this.drainQueue();
  }

  getMaxConcurrentForeground(): number {
    return this.maxConcurrentForeground;
  }

  /**
   * Which pool a spawn is charged to, or undefined for one that is charged to
   * neither (nested children, detached non-background spawns).
   *
   * Nothing here queues when the limit is unset — `poolHasRoom` reports an
   * unlimited pool as always having room, so that alone is what keeps the
   * default path identical. The `> 0` guard is belt and braces on top: it also
   * keeps the counter from churning and the settle path from calling a drain
   * that would find nothing to do. Both are unobservable, which is why no test
   * pins them; the observable half — that the default start stays synchronous —
   * is pinned in `test/foreground-concurrency.test.ts`.
   */
  private poolFor(record: AgentRecord): Pool | undefined {
    if (occupiesPoolSlot(record)) return "background";
    if (this.maxConcurrentForeground > 0 && occupiesForegroundSlot(record)) return "foreground";
    return undefined;
  }

  private poolHasRoom(pool: Pool): boolean {
    return pool === "background"
      ? this.runningBackground < this.maxConcurrent
      : this.maxConcurrentForeground === 0 || this.runningForeground < this.maxConcurrentForeground;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   *
   * The id comes back synchronously, but with `isolation: "worktree"` the agent
   * is not running yet when it does — the repo copy is an awaited git call.
   * Callers that must fail a tool call on a startup failure await
   * `awaitStartup(id)`; everyone else sees it on the record (status "error").
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    options = { ...options, requiredTools: snapshotRequiredTools(options.requiredTools), promptBinding: snapshotPromptBinding(options.promptBinding) };
    if (this.disposed) throw new Error(i18n.t("managerRestore.disposed"));
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      // Owned children — nested, or a workflow's — are filtered out of every
      // top-level surface, so no handle: nothing can address them and they must
      // not consume a name a top-level sibling could otherwise take.
      handle: !isTopLevelAgent(options)
        ? undefined
        // A reclaimed handle is used as-is: it belongs to the conversation this
        // spawn is reopening, and re-deriving it would lose the numbering.
        : options.reclaim?.handle ?? assignHandle(handleBase(type), this.takenHandles()),
      description: options.description,
      // Reclaimed here, or filled in below from `name` — in which case it must
      // see the handle this record just took, since both come out of the same
      // namespace.
      alias: isTopLevelAgent(options) ? options.reclaim?.alias : undefined,
      // Overwritten below when the spawn is actually queued; a foreground spawn
      // that queues flips to "queued" there rather than being guessed at here,
      // since the pool decision needs the finished record.
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      // Whether anyone is awaiting this agent is a property of the agent, not
      // of the call that made it — and both settle paths need it long after
      // `options` has stopped being the interesting object.
      blocking: options.blocking,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      workflowId: options.workflowId,
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId: options.rootSessionId,
    };
    this.agents.set(id, record);
    // After the insert, so `takenHandles()` already counts this record's own
    // handle — a spawn named after its own type gets `explore-2`, not a
    // duplicate `explore` that would make resolution ambiguous.
    if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
      record.alias = assignHandle(handleBase(options.name), this.takenHandles());
    }

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    const pool = this.poolFor(record);
    if (pool !== undefined && !options.bypassQueue && !this.poolHasRoom(pool)) {
      // Queue it — started when a running agent in the same pool completes.
      // Idempotent for background (already "queued"); the flip that matters is
      // a blocking foreground spawn, optimistically marked "running" above.
      record.status = "queued";
      // A queued record never reaches startAgent's signal wiring, so arm the
      // parent abort here or Esc could not release the position.
      if (!this.armQueuedAbort(id, options.signal)) return id;
      let release!: () => void;
      record.startGate = new Promise<void>(resolve => { release = resolve; });
      this.queue.push({
        id,
        pool,
        start: () => this.launch(id, record, args, pool),
        release: () => release(),
      });
      options.onQueued?.(id, this.queue.filter(e => e.pool === pool).length - 1);
      return id;
    }

    this.launch(id, record, args, undefined);
    return id;
  }

  /**
   * Adopt a backend-restored idle session. No prompt, run callback, historical result
   * or pool slot is produced; only a later resume enters the existing scheduler.
   */
  async restore(
    reference: PersistentSessionReference,
    options: RestoreOptions,
  ): Promise<{ id: string; record: AgentRecord }> {
    if (!isPersistentReference(reference)) throw new Error(i18n.t("managerRestore.invalidReference"));
    if (!options || typeof options !== "object" || Array.isArray(options) ||
      typeof options.type !== "string" || !options.type.trim() ||
      typeof options.description !== "string" || !options.description.trim() ||
      (options.name !== undefined && typeof options.name !== "string") ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
      throw new Error(i18n.t("managerRestore.invalidOptions"));
    }
    const mode = options.mode === undefined ? "reattach" : options.mode;
    if (reference.backend !== this.execution.kind) throw new Error(i18n.t("managerRestore.backendMismatch"));
    if (mode !== "reattach" && mode !== "fork") throw new Error(i18n.t("managerRestore.invalidMode"));
    const restore = this.execution[mode];
    if (typeof restore !== "function") throw new Error(i18n.t("managerRestore.unsupported", { mode, backend: this.execution.kind }));
    if (this.disposed) throw new Error(i18n.t("managerRestore.disposed"));
    if (options.signal?.aborted) throw new Error(i18n.t("managerRestore.cancelled"));

    // Snapshot identity and metadata before yielding; caller mutation cannot retarget
    // the reservation or change ownership while backend preparation is pending.
    reference = Object.freeze({ ...reference });
    options = { ...options, promptBinding: snapshotPromptBinding(options.promptBinding) };
    if (mode === "reattach") {
      this.assertRestoreAvailable(reference);
      this.restoreReservations.add(reference);
    }

    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onParentAbort, { once: true });
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error(i18n.t("managerRestore.cancelled")));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const assertActive = () => {
      if (this.disposed || controller.signal.aborted) throw new Error(i18n.t("managerRestore.cancelled"));
    };

    // Defer backend entry until the task is registered: even synchronous backend
    // hooks that reset/dispose the manager must find and cancel this restoration.
    const acquiring = Promise.resolve().then(() => {
      assertActive();
      return restore.call(this.execution, reference, {
        ctx: options.ctx,
        structuredOutput: options.structuredOutput,
        promptBinding: options.promptBinding,
        signal: controller.signal,
      });
    });
    const adoption = Promise.race([acquiring, cancelled]).then(session => {
      assertActive();
      const restored = session?.reference;
      if (!isPersistentReference(restored) || restored.backend !== this.execution.kind ||
        (mode === "reattach"
          ? restored.sessionId !== reference.sessionId || sessionPath(restored.sessionFile) !== sessionPath(reference.sessionFile)
          : sameSession(restored, reference))) {
        throw new Error(i18n.t("managerRestore.invalidSession"));
      }
      this.assertRestoreAvailable(restored, reference);

      const id = randomUUID().slice(0, 17);
      const record: AgentRecord = {
        id,
        type: options.type,
        description: options.description,
        handle: isTopLevelAgent(options) ? assignHandle(handleBase(options.type), this.takenHandles()) : undefined,
        status: "idle",
        session,
        sessionFile: restored.sessionFile,
        startedAt: Date.now(),
        resultConsumed: true,
        toolUses: 0,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
        invocation: {
          ...(session.model ? describeModel(session.model) : {}),
          ...(session.thinkingLevel ? { thinking: session.thinkingLevel } : {}),
        },
        workflowId: options.workflowId,
        parentAgentId: options.parentAgentId,
        depth: options.depth ?? 1,
        maxSubagentDepth: options.maxSubagentDepth,
        rootSessionId: options.rootSessionId,
      };
      if (record.handle !== undefined && options.name !== undefined) {
        const taken = this.takenHandles();
        taken.add(record.handle);
        record.alias = assignHandle(handleBase(options.name), taken);
      }
      assertActive();
      this.agents.set(id, record);
      return { id, record };
    });
    const settled = Promise.allSettled([acquiring, adoption]).then(async ([acquired, adopted]) => {
      if (acquired.status === "fulfilled" && adopted.status === "rejected") {
        const session = acquired.value;
        // A broken backend may hand back the very handle already in the map.
        // Reject that duplicate without closing the original owner's session.
        if (session && typeof session === "object" && ![...this.agents.values()].some(record => record.session === session)) {
          await this.shutdownSession(session);
        }
      }
    }).finally(() => {
      this.restoreReservations.delete(reference);
      this.restorations.delete(controller);
    });
    this.restorations.set(controller, settled);
    try {
      // The caller stops waiting immediately; acquisition and cleanup remain tracked.
      return await adoption;
    } finally {
      options.signal?.removeEventListener("abort", onParentAbort);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  private assertRestoreAvailable(reference: SessionReference, ownReservation?: SessionReference): void {
    const references = [
      ...[...this.agents.values()].flatMap(record => record.session ? [record.session.reference] : []),
      ...[...this.shutdowns.keys()].map(session => session.reference),
      ...[...this.restoreReservations].filter(reserved => reserved !== ownReservation),
    ];
    if (references.some(owned => owned && sameSession(owned, reference))) {
      throw new Error(i18n.t("managerRestore.duplicate"));
    }
  }

  /**
   * Wire a parent abort signal for a record that is about to be QUEUED.
   * `startAgent` does this for running agents, and a queued record never gets
   * there, so without this Esc could not release a queue position.
   *
   * Returns false when the signal is ALREADY aborted, in which case the record
   * is stopped here and must not be enqueued: `addEventListener` never fires on
   * an aborted signal, so a `spawnAndWait` on it would wait forever — pi has no
   * tool-execution timeout to bail it out.
   *
   * The listener is left in place when the agent starts. `startAgent` adds its
   * own, so both fire on a later abort, but `abort()` on an already-stopped
   * record is a no-op — so detaching would only be tidiness, and tidiness the
   * `abortAll`/`dispose` paths could not offer anyway.
   */
  private armQueuedAbort(id: string, signal?: AbortSignal): boolean {
    if (signal === undefined) return true;
    if (signal.aborted) {
      const record = this.agents.get(id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
      }
      return false;
    }
    signal.addEventListener("abort", () => this.abort(id), { once: true });
    return true;
  }

  /**
   * Kick off an agent's startup and register it under `startups`. The returned
   * promise never rejects — the failure is delivered through `awaitStartup`,
   * and to the record.
   *
   * @param queuedPool - The pool this start was QUEUED on, or undefined for an
   *   immediate start. A queue drain can be minutes after `spawn()` returned,
   *   and nobody is awaiting `awaitStartup` by then, so a failure has to live
   *   on the record as status "error" — what drainQueue did when the throw was
   *   still synchronous. An immediate start instead drops the record, exactly
   *   as the throw out of `spawn()` did: no orphan in `listAgents()`, and the
   *   handle goes back.
   */
  private launch(id: string, record: AgentRecord, args: SpawnArgs, queuedPool: Pool | undefined): Promise<void> {
    const finishInvocation = this.beginInvocation(id);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const startup = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    // Register before callbacks, without deferring the synchronous default launch.
    this.startups.set(id, startup);
    void this.startAgent(id, record, args, finishInvocation).then(
      () => {
        this.startups.delete(id);
        // A stopped startup never assigned a run promise; otherwise its finally owns release.
        if (!record.promise) finishInvocation();
      },
      (err) => {
        this.startups.delete(id);
        try {
          if (queuedPool !== undefined && !this.disposed && this.agents.get(id) === record) {
            // An inline caller receives this failure itself, not a second notification.
            if (queuedPool === "foreground") record.resultConsumed = true;
            record.status = "error";
            record.error = err instanceof Error ? err.message : String(err);
            record.completedAt = Date.now();
            this.onComplete?.(record);
          } else {
            this.retained.delete(record);
            if (this.agents.get(id) === record) this.agents.delete(id);
          }
          this.drainQueue();
          throw err;
        } finally {
          if (!record.promise) finishInvocation();
        }
      },
    ).then(resolve, reject);
    // Nothing is obliged to await `startups` — swallow the rejection once here
    // so an unawaited startup can't take the process down, and hand callers
    // (drainQueue) that swallowed promise.
    return startup.catch(() => {});
  }

  /**
   * Resolves once the agent is actually running, and rejects with the startup
   * failure (strict worktree isolation) that `spawn()` used to throw before the
   * repo copy became async. Resolves immediately for an agent that is already
   * running, still queued, or unknown — so callers can await it unconditionally.
   *
   * Call it in the same tick as the `spawn()` it belongs to: a failed startup
   * takes its record (and this entry) with it, exactly as the throw did.
   */
  awaitStartup(id: string): Promise<void> {
    return this.startups.get(id) ?? Promise.resolve();
  }

  /** Reserve before any caller/backend callback, and release only after manager settlement. */
  private beginInvocation(id: string): () => void {
    const record = this.agents.get(id);
    if (record) this.settling.delete(record);
    let resolve!: () => void;
    const settled = new Promise<void>(done => { resolve = done; });
    this.invocations.set(id, settled);
    return () => {
      if (this.invocations.get(id) === settled) this.invocations.delete(id);
      resolve();
    };
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private async startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
    finishInvocation: () => void,
  ) {
    if (this.disposed || this.agents.get(id) !== record) return;
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Take the running state — and with it the concurrency slot — BEFORE the
    // first await. Creating a worktree is an awaited git call, and drainQueue
    // reads the pool counters synchronously in a loop: incrementing after the
    // await would let it start every queued agent at once while the first is
    // still copying its repo. Claiming "running" here also keeps abort() and
    // abortAll() able to reach an agent whose worktree is still being created.
    //
    // The pool is resolved ONCE, here, and carried to `settleRun` below:
    // `poolFor` reads `maxConcurrentForeground`, which the user can change from
    // `/agents → Settings` mid-run, so recomputing it at settle time would
    // decrement a pool this run never charged (counter underflow, limit
    // silently lifted) or skip the decrement for one it did (leaked slot —
    // every later blocking spawn queues forever). The two startup exits below
    // never reach `settleRun`, so they hand the slot back themselves.
    const pool = this.poolFor(record);
    const releaseSlot = () => {
      if (pool === "background") this.runningBackground--;
      else if (pool === "foreground") this.runningForeground--;
    };
    record.status = "running";
    record.startedAt = Date.now();
    record.startGate = undefined;
    if (pool === "background") this.runningBackground++;
    else if (pool === "foreground") this.runningForeground++;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done BEFORE
    // the run is kicked off so a failure doesn't leave a half-running agent.
    // The project switch is enforced here as well as at the tool boundary
    // because cross-extension RPC forwards its options unvalidated — a schema
    // that omits the field can't stop a caller that never saw the schema.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree" && isWorktreeIsolationEnabled()) {
      let wt: Awaited<ReturnType<typeof createWorktree>>;
      try { wt = await createWorktree(pi, baseCwd, id); }
      catch (error) { releaseSlot(); throw error; }
      if (!wt) {
        releaseSlot();
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);

      // No longer "running" means a stop landed while the copy was being made
      // (abort(), abortAll()) — a window that did not exist when creation was
      // synchronous. The record is already terminal, so launching the run would
      // burn tokens on work nobody is waiting for: discard the fresh (and by
      // definition unchanged) worktree instead.
      if (record.status !== "running" || this.disposed || this.agents.get(id) !== record) {
        releaseSlot();
        record.worktreeResult = await cleanupWorktree(pi, baseCwd, wt, options.description);
        this.drainQueue();
        return;
      }
    }

    try { this.onStart?.(record); }
    catch (error) {
      releaseSlot();
      if (record.worktree) {
        try { record.worktreeResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description); } catch { /* best effort */ }
      }
      throw error;
    }
    if (this.disposed || this.agents.get(id) !== record) {
      releaseSlot();
      if (record.worktree) record.worktreeResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
      this.drainQueue();
      return;
    }

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      // A queued spawn can start minutes after the caller handed us its signal,
      // by which time it may already be aborted — and `addEventListener` would
      // never fire, leaving a child the parent can no longer reach.
      if (options.signal.aborted) this.abort(id);
      else {
        const onParentAbort = () => this.abort(id);
        options.signal.addEventListener("abort", onParentAbort, { once: true });
        detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
      }
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    const runOptions: ExecutionRunOptions = {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      structuredOutput: options.structuredOutput,
      requiredTools: options.requiredTools,
      promptBinding: options.promptBinding,
      resumeSessionFile: options.resumeSessionFile,
      nested: options.parentAgentId !== undefined,
      workflow: options.workflowId !== undefined,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      // Set iff a worktree was created (see above) — names the directory the
      // copy came from, so the prompt can tell the agent not to work there.
      worktreeBase: worktreeCwd ? baseCwd : undefined,
      configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onSessionCreated: (session) => {
        if (this.disposed || this.agents.get(id) !== record) {
          void this.shutdownRecordSession(record, session);
          return;
        }
        record.session = session;
        // Capture now, while the session object exists: after eviction this
        // path is the only thing that can reopen the conversation, and an
        // in-memory session reports undefined, which correctly means
        // "nothing to come back to".
        // Native SDK compatibility lives in the adapter; the manager only sees identity data.
        record.sessionFile = session.reference.sessionFile;
        // Same reason, different field: the model and thinking level are only
        // knowable once pi has resolved its defaults and clamped the level to
        // what the model supports. Writing them back here makes the record
        // authoritative, so every surface reads one place instead of each
        // re-deriving "session, else the request" for itself.
        if (session.model) {
          record.invocation ??= {};
          // Read the kept request first: a caller's level survives being clamped
          // AND, one line later, being replaced by the effective one.
          const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
          Object.assign(record.invocation, describeModel(session.model));
          // Guarded for the reason above: a session that reports no level keeps
          // the request rather than losing it. Overwriting unconditionally would
          // turn an older or stubbed session into a blank `thinking:` tag, which
          // is worse than the stale-but-true value it replaced.
          if (session.thinkingLevel) {
            record.invocation.thinking = session.thinkingLevel;
            if (requested && requested !== session.thinkingLevel) {
              record.invocation.requestedThinking = requested;
            }
          }
        }
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            this.execution.steer(session, msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    };
    let running: Promise<ExecutionRunResult>;
    try { running = this.execution.run(ctx, type, prompt, runOptions); }
    catch (error) {
      detach();
      releaseSlot();
      if (record.session) await this.shutdownRecordSession(record, record.session);
      if (record.worktree) {
        try { record.worktreeResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description); } catch { /* best effort */ }
      }
      throw error;
    }
    const promise = running
      .then(async ({ responseText, session, aborted, steered, failure, structuredJson, structuredRetried }) => {
        this.settling.add(record);
        if (aborted && failure !== undefined) record.error = failure;
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          // Precedence: a hard abort keeps "aborted"; then a failed final turn
          // (provider error that pi resolved instead of rejecting, #144) is an
          // honest "error" — not a completion with an empty or stale result.
          if (aborted) {
            record.status = "aborted";
          } else if (failure) {
            record.status = "error";
            record.error = failure;
          } else {
            record.status = steered ? "steered" : "completed";
          }
        }
        record.result = responseText;
        // Kept beside `result`, never inside it: `result` is prose meant for a
        // reader — it is previewed, transcribed, and appended to below — while
        // this is a machine-readable payload one caller asked for by schema.
        record.structuredJson = structuredJson;
        record.structuredRetried = structuredRetried;
        if (this.disposed || this.agents.get(id) !== record) await this.shutdownRecordSession(record, session);
        else record.session = session;
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used
        if (record.worktree) {
          // The one moment the child's tree still exists and the child is done
          // writing to it. try/catch, not decoration: a hook that throws must
          // not leave the worktree behind.
          if (options.onBeforeWorktreeCleanup) {
            try {
              await options.onBeforeWorktreeCleanup(record.worktree.path);
            } catch { /* ignore — never block cleanup */ }
          }
          const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            // With a caller-supplied cwd the branch lives in THAT repo, not the
            // parent session's — say so, or the orchestrator merges in the wrong repo.
            const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
            // Appended to the prose only. A structured child's caller parses
            // `structuredJson`, which stays untouched — but `result` is also
            // what a human reads, so the note still belongs on it.
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
          }
        }

        this.abortOwnedChildren(id);

        this.settleRun(record, true, pool);
        return responseText;
      })
      .catch(async (err) => {
        this.settling.add(record);
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
        }

        this.abortOwnedChildren(id);

        this.settleRun(record, false, pool);
        return "";
      }).finally(finishInvocation);

    record.promise = promise;

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming
    // starts. Read off the options, so a spawn that started from a queue drain
    // still reaches the caller that queued it.
    if (!this.disposed && this.agents.get(id) === record) {
      // Dispatch already happened; observational wiring cannot turn it into a lost startup.
      try { options.onSpawned?.(id); } catch { /* keep ownership until normal settlement */ }
    }
  }

  /**
   * The shared tail of both settle paths: release whatever pool slot the run
   * held, notify, and let the queue drain into the freed slot.
   *
   * The decrement lives HERE and nowhere else. `abort()` on a running record
   * only fires its controller and leaves the run to settle normally, so
   * decrementing there too would double-free — permanently lifting the limit.
   *
   * Foreground agents fire `onComplete` for lifecycle symmetry, with
   * `resultConsumed` set so the callback skips notifications the inline result
   * already delivered.
   *
   * @param guardCallback swallow a throwing `onComplete` (the success path does;
   *   the error path historically did not, and keeps not doing so).
   * @param pool the pool this run was CHARGED TO at start time — passed in, not
   *   recomputed, so a mid-run change to `maxConcurrentForeground` can't make
   *   the release disagree with the acquire.
   */
  private settleRun(record: AgentRecord, guardCallback: boolean, pool: Pool | undefined): void {
    if (!record.isBackground) record.resultConsumed = true;
    if (pool === "background") this.runningBackground--;
    else if (pool === "foreground") this.runningForeground--;

    if (!this.disposed && this.agents.get(record.id) === record) {
      if (guardCallback) {
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      } else {
        this.onComplete?.(record);
      }
    }

    // The isBackground half reproduces the pre-pool condition exactly — a
    // background settle has always drained, even for a nested child that held
    // no slot — so that path is unchanged whether or not the foreground pool is
    // on. The `pool` half only adds the drain a freed FOREGROUND slot needs.
    // A drain with nothing freed is a no-op anyway, but "no-op" is a claim
    // about reachability, and matching the old condition needs no such claim.
    if (record.isBackground || pool !== undefined) this.drainQueue();
  }

  /**
   * Stop the nested children a settled parent owns. Nested records are hidden
   * from the UI and only their owner can consume them, so a child outliving its
   * parent would burn tokens unseen with no way to reach it. Grandchildren are
   * covered transitively — each abort lands in that child's own settle path.
   */
  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.agents) {
      if (record.parentAgentId === parentId) this.abort(id);
    }
  }

  /**
   * Start queued agents up to each pool's concurrency limit.
   *
   * `findIndex` on the entry's OWN pool rather than `shift`: with one queue
   * serving two independent limits, a saturated foreground pool at the head
   * would otherwise stall every background agent behind it. Taking the earliest
   * eligible entry keeps FIFO within each pool, which is what callers see.
   */
  private drainQueue() {
    if (this.disposed) return;
    for (;;) {
      const i = this.queue.findIndex(e => this.poolHasRoom(e.pool));
      if (i === -1) return;
      const [next] = this.queue.splice(i, 1);
      const record = this.agents.get(next.id);
      // Stale entries (aborted while queued) are not started — but are still
      // released, since nothing else will.
      if (!record || record.status !== "queued") { next.release(); continue; }
      // Detached, and never rejects: a late failure (e.g. strict worktree
      // isolation) lands on the record inside `launch`, exactly as the
      // synchronous throw did here before, and draining continues either way.
      //
      // The release waits for that startup to SETTLE rather than firing here.
      // Startup is async now, so a release at drain time would wake a blocked
      // `spawnAndWait` while `record.promise` was still undefined, and it would
      // read a perfectly healthy agent as one that never ran.
      void next.start().then(() => next.release(), () => next.release());
    }
  }

  /**
   * Remove queued entries and wake anyone blocked on them. The single point
   * that enforces "leaving the queue releases the waiter" — a missed release is
   * an unbounded hang, not a failed call.
   */
  private dequeue(pred: (entry: { id: string; pool: Pool }) => boolean): void {
    const kept: typeof this.queue = [];
    for (const entry of this.queue) {
      if (pred(entry)) entry.release();
      else kept.push(entry);
    }
    this.queue = kept;
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Charged to the foreground pool (`maxConcurrentForeground`), which is
   * unlimited by default; never to the background one.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously once the run is kicked off, before
   *   onSessionCreated fires. Use this to set record.outputFile so
   *   streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    // `blocking` is what maxConcurrentForeground bounds, and this is its only
    // source. onSpawned rides on the options rather than on a field of this
    // manager: a queued spawn starts at drain time, long after any install/
    // restore pair around this call would have put the field back — and it now
    // fires after an await (worktree creation) even on the immediate path.
    const id = this.spawn(pi, ctx, type, prompt, {
      ...options,
      isBackground: false,
      blocking: true,
      onSpawned,
    });
    const record = this.agents.get(id)!;

    // Queued: nothing to await yet — the promise appears when the drain starts
    // it. The gate resolves (never rejects) on every path out of the queue,
    // start and abort alike, so a rejection can never escape into the caller's
    // tool `execute` and take down pi's whole Promise.all tool batch.
    if (record.status === "queued") await record.startGate;

    // The run promise only exists once startup is past its awaited repo copy —
    // without this the call would return before the agent had started at all.
    // A startup failure (strict worktree isolation) rejects here, which is what
    // the immediate path owes its caller: pi only marks a tool result failed
    // when `execute` throws. A queued spawn's failure landed on the record
    // instead (nobody was awaiting `startups` at drain time) and is rethrown
    // below, so the contract is the same either way.
    await this.awaitStartup(id);

    // undefined when it was aborted while queued, or stopped mid-copy, and so
    // never ran — the record is already terminal with a completedAt, which is
    // what the caller renders.
    if (record.promise) await record.promise;

    // A record that ended "error" without ever getting a promise never ran: the
    // same startup failure spawn() rethrows on the immediate path (#179). Keep
    // one contract rather than letting queue pressure decide whether a strict
    // worktree failure throws or returns as a result.
    if (record.promise === undefined && record.status === "error") {
      throw new Error(record.error ?? "Agent failed to start");
    }
    return { id, record };
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    options = { ...options, requiredTools: snapshotRequiredTools(options?.requiredTools) };
    const record = this.agents.get(id);
    if (this.disposed || !record?.session) return undefined;
    // Abort changes the visible status immediately, not backend/settlement ownership.
    // A refused resume must not replace a live controller or clear its result fields.
    if (this.invocations.has(id) || record.status === "running" || record.status === "queued") return undefined;

    // Background resume: settle asynchronously and notify on completion exactly
    // like a background spawn, returning immediately with the record still
    // "running" — or "queued" when at the concurrency limit. Previously
    // run_in_background was ignored on resume (the Agent tool's resume branch
    // returned before its background branch, and resume() only ever awaited
    // inline), so a resumed agent always blocked the caller until it finished.
    if (options?.isBackground) {
      // Never re-enter a run that is still in flight. Detaching means the caller
      // gets control back while the record stays "running", so nothing stops the
      // model from resuming the same agent again. Starting a second run would
      // overwrite record.abortController — orphaning the live run beyond the
      // reach of `/agents` stop and abortAll() — double-count the pool slot, and
      // then reject from session.prompt() with "Agent is already processing",
      // whose settle path would abort the LIVE run's children and report a
      // failure for a run that is still going. Refuse instead, leaving the
      // record untouched; the caller decides whether to wait or steer.
      record.isBackground = true;
      record.resultConsumed = false;
      record.result = undefined;
      record.structuredJson = undefined;
      record.structuredRetried = undefined;
      record.error = undefined;
      record.completedAt = undefined;
      record.status = "queued";

      const start = () => this.startResume(id, record, prompt, signal, options);
      if (occupiesPoolSlot(record) && !this.poolHasRoom("background")) {
        // At the concurrency limit — queue it, drains when a slot frees. A
        // detached resume has no inline caller, hence nothing to release. The
        // queue is shared with spawns, whose startup is async, so entries are
        // promise-shaped even though a resume starts synchronously; failures
        // land on the record here, since drainQueue no longer catches.
        this.queue.push({
          id,
          pool: "background",
          start: async () => {
            try {
              start();
            } catch (err) {
              applyResumeError(record, err);
              record.completedAt ??= Date.now();
              this.onComplete?.(record);
            }
          },
          release: () => {},
        });
      } else {
        start();
      }
      return record;
    }

    // Foreground resume: run inline and return the settled record, without a pool slot.
    const finishInvocation = this.beginInvocation(id);
    const session = record.session;
    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.structuredJson = undefined;
    record.structuredRetried = undefined;
    record.error = undefined;
    const abortController = new AbortController();
    record.abortController = abortController;
    const onParentAbort = () => { if (record.abortController === abortController && !abortController.signal.aborted) this.abort(id); };
    if (signal?.aborted) onParentAbort();
    else signal?.addEventListener("abort", onParentAbort, { once: true });

    record.promise = (async () => {
      try {
        if (this.disposed || this.agents.get(id) !== record) return "";
        const result = await this.execution.resume(session, prompt, {
          requiredTools: options?.requiredTools,
          onToolActivity: (activity) => {
            if (activity.type === "end") record.toolUses++;
            options?.onToolActivity?.(activity);
          },
          onAssistantUsage: (usage) => {
            addUsage(record.lifetimeUsage, usage);
            this.onUsage?.(record, usage);
            options?.onAssistantUsage?.(usage);
          },
          onCompaction: (info) => {
            record.compactionCount++;
            this.onCompact?.(record, info);
            options?.onCompaction?.(info);
          },
          signal: abortController.signal,
        });
        applyResumeResult(record, result);
        return result.text;
      } catch (err) {
        applyResumeError(record, err);
        return "";
      } finally {
        record.completedAt ??= Date.now();
        signal?.removeEventListener("abort", onParentAbort);
        // The exposed promise includes metadata, signal teardown and owned-child cleanup.
        this.abortOwnedChildren(id);
      }
    })().finally(finishInvocation);

    await record.promise;
    return record;
  }

  /**
   * Start a background resume run: detached, settling and notifying like
   * startAgent's background path. Invoked immediately, or from drainQueue when
   * a concurrency slot frees. The session already exists (resume reuses it), so
   * there is no onSessionCreated to hang per-run wiring off — callers use
   * `options.onStarted`, which fires on both the immediate and the drained path.
   */
  private startResume(
    id: string,
    record: AgentRecord,
    prompt: string,
    parentSignal: AbortSignal | undefined,
    options: ResumeOptions,
  ) {
    if (this.disposed || !record.session || this.agents.get(id) !== record) return;
    const session = record.session;
    const finishInvocation = this.beginInvocation(id);
    const holdsSlot = occupiesPoolSlot(record);
    record.status = "running";
    record.startedAt = Date.now();
    if (holdsSlot) this.runningBackground++;

    // Fresh abort controller so /agents stop and steering target THIS run rather
    // than the previous one's settled controller.
    const abortController = new AbortController();
    record.abortController = abortController;
    // Optional, and NOT what the Agent tool passes for a detached resume: a
    // parent signal aborts on the parent's own interrupt (user Esc), which is
    // right for a foreground run whose result the caller is awaiting, and wrong
    // for a detached one — background spawns omit it for exactly this reason.
    let detachParentSignal: (() => void) | undefined;
    if (parentSignal) {
      const onParentAbort = () => { if (record.abortController === abortController && !abortController.signal.aborted) this.abort(id); };
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
      if (parentSignal.aborted) onParentAbort();
    }

    const settle = () => {
      detachParentSignal?.();
      detachParentSignal = undefined;
      // Final flush of streaming output file
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }
      // Children spawned during the resumed turn must not outlive it.
      this.abortOwnedChildren(id);
      if (holdsSlot) this.runningBackground--;
      if (!this.disposed && this.agents.get(id) === record) {
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      }
      this.drainQueue();
    };

    record.promise = (async () => {
      try {
        this.onStart?.(record);
        // Per-run output wiring runs under the reservation and fresh controller.
        if (this.disposed || this.agents.get(id) !== record) return "";
        try { options.onStarted?.(); } catch { /* ignore caller wiring errors */ }
        if (this.disposed || this.agents.get(id) !== record) return "";
        const result = await this.execution.resume(session, prompt, {
          requiredTools: options.requiredTools,
          onToolActivity: (activity) => {
            if (activity.type === "end") record.toolUses++;
            options.onToolActivity?.(activity);
          },
          onAssistantUsage: (usage) => {
            addUsage(record.lifetimeUsage, usage);
            this.onUsage?.(record, usage);
            options.onAssistantUsage?.(usage);
          },
          onCompaction: (info) => {
            record.compactionCount++;
            this.onCompact?.(record, info);
            options.onCompaction?.(info);
          },
          signal: abortController.signal,
        });
        applyResumeResult(record, result);
        return result.text;
      } catch (err) {
        applyResumeError(record, err);
        return "";
      } finally {
        record.completedAt ??= Date.now();
        settle();
      }
    })().finally(finishInvocation);
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const delivery = this.deliverSteer(id, message);
    if (delivery === false) return false;
    void delivery.catch(() => {});
    return true;
  }

  /** Tool callers await delivery so a failed steer is not announced as successful. */
  async steerAndWait(id: string, message: string): Promise<boolean> {
    const delivery = this.deliverSteer(id, message);
    if (delivery === false) return false;
    await delivery;
    return true;
  }

  private deliverSteer(id: string, message: string): Promise<void> | false {
    const record = this.agents.get(id);
    if (!record || (record.status !== "running" && record.status !== "queued")) return false;
    if (record.session) return this.execution.steer(record.session, message);
    (record.pendingSteers ??= []).push(message);
    return Promise.resolve();
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** Handles already in use, so a fresh spawn can pick an unclaimed one. */
  private takenHandles(): Set<string> {
    const taken = new Set<string>();
    for (const record of this.agents.values()) {
      if (record.handle) taken.add(record.handle);
      if (record.alias) taken.add(record.alias);
    }
    // Tombstones hold their names too: an evicted `@explore` is still
    // resurrectable, so a later Explore must become `explore-2` rather than
    // shadowing a conversation the user can still reach.
    for (const entry of this.tombstones.values()) {
      taken.add(entry.handle);
      if (entry.alias) taken.add(entry.alias);
    }
    return taken;
  }

  /**
   * Resolve an `@name` from the prompt. Matches a top-level agent's handle
   * case-insensitively, preferring one that can still be steered and otherwise
   * the most recently started (which is the one a resume should continue), then
   * falls back to an exact agent id so `@<agentId>` works too.
   */
  resolveMention(name: string): MentionResolution | undefined {
    const wanted = name.toLowerCase();
    let fallback: AgentRecord | undefined;
    for (const record of this.agents.values()) {
      if (!isTopLevelAgent(record)) continue;
      // Handle and alias share one namespace, so at most one agent answers a
      // name and it makes no difference which of the two matched.
      if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
      if (record.status === "running" || record.status === "queued") return { kind: "live", record };
      if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
    }
    if (fallback) return { kind: "live", record: fallback };
    const byId = this.agents.get(name);
    if (byId !== undefined && isTopLevelAgent(byId)) return { kind: "live", record: byId };
    // Only once nothing live answers: a tombstone is a conversation to reopen,
    // and reopening one while its record still exists would fork the session.
    for (const entry of this.tombstones.values()) {
      if (entry.handle.toLowerCase() === wanted || entry.alias?.toLowerCase() === wanted || entry.id === name) {
        return { kind: "tombstone", entry };
      }
    }
    return undefined;
  }

  /**
   * Forget an evicted agent, by handle. For the case where its session file has
   * gone: the entry can then only ever fail, while still holding the name
   * against the type that would otherwise start a fresh agent under it.
   *
   * A *successful* resume does not drop its tombstone — the live record it
   * creates already wins in `resolveMention`, and overwrites the entry in place
   * when it is itself evicted.
   */
  dropTombstone(handle: string): void {
    this.tombstones.delete(handle);
  }

  /** Evicted agents whose conversation can still be reopened, newest first. */
  listTombstones(): AgentTombstone[] {
    return [...this.tombstones.values()].sort((a, b) => b.completedAt - a.completedAt);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued. No decrement — the slot was never taken —
    // and no onComplete, matching what a queued background abort has always
    // done; a blocking caller learns of the stop from its own tool result.
    if (record.status === "queued") {
      this.dequeue(q => q.id === id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /** Pin this record against timed GC, not explicit release/reset/disposal. */
  retain(id: string): () => void {
    const record = this.agents.get(id);
    if (!record) throw new Error(i18n.t("manager.unknownRecord", { id }));
    let pins = this.retained.get(record);
    if (!pins) this.retained.set(record, pins = new Set());
    const token = Symbol();
    pins.add(token);
    return () => {
      if (this.retained.get(record) !== pins || !pins.delete(token)) return;
      if (pins.size === 0) this.retained.delete(record);
    };
  }

  /**
   * Relinquish one record, closing admission synchronously. Unknown IDs are a noop;
   * concurrent callers share cleanup. No sibling or backend-wide shutdown occurs.
   *
   * Await known handles, worktree startup and settlement already owned by the manager,
   * never an opaque backend invocation. Late handles/results retain their detached
   * cleanup paths. Legacy completion does not certify backend retirement; strict
   * managed owners reject with known retirement failures after bounded cleanup.
   */
  release(id: string): Promise<void> {
    const pending = this.releases.get(id);
    if (pending) return pending;
    const record = this.agents.get(id);
    if (!record) return Promise.resolve();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const released = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void released.catch(() => {});
    // Publish before abort/shutdown callbacks can reenter release().
    this.releases.set(id, released);
    const startup = this.startups.get(id);
    const invocation = this.invocations.get(id);
    const session = record.session;
    this.agents.delete(id);
    this.retained.delete(record);
    record.session = undefined;
    record.pendingSteers = undefined;
    const active = record.status === "running" || record.status === "queued";
    if (active) {
      record.status = "stopped";
      record.completedAt ??= Date.now();
    }
    if (active || invocation) record.abortController?.abort();
    this.dequeue(entry => entry.id === id);
    this.abortOwnedChildren(id);
    if (!invocation) this.startups.delete(id);
    // Unlike manager disposal, scoped release must never call shutdown(undefined).
    if (session) void this.shutdownRecordSession(record, session);
    this.drainQueue();
    void (async () => {
      try {
        await Promise.allSettled(startup ? [startup] : []);
        // Include handles published during startup or another shutdown callback, but
        // never wait for unrelated records' cleanup or for unpublished backend work.
        while (this.recordShutdowns.get(record)?.size) {
          await Promise.allSettled([...this.recordShutdowns.get(record)!]);
        }
        if (invocation && this.settling.has(record)) await invocation;
        const failures = this.recordRetirementFailures.get(record);
        if (this.strictRetirement && failures?.length) reject(retirementFailure(failures));
        else resolve();
      } catch (error) { reject(error); }
      finally { this.releases.delete(id); }
    })();
    return released;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    this.tombstone(record);
    void this.release(id);
  }

  private shutdownRecordSession(record: AgentRecord, session: ExecutionSession): Promise<void> {
    const pending = this.shutdownSession(session, record);
    let shutdowns = this.recordShutdowns.get(record);
    if (!shutdowns) this.recordShutdowns.set(record, shutdowns = new Set());
    shutdowns.add(pending);
    void pending.then(() => shutdowns.delete(pending));
    return pending;
  }

  private associateRecordRetirementFailure(record: AgentRecord, error: unknown): void {
    let failures = this.recordRetirementFailures.get(record);
    if (!failures) this.recordRetirementFailures.set(record, failures = []);
    if (!failures.includes(error)) failures.push(error);
  }

  private recordRetirementFailure(error: unknown, session?: ExecutionSession, record?: AgentRecord): void {
    if (!this.strictRetirement) return;
    this.retirementFailures.push(error);
    if (session) {
      let failures = this.sessionRetirementFailures.get(session);
      if (!failures) this.sessionRetirementFailures.set(session, failures = []);
      failures.push(error);
    }
    if (record) this.associateRecordRetirementFailure(record, error);
  }

  /** Observe every backend rejection; strict managed owners surface it at their owned barrier. */
  private shutdownSession(session: ExecutionSession | undefined, record?: AgentRecord): Promise<void> {
    if (session) {
      const closed = this.closedSessions.get(session);
      if (closed) {
        if (this.strictRetirement && record) void closed.then(() => {
          for (const error of this.sessionRetirementFailures.get(session) ?? []) {
            this.associateRecordRetirementFailure(record, error);
          }
        });
        return closed;
      }
    }
    let resolve!: () => void;
    const settled = new Promise<void>(done => { resolve = done; });
    if (session) {
      this.closedSessions.set(session, settled);
      this.shutdowns.set(session, settled);
    }
    const finish = () => {
      if (session) this.shutdowns.delete(session);
      resolve();
    };
    const failed = (error: unknown) => {
      this.recordRetirementFailure(error, session, record);
      finish();
    };
    try { Promise.resolve(this.execution.shutdown(session)).then(finish, failed); }
    catch (error) { failed(error); }
    return settled;
  }

  /**
   * Preserve enough of a departing record for `@handle` to reopen its
   * conversation later. Nothing to keep unless it has both a handle to be
   * addressed by and a session file to reopen — an in-memory session leaves no
   * transcript, so the mention would have nothing to continue from.
   */
  private tombstone(record: AgentRecord): void {
    if (!record.handle || !record.sessionFile) return;
    this.tombstones.set(record.handle, {
      handle: record.handle,
      alias: record.alias,
      id: record.id,
      type: record.type,
      description: record.description,
      sessionFile: record.sessionFile,
      completedAt: record.completedAt ?? Date.now(),
    });
    // Bound the memory a long session can accumulate. Oldest first, since the
    // agent someone still wants to reach is the one they used most recently.
    while (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = [...this.tombstones.values()].reduce((a, b) => (a.completedAt <= b.completedAt ? a : b));
      this.tombstones.delete(oldest.handle);
    }
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (this.retained.has(record)) continue;
      if ((record.status === "idle" ? record.startedAt : record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all idle/completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    this.retained = new WeakMap();
    // A session boundary also invalidates restorations that have not returned a
    // handle yet. Their late handles are closed, never inserted into the new session.
    for (const controller of this.restorations.keys()) controller.abort();
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
    // Unconditional: both callers are session boundaries (`session_start` and
    // `session_before_switch`), and `skipUnconsumed` only spares records whose
    // results the LLM has yet to read — it does not make the sweep partial in
    // the sense that matters here. A new session means new handles, or
    // `@explore` would silently reach an agent the user never started. Claude
    // Code resets its registry on `/clear` for the same reason.
    this.tombstones.clear();
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.dequeue(() => true);
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      // Includes stopped runs still draining, foreground resumes, and startup
      // callbacks before record.promise exists. Never waits on an old fulfilled run.
      const pending = [...this.invocations.values()];
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /**
   * @param pi - Needed to run `git worktree prune`, which is async now and so
   *   cannot be reached through a stored spawn argument at shutdown. Omitting
   *   it (tests, teardown of a manager that never spawned) skips the prune.
   */
  async dispose(pi?: ExtensionAPI): Promise<void> {
    this.disposed = true;
    clearInterval(this.cleanupInterval);
    for (const controller of this.restorations.keys()) controller.abort();
    // Abort before detaching: startup/backend preflight must observe disposal too.
    // abortAll also releases every queued caller without dispatching it.
    this.abortAll();
    const sessions = [...this.agents.values()].map(record => {
      const session = record.session;
      record.session = undefined;
      return { record, session };
    });
    const startups = [...this.startups.values()];
    this.agents.clear();
    this.retained = new WeakMap();
    if (pi) {
      // Prune any orphaned git worktrees (crash recovery). Detached: dispose runs
      // on the shutdown path, which cannot wait for git. Started before the awaited
      // shutdown below rather than after it, so the git calls have that window to
      // finish in instead of racing the process exit that follows.
      const prune = (repo: string) => { pruneWorktrees(pi, repo).catch(() => {}); };
      prune(process.cwd());
      // Also prune repos that caller-supplied cwds created worktrees in — a clean
      // exit with in-flight agents would otherwise leave stale registrations there.
      for (const repo of this.worktreeRepos) prune(repo);
    }
    // Await known handles, managed restores and manager-owned startup. run() has no
    // separate readiness promise: opaque backend preflight is cancelled by its signal;
    // late handle callbacks/results are closed above, without awaiting an unbounded run.
    const closing = sessions.map(({ record, session }) => this.shutdownSession(session, record));
    await Promise.allSettled([...closing, ...this.shutdowns.values(), ...this.restorations.values(), ...this.releases.values(), ...startups]);
    // Startup may finish a worktree copy or hand back a late session while we wait.
    await Promise.allSettled([...this.shutdowns.values()]);
    if (this.strictRetirement && this.retirementFailures.length) throw retirementFailure(this.retirementFailures);
  }
}

function retirementFailure(errors: readonly unknown[]): Error {
  if (errors.length === 1) {
    const error = errors[0];
    return error instanceof Error ? error : new Error(i18n.t("manager.retirementFailed"), { cause: error });
  }
  return new AggregateError([...errors], i18n.t("manager.retirementFailed"));
}
