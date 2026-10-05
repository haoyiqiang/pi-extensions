/**
 * Identifies what triggered a workflow run. Recorded in the JSONL
 * header (`WorkflowHeader.trigger`), threaded into every lifecycle
 * event (`LifecycleContext.trigger`), and surfaced on past-run
 * enumeration (`RunSummary.trigger`).
 *
 * `/wf` sets `{ kind: "command", name: "wf" }`. Programmatic embedders
 * default to `{ kind: "programmatic" }`. External trigger sources
 * (webhook, cron, sibling-extension spawn) set `{ kind: "external",
 * source, ref? }` so post-hoc readers can filter / route by origin.
 *
 * `meta` is an open escape hatch for trigger-specific payload (webhook
 * headers, cron expression, ticket id). Kept untyped to avoid growing
 * the union per consumer.
 *
 * Concurrency note: Pi is single-active-session. External triggers
 * (cron, webhook, sibling-extension spawn) MUST gate their own
 * spawning if a run is already in flight — the runtime does not
 * enforce a process-wide mutex. The same applies across PROCESSES:
 * the `names.json` claim protocol (state/names.ts) is atomic per write
 * (temp file + rename) but has no cross-process lock, so two concurrent
 * triggering processes claiming run names can race the read-modify-write
 * (lost update / duplicate claim; recoverable via `rebuildIndex`).
 */
export type RunTrigger =
	| { kind: "command"; name: string; meta?: Record<string, unknown> }
	| { kind: "programmatic"; source?: string; meta?: Record<string, unknown> }
	| { kind: "external"; source: string; ref?: string; meta?: Record<string, unknown> };

/**
 * Default when `RunWorkflowOptions.trigger` is omitted. Frozen — the literal
 * is shared by every run that omits `trigger`, so a mutation (e.g. via the
 * open `meta` escape hatch) would silently leak into unrelated runs.
 */
export const DEFAULT_TRIGGER: RunTrigger = Object.freeze({ kind: "programmatic" });
