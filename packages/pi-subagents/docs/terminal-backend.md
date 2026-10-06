# Private managed terminal execution backend

This document describes the isolated **managed** profile in
`src/backends/terminal/backend.ts`. `createTerminalExecutionBackend()` retains that
compatibility default; `createStandardTerminalExecutionBackend()` is the ordinary
product backend selected by `subagents.json`. See the [package README](../README.md)
for standard resources, interactive sessions and common Agent/RPC routing. Neither
private entry is selected by the root distribution profile yet.

## Supported private slice

- POSIX/Bash, isolated, autonomous invocations (`isolated: true`), with built-in tool policy,
  resolved model/thinking and the existing agent prompt builder.
- Fresh persisted session and subsequent invocations of an **owned** session handle.
  Resume retains its session ID/file/view and starts a fresh process, surface, run ID,
  feedback channel and artifact directory.
- Optional managed-session reattach/fork with persisted policy, clean checkpoints and
  handle-lifetime file leases; see [managed sessions](./managed-sessions.md).
- JSON Schema structured output, one bounded missing-output recovery, and resolved
  soft/grace/hard turn limits; these policies survive owned-session resume.
- Completion after the child reports `agent_settled` **and** its process exits.
- Read-only canonical transcript/model/context snapshots, text deltas, tool activity,
  turn/usage/compaction feedback, and acknowledged model steering.
- Cancellation and idempotent shutdown. Startup/bridge failures, cancellation and
  uncertain retirement quarantine the session: the backend will not reopen its file
  while another writer may remain. Read-only history remains available; uncertain/crashed
  writer recovery remains a later step.

Unsupported requests fail before launch rather than silently selecting embedded or
losing semantics: non-isolated execution, `inheritContext`, `resumeSessionFile`,
agent memory, and an explicit
`persistSession: false`. Isolated execution already disables nested delegation,
skills, and discovered extensions, matching the embedded isolated policy.

This is not the long-running interactive handoff mode: a visible Pi terminal may be
used while the task is running, but the process exits automatically after settlement.
These managed restrictions do not describe the standard product backend. Crash
and uncertain-writer takeover remain unsupported in this isolated profile.

## Launch and configuration

Use `createTerminalExecutionBackend(config, ports?)` as AgentManager's optional sixth
constructor argument in an isolated development integration. Do not activate both
subagent products in a normal profile during migration.

`TerminalBackendConfig` supplies optional `sessionDir`, `artifactDir`, `agentDir`,
`executable`/`executableArgs`, trusted `providerExtensions`, `mode` (`auto` or `json`),
`startupTimeoutMs` (30 seconds by default), and `exitTimeoutMs` (5 seconds after settled).
The lower-level preparer retains Bash/PowerShell command construction, but the real
backend currently rejects native Windows and PowerShell runtime selection until a
job/process-tree-aware transport is available.

The default executable is the current Node executable plus the CLI belonging to the
installed Pi SDK peer, not whichever unrelated `pi` command happens to be on PATH.
The launch policy disables automatic extensions, skills, templates, themes and context
files, disables automatic network/catalog refresh with `--offline`, and does not
approve target-project configuration. `--offline` does not disable the explicitly
requested model inference. Provider extensions are
explicit trusted inputs, not inherited tool resources; their additional tools remain
subject to the child allowlist. A parent-only registered provider must also be made
available in the child. Provider/model IDs and a hash of the selected API/base URL
are checked; mismatch is an error, not an implicit model fallback. Parent-only
runtime/provider overrides are not transplanted: the caller must supply matching
process-visible provider definitions and child authentication configuration.

New sessions have exclusively created v3 JSONL headers. The CLI receives `--session`
with that file. It must not combine `--session` with `--session-id`.

Each invocation gets a private artifact directory. Manifests and prompt/launch files
are written with restrictive permissions. Only model identifiers are serialized;
provider API keys, authorization headers and parent runtime objects are not copied.
Normal Pi credential resolution occurs in the child using its selected agent directory.

The supervisor starts the CLI without a shell, inherits terminal streams, and owns
a separate POSIX process group. On cancellation it also captures descendant groups
visible through `ps`, forwards termination, and escalates unresponsive owned groups.
A receipt is withheld if known-group retirement cannot be established. Deliberately
daemonized/escaped processes are outside this cooperation contract; this is not an
OS sandbox. Native Windows requires job-object lifetime guarantees and is rejected
rather than relying on signal handlers that TerminateProcess may bypass.

Only after retirement does the supervisor atomically write a per-run, token-bearing
exit receipt. Parent completion watches that private file, not screen text: assistant
or tool output containing the legacy sentinel cannot finish a run. The old stdout
marker remains compatibility output only. Missing receipts after settled hit the
retirement deadline, close the surface and quarantine the session.

## Structured output and turn budgets

Pass the existing `ExecutionRunOptions.structuredOutput` compiled schema and/or
`maxTurns`. Preparation snapshots a JSON-only schema, recompiles it before any
launch, and serializes schema data only, never validator functions. The child
registers `StructuredOutput` at session startup and admits it in addition to the
resolved builtin allowlist. It does not enable arbitrary provider tools. The tool
uses constrained sampling when available, throws validation errors as failed tool
results, and retains the last valid payload (including false/zero/null properties).

At `agent_before_settle`, a completed run without a valid payload may request one
extra provider turn through a hidden custom message and `continue: true`. This is
not a nested `prompt()` call or completion at `agent_end`. The parent revalidates
returned JSON against the immutable wire schema and the caller's validator; prose,
missing data and invalid feedback cannot become a successful structured answer.
A custom validator closure is parent-only: its rejection fails the run, but cannot
be used for a child-side corrective retry. Use a serializable JSON Schema for
validation the model needs to correct.

The effective soft limit follows explicit option > agent setting > project default;
zero remains an explicit unlimited override. The existing grace-turn setting is
snapshotted too. Every model `turn_end` counts, including recovery and schema-retry
turns. At the soft limit the child adds a wrap-up continuation once; at soft+grace it
aborts even if that last turn supplied an answer, matching the embedded fresh-run
boundary rule. These are turn counts, not wall-clock, tool-timeout or transport-retry
budgets. Cancellation, provider/policy errors and hard limits suppress schema retry.

An owned terminal resume retains the schema/limit policy, but starts a fresh capture,
retry allowance and turn counter. It never reconstructs output from old tool calls.
The manager carries `structuredJson`, `structuredRetried`, `aborted` and `steered`
through both resume paths and clears prior structured metadata when accepting a
resume. Status precedence is stopped > aborted > error > steered > completed.
Embedded owned-session resume now retains the same resolved schema/turn/grace policy
and refreshes per-invocation state. Its executor performs one sequential post-prompt
retry; terminal uses the actionable settlement boundary. The backend promise is the
completion authority for both. Normal retired policy failures may resume; uncertain
terminal process retirement still quarantines the handle.

## Feedback and control

Every invocation owns a transient **loopback-only** TCP listener on an OS-assigned
port. The child authenticates with a random token held in its private launch manifest
and matching run/session IDs. Pi does not accept the task until authentication and
an explicit parent start grant; this lets the parent wire output and queue early
steering before the first model request. No daemon, remote service or session-log polling is
required. This is a local cooperation protocol, not an OS sandbox or a security
boundary against trusted provider-extension code running as the same user.

Feedback uses versioned, sequenced UTF-8 NDJSON frames, bounded to 16 MiB per frame.
Malformed, stale, duplicated and out-of-order feedback fails closed. The protocol
never writes or consumes the legacy shared `sessionFile.exit` marker. Process
retirement receipt and the authenticated settled report are separate required signals.

Canonical snapshots come from Pi's session projection, not from concatenating every
raw JSONL branch. Text deltas feed live activity callbacks; transcript snapshots are
updated at lifecycle boundaries. Parent observers receive separate delivery microtasks
so compaction re-anchoring finishes before the next turn is flushed to output.
Unchanged message objects are retained across snapshots for viewer caches.

Steer requests carry request IDs and only resolve after the child acknowledges the
`sendUserMessage(..., { deliverAs: "steer" })` dispatch. Pre-prompt steering waits
for `agent_start` rather than accidentally starting a separate prompt. This means accepted/queued,
not already processed by the model. Escape is not substituted for model steering.
Connection loss aborts/shuts down the child; controls, listeners and timeouts are
cleaned up on every completion/error/cancel path.

## Validation and remaining work

Unit tests inject transport/bridge boundaries and explicitly exercise a local IPC
listener; they never need external network access. A dedicated real-process suite
uses the actual Pi CLI, a scripted in-process provider, temporary agent directories,
and explicit headless surfaces. It must not use API keys or a live mux daemon.

This backend is not a claim of full embedded parity. Before activation, add remaining
cross-backend session-store integration and child-policy capabilities, safe recovery of interrupted sessions,
configuration routing with sticky backend ownership, full localization, composition
checks and real terminal/Windows job-object support and smoke validation. Forced
cancellation can lose feedback/usage not yet flushed by the child. Existing package privacy and
release gates remain in force.
