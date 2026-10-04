# Private terminal lifecycle primitive

This batch extracts the Pi terminal-run lifecycle from the existing interactive
product without loading it in the root profile. It is **not** a selectable
`AgentExecutionBackend`, public API, workflow host, or replacement tool yet.

## Components

- `src/backends/session-reference.ts`: data-only session and run references. A
  session carries its backend, conversation ID, and optional persisted file; a run
  has a separate coordinator-assigned invocation ID. Terminal sessions must have a
  file. Resuming changes the run ID, not the session ID/file/backend.
- `src/backends/terminal/lifecycle.ts`: explicit launch, automatic completion
  promise, Escape forwarding, cancellation, and owned-surface cleanup.
- `src/backends/terminal/mux-adapter.ts`: delegates to the **public**
  `pi-terminal-mux` surface, script, Escape, and exit-wait APIs. Backend detection
  and the foundation's headless fallback remain there, not in a second detector.
- `src/backends/terminal/artifacts.ts`: removes a stale `.exit` marker before
  dispatch, snapshots the existing transcript, and extracts only this run's
  assistant output. It preserves the session and launch artifacts.

The primitive has no global running-agent registry, queue, widget, notifications,
agent discovery, or model-selection policy. The old product remains unchanged.
New diagnostics use the `pi-subagents` locale namespace; localization of the
imported embedded UI/prompts is still outstanding.

## Prepared-launch contract

The caller supplies a `TerminalLaunchPlan` and `TerminalDependencies`. The default
adapters are constructed with `createTerminalDependencies()`; construction itself
does not create surfaces, timers, or processes. Tests inject ports rather than
requiring a live multiplexer or model.

A plan contains the run/session reference, display name, absolute launch-script
path, a command builder receiving the owned surface, optional `bash`/`powershell`
interpreter, shell readiness delay (default 500 ms), caller abort signal, and an
observational tick callback. Omitted interpreter retains the foundation's Bash
default; callers on native Windows without Bash must explicitly choose `powershell`
and construct a PowerShell command/script path. No OS-based shell guessing occurs.
Normalized script paths that equal the session file or its `.exit` marker are rejected;
callers still own trusted path selection (including filesystem aliases).

The caller must prepare session storage and CLI/model/tool/extension policy before
launch. The command must use the designated session file and session ID (for a fresh
Pi CLI session, use the matching `--session` and `--session-id`, or prepare a correct
session header). The transcript reader rejects mismatched IDs rather than silently
reporting a different conversation. Command construction and child-extension
selection are not migrated in this batch.

Only fresh, owned terminal surfaces are supported. A later run may use the same
persistent session in a **new** surface; the caller must serialize writers to that
file and assign a fresh run ID/script path. No existing pane is adopted, so stale
screen sentinels from a previous run cannot complete the new run.

## Cancellation and completion

- An already-aborted signal never launches a child; signals are never reset or
  replaced with a non-aborted module-global controller.
- Startup failures close any surface already created. Failures are not allowed to
  strand a pane while the caller receives a rejected launch.
- `completion` starts watching automatically. Consumers await that promise instead
  of polling JSONL files. The shared mux foundation still implements its existing
  sidecar/screen/process observation internally.
- `interrupt()` sends Escape to the child pane. It is **not** a queued model steer,
  `sendUserMessage`, process kill, or proof the child is idle. The completion watcher
  remains alive. A finished run rejects interruption.
- `cancel()` or caller abort cancels the watcher and closes the owned surface. Even
  a non-cooperative injected waiter cannot strand the completion promise. Late
  observations are suppressed; injected waiters remain responsible for stopping
  their own external I/O, and callers must not hand shared artifacts to another
  watcher until that I/O is retired.
- Shutdown is idempotent per run. There is one close attempt; a close error is
  returned as `cleanupError` without replacing the child result. Actual OS-process
  termination semantics remain those of `pi-terminal-mux` for that surface.
- `status` is authoritative: a transcript/identity failure can be `failed` even
  when the child exited with code zero. The child's exit code is retained for diagnostics.
- Ping and structured-output completion fields remain data, including false, zero,
  and null structured values. They do not independently emit parent notifications.

## Transcript safety

A byte-offset cursor separates the new invocation from old turns in a resumed
session. A SHA-256 digest of the old prefix detects rewrites/truncation; a terminal
run must not race another writer or an SDK migration of its session file. The
current reader reads the JSONL file locally, as the original implementation did;
this is not a streaming or bounded-size transcript API yet.

Missing new text never falls back to the previous run's answer. Invalid new JSON,
identity mismatch, transcript rewrite, or a final failed/aborted assistant turn is
reported as failure. The reader retains the legacy `subagent_done` argument summary
fallback for this run's assistant entries.

## Remaining integration

The manager and transcript/output/UI consumers now use backend-neutral session
handles and read-only observation interfaces. The embedded adapter alone unwraps
native sessions for controls. Wiring terminal execution into that port still requires
remote observation plus command/child-extension construction, activity reporting,
model/tool policy, session writer ownership, and configuration routing. None of those
are supplied by this lifecycle primitive.

The old lineage-only mode creates an empty conversation with parent metadata; it is
**not** a full-context fork. Workflow fresh/reattach/fork semantics need a separate
session-store implementation, including a new ID/file on fork and no mutation of the
source. Claude CLI support is also outside this batch.
