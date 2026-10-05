# Private managed embedded profile

`src/backends/embedded-managed.ts` exports `createManagedEmbeddedExecutionBackend()`.
It has backend kind `embedded` and the same opaque-session execution port as terminal.
It is an explicit programmatic profile, **not a change to the default factory**.
`createEmbeddedExecutionBackend()` and the native `agent-runner` facade retain their
existing discovery, in-memory sessions and raw `resumeSessionFile` behavior.

## Scope

The managed profile requires `isolated: true` and persistent sessions. It accepts
builtin tools, an immutable resolved prompt, model identity/fingerprint, effective
thinking level, structured output and a turn/grace budget. It rejects inheritance,
memory, bare `resumeSessionFile` and `persistSession: false` before preparing a child.
It does not serialize discovered extensions, skills, nested-manager closures, parent
runtime overrides or credentials. Those cannot be silently recreated on recovery.

Both fresh runs and restoration require a current Pi context whose model-registry
facade wraps its `ModelRuntime` (the existing Pi 0.87.1 integration boundary). No new
runtime is created as a fallback, so restoration does not implicitly refresh catalogs
or select different authentication from disk. Reattach/fork receive this as
`ExecutionRestoreOptions.ctx`. The saved provider/model must resolve identically;
a missing model or mismatched fingerprint fails rather than substituting the parent
model. Extra structured validators must be supplied again, as with terminal.

New sessions default to `<agent-dir>/embedded-subagents/sessions`; `agentDir` and
`sessionDir` may be overridden with absolute paths. The native SDK uses in-memory
settings with its normal defaults and `cacheWarming: "off"`; it neither rereads nor
writes user/project settings. In particular this profile does not promise to recover
arbitrary legacy SDK settings. Automatic SDK compaction/recovery stays part of the
native prompt lifecycle; idle background warming cannot mutate a ready checkpoint.

## Persistence and execution

The shared [managed store](./managed-sessions.md) owns the lifetime file lease, policy
record and strict v3 snapshot. Only after acquiring and validating that record does
the profile use `SessionManager.open` to make its own live writer. Eager SDK creation
can append initial model/thinking metadata even without a prompt, so hydration is a
tracked `running` transaction with its own final checkpoint. No model prompt is sent
by `reattach` or `fork`. The returned handle is idle and immediately exposes history.

`fork` copies the source's raw active branch into a new private v3 seed before opening
that destination. The source is inspected read-only and never passed to native SDK
creation. Reattach keeps the identity and file; neither operation converts a session
from another backend or adopts untracked JSONL.

Every invocation uses `embedded-invocation.ts`, including fresh capture, one missing
structured-output retry and per-invocation turn counters. Checkpointing waits for the
entire prompt/retry/control chain, then native idle, not only a native `agent_settled`
event. The native tree/leaf/digest must equal the persisted tree, with the old file
prefix unchanged. Clean provider failures or SDK-cancelled invocations can therefore
remain recoverable when their tracked work has actually retired and the proof matches.

Steering is literal text delivered as a `pi-subagents-steer` custom message. It never
expands commands, skills, templates or file references, and never starts a separate
turn. Before prompt startup it enters the same invocation's context; while running it
is queued as steering. Admission ends when the invocation settles or cancellation
begins, and controls are drained before checkpointing. SDK abort does not itself clear
undelivered steering queues: aborted/failed invocations explicitly discard them, and
ready checkpoints require empty queues so they cannot leak into resume.

## Shutdown and uncertain state

Shutdown closes admission synchronously and shares one promise across repeated calls.
It aborts the owned invocation and waits for tracked initialization, prompt/control
settlement, native idle and `session_shutdown`, then disposes and releases a clean
lease. The bound defaults to 3,000 ms (`shutdownTimeoutMs`); it bounds waiting, not the
termination of an uncooperative external operation.

A timeout, failed cleanup, changed native/disk identity or uncertain startup leaves a
quarantined record and retained lease. SDK `dispose()` alone never authorizes release.
Cancelled SDK construction may complete after its caller has returned: the late native
session is retired separately, but that late success cannot restore `ready` or release
the quarantined lease. There is no stale-PID stealing, force-unlock, crash takeover or
promise that arbitrary tools are an OS sandbox.

## Manager adoption

`AgentManager.restore(reference, options)` calls the selected backend's `reattach` or
`fork` and publishes a new **idle** record. `type`, description, optional name and
parent/workflow metadata describe this new record; they do not override the backend's
saved execution policy. The manager ID is distinct from the persistent session ID.

Adoption does not prompt, consume a concurrency slot, emit run start/completion, copy
an old result, or replay historical usage. Resume starts an ordinary new invocation
through the existing manager controls. Cancellation or a manager/session boundary
invalidates pending adoption and closes late handles rather than resurrecting records.
Manager invocation reservations survive immediate stopped status until settlement;
foreground resume exposes its real promise and `waitForAll()` waits those reservations.
Foreground resume's existing no-pool-slot behavior is unchanged.

The generic run port has no separate preflight-retirement promise. Manager disposal
cancels an unready fresh run and closes any later handle, but does not wait indefinitely
for an opaque run promise. Cancelled SDK construction that has already been quarantined
can also retire in the background; the retained lease, not an assumption of completion,
prevents reopening it.

```ts
const backend = createManagedEmbeddedExecutionBackend({ sessionDir });
const manager = new AgentManager(undefined, 4, undefined, undefined, undefined, backend);

const { id, record } = await manager.restore(reference, {
  mode: "reattach", // or "fork"
  type: "Explore",
  description: "Continue a managed investigation",
  ctx,
  // structuredOutput: matchingCompiledValidator,
});
// record.status === "idle"; history is readable, but no new model turn ran.
await manager.resume(id, "Continue the investigation");
await manager.dispose();
```

This is not a new model-facing tool, tombstone migration, public configuration route,
final workflow provider, or replacement of the active interactive-subagents product.
