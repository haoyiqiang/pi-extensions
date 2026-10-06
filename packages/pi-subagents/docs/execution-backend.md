# Execution and session observation boundary

This is a private execution boundary, not a stable published SDK. The unified
product entry injects a per-cwd router into AgentManager: ordinary embedded and
standard terminal execution share Agent/RPC/management ownership. Low-level default
manager construction remains embedded for programmatic compatibility. The
[managed terminal profile](./terminal-backend.md) is separately opt-in.
`workflow-executor.ts` offers standard SDK stage hosting or explicit managed
execution. The unified entry is active in the root Git/local profile; npm
publication remains separate.

## Implementation map

```text
Agent tool / nested tools / workflow host / UI
                      |
                 AgentManager
       records, ownership, queue, completion
                      |
             AgentExecutionBackend
          run / resume / steer / interrupt / shutdown
                      |
       ExecutionSession (read-only view)
                      |
         backends/embedded-adapter.ts
                      |
         backends/embedded.ts
         backends/embedded-lifecycle.ts
                      |
                 Pi AgentSession
```

- `src/backends/session.ts` defines read-only transcript, observation-event, metadata,
  and session-identity contracts. It imports no native session class or event type.
- `src/backends/embedded-adapter.ts` owns per-backend handle/native lookup and SDK
  observation adaptation. Every default manager gets its own backend instance.
- `src/backends/embedded.ts` owns resource loading, model/tool/skill resolution and
  native session creation. It snapshots resolved invocation policy before preparation.
- `src/backends/embedded-invocation.ts` executes both fresh and resumed prompts with
  per-session policy ownership, per-invocation capture/turn/retry state, event forwarding,
  cancellation and result extraction.
- `src/backends/invocation-policy.ts` shares immutable JSON schema snapshots and
  finite budget validation with terminal. `terminal/run-policy.ts` retains private
  compatibility names, not a separate policy implementation.
- `src/backends/embedded-lifecycle.ts` owns awaitable steer delivery and bounded,
  idempotent session shutdown.
- `src/agent-runner.ts` re-exports the embedded module, preserving all upstream
  imports, test doubles, and one shared instance of runner settings.
- `src/backends/embedded-managed.ts` adds an opt-in isolated persistent profile using
  the same embedded adapter/invocation engine and the shared managed store. It does
  not replace the default factory or raw runner. See [managed embedded](./managed-embedded.md).
- `src/backends/types.ts` describes the internal execution port. The manager's
  optional sixth constructor argument injects it; default construction uses the
  embedded implementation. Injection is for composition/tests, not model input.

## Ownership and lifecycle

The manager still owns agent IDs, records, foreground/background queues, cancellation
controllers, parent/workflow ownership, consumed-result state, usage accumulation,
worktree creation/cleanup, and completion notifications. The backend must not add a
second queue, record registry, or notification path.

`run()` and `resume()` return completion promises and receive an execution abort
signal. Synchronous runner startup errors remain synchronous so the manager's
startup gate can reject them instead of announcing a failed launch as started.
Manager cancellation marks the run stopped immediately; the backend forwards
the signal to Pi and settles through the existing manager path. Queued cancellation
never constructs a child session. Pool slots are released by settlement, not twice
by cancellation and settlement.

Steering has two consumers:

- UI `manager.steer()` returns synchronously and ignores delivery failure, as before.
- Tools use `manager.steerAndWait()` and report delivery errors. Both route through
  the same backend. Messages queued before session creation are flushed in order.

Manager session creation callbacks retain their timing but now carry an opaque
`ExecutionSession`, **not** a native Pi session. The manager publishes this handle
and its metadata before forwarding the caller callback. `AgentRecord.session` uses
the same handle; resuming it does not create a new view or native session. The
low-level `agent-runner` facade still returns native sessions for compatibility.
Streaming and usage contracts are unchanged. `ExecutionResumeResult` now adds optional
structured JSON/retry metadata and abort/steer flags to the existing text/failure
result. Both manager resume paths clear stale structured fields and apply fresh-run
status precedence without overwriting an external stop. Embedded resume now installs
fresh enforcement/usage subscriptions and returns the new structured/abort/steer
metadata. Existing plain text/failure callers remain structurally compatible.

The embedded adapter accepts only its own handles for control operations. It rejects
foreign handles and resume/steer after shutdown; repeated valid shutdown stays
idempotent. UI and transcript code cannot reach SDK controls, extension runners,
model runtimes, or credential-bearing model headers through this view.

Shutdown emits `session_shutdown` before disposing the SDK session. A 3-second bound
prevents a hanging handler from blocking quit. Concurrent/repeated cleanup of the
same session shares one promise; failed handlers still reach disposal, and the
shutdown timer is cleared when cleanup finishes early. Eviction remains detached,
while manager disposal awaits child shutdown.

## Embedded invocation policy

A WeakMap keyed by the native session retains the schema data and resolved max/grace
budget established at creation. Editing global defaults or agent definitions does not
retune an owned session mid-run or on resume. Each invocation has fresh structured
capture, retry allowance, counters and listeners. The stable synthetic tool dispatches
only to that invocation and rejects idle, cancelled or cleanup-time calls. Its JSON
schema is snapshotted; any additional caller validator remains a caller-owned function,
so closure state is not made immutable or serializable.

The invocation reserves its policy before `onSessionCreated`, rejecting reentrant or
concurrent resumes before they can reset capture. That reservation lasts through
prompt settlement and abort draining. An already-aborted invocation never prompts;
cancellation during asynchronous SDK preflight is latched and reasserted at
`agent_start` because Pi can replace its operation signal after preflight. The public
native agent signal is tracked too: native UI/extension cancellation must suppress
retry even if the last assistant message stopped normally.

The embedded schema retry remains one sequential SDK `prompt()` after the initial
prompt settles. Both prompts share one turn budget and live abort/usage wiring. The
terminal child instead requests its bounded continuation at `agent_before_settle`.
Consumers must await the backend completion promise, not the first native
`agent_end`/`agent_settled` notification. Neither backend retries a cancelled invocation
or a final provider/empty-output-limit failure. Hard limits keep their abort outcome
even if the final turn produced valid data.

Finalized assistant event tracking survives compaction/history replacement and
retains this invocation's partial progress without reading a previous invocation's
answer. Internal wrap-up uses `sendCustomMessage` rather than asynchronous interactive
input expansion, so an input hook cannot enqueue a stale warning for a later resume.
Session-lifetime extension errors reach only the current invocation (or the temporary
startup observer); no completed caller keeps receiving them. Observational callback
failures cannot disable limits or cleanup. The legacy
raw `resumeAgent` facade can still accept an unowned native session; it does not infer
schema or current global budgets for a session whose policy it never created.
Reopening a file through `runAgent({ resumeSessionFile })` remains a new creation
under current agent settings, not restoration of this in-memory policy map.

## Managed restoration (optional port)

`reattach(reference, options?)` and `fork(reference, options?)` are optional methods
returning an idle `ExecutionSession`. Terminal and the opt-in managed embedded factory
implement them for their own checkpointed policy records. Embedded restore requires
`options.ctx` to rebind the current model runtime; schema validation is re-supplied.
The session's backend is sticky. The default legacy embedded factory has no restore port.

`AgentManager.restore(reference, options)` adopts a backend-returned handle with a new
record ID, preserved session identity/view, explicit `idle` status and zero invocation
usage. It does not replay results, acquire a pool slot, or emit start/completion events.
Duplicate ownership is refused while acquisition or cleanup is pending. Cancellation,
manager disposal and session reset reject pending adoption and clean up late handles.
Subsequent resume uses the existing manager scheduling and result-consumption paths.
Invocation reservations last through settlement, including stopped runs still draining.
Foreground resume's actual promise is recorded, and `waitForAll()` no longer consults
an old completed promise. Foreground resume remains outside the foreground spawn pool.
Post-dispatch `onSpawned` observer errors cannot detach a running invocation. Manager
owned worktree startup stays tracked after record eviction; opaque backend preflight
is cancelled and late handles are retired, not awaited indefinitely at quit.
These are private APIs, not new commands, RPC operations or tombstone revival. See [managed sessions](./managed-sessions.md)
for the canonical path lease, strict v3 snapshot/fork semantics and fail-closed limits.

## Private workflow consumer boundary

`src/workflow/execution-provider.ts` and `execution-host.ts` expose an unregistered
managed/plain-prompt host profile over this same manager/backend. Fresh callbacks
start after settlement; reattach/fork callbacks receive idle history without a prompt.
A FIFO invocation limiter releases before routing callbacks, preventing sequential
recursive workflows from deadlocking at concurrency one. Manager `retain` protects
callback-owned records from timed GC; scoped `release` retires just that record.
Simultaneous abort/failure diagnostics now survive manager result assignment.

`ExecutionSession.getBranch()` optionally observes authentic raw active-branch entries.
Managed backends additionally expose `inspect(file)`, sharing strict bounded ready-state
policy/checkpoint validation without acquiring leases or repairing source files. This
is separate from projected UI/model messages. The workflow adapter clones raw reads,
checks outcomes beyond transcript stop reasons and rejects incompatible policy/CWD
changes. Explicit `off` is accepted by the private spawn/runner thinking option.

See [workflow execution](./workflow-execution.md) for cancellation-error interoperability,
synchronous provider disposal plus an awaited close barrier, managed storage versus
consumer pruning, and the managed resource boundary. The low-level host factory has
no registration side effect. Root composition uses the unified product entry and
the versioned event bus; `workflow-executor.ts` is an alternative without root Agent UI.

Prompt preparation is now optional and explicit. Fresh/send inputs can use an approved
skill snapshot or another owner-supplied preparer; idle reattach/fork never prepares the
ignored prompt. The prepared `requiredTools` array is snapshotted across manager queues
and checked against actual managed tools (including StructuredOutput only when installed)
before fresh environment/session effects or resumed writer reservation. Missing tools
never grant permissions or change saved policy, and legacy embedded rejects nonempty
requirements. Instruction files, not supporting asset trees, are snapshotted. See
[workflow resources](./workflow-resources.md) for format/budget/trust limits and
[consumer contract](./workflow-consumer-contract.md) for the local integration and upstream limits.
Explicit resolver/resource identity can also be bound to saved managed policy; mismatched
restoration is rejected before writer acquisition. Supporting assets remain live.

## Observation semantics

The manager, nested tools, output writer, conversation viewer, and result formatter
use read-only views rather than `AgentSession`. Messages are exposed by a live
getter: original message identity/extra fields survive, including array replacement
after compaction. This preserves rendering caches and complete output records.
Read-only is a TypeScript contract, not a sandbox or a deep copy of model messages.

Observers receive `changed`, `turn_end`, `compaction_start`, or `compaction_end`.
Compaction completion carries only aborted/success markers. The output writer keeps
its existing microtask re-anchor after successful compaction, so overflow-retry
trimming does not skip the next message. Unsubscribe and adapter shutdown suppress
late callbacks and detach native subscriptions. Missing SDK stats in partial mocks
remain harmless; UI context percentages are optional rather than invented.

The neutral text formatter lives in `src/transcript.ts`; the upstream facade still
re-exports it, while UI/tool consumers no longer import the execution engine to format text.

## Deliberate remaining coupling

Request preparation still uses `ExtensionContext` and options derived from the SDK
runner (`ExecutionRunOptions` replaces the native callback). This is not yet a
serialized cross-process protocol or public workflow API. A native-free fake backend
exercises the manager, UI, output, and resume path independently of the SDK. The real
terminal implementation adds CLI/child policy and authenticated remote observations
for a restricted private slice, including clean managed-session reattach/fork.
Backend conversion, interrupted-process recovery, unrestricted embedded-resource
restoration and uncertain-writer recovery remain profile-specific. Product routing
now lives in `runtime.ts` / `product-backend.ts`; there is no published package
subpath promising a stable backend SDK.

The mention clone remains a separate throwaway launcher. The agent it starts flows
through the manager normally; its off-screen prompt is not a new backend or registry.

## Verification

Existing runner, SDK/faux-provider, queue, worktree, nested delegation, usage,
structured-output, and workflow tests continue exercising the same implementation
through the compatibility entrypoint. Additional tests cover injected execution,
steer delivery, cancellation, cleanup idempotency/timeouts, shared facade state,
handle ownership, observation lifetime, and native-free UI/output integration.
Tests remain offline. A dedicated terminal suite explicitly uses real Pi child
processes with a scripted provider and headless transport, not a live model/mux daemon.
