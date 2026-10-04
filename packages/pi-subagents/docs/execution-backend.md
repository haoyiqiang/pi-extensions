# Execution and session observation boundary

This is a private refactoring boundary, **not** the final dual-backend API. The
workspace remains inactive and unpublished. An opt-in [terminal backend](./terminal-backend.md)
now implements this port for isolated autonomous invocations. Default construction
remains embedded; backend configuration and workflow-provider registration are deferred.

## Implementation map

```text
Agent tool / nested tools / workflow host / UI
                      |
                 AgentManager
       records, ownership, queue, completion
                      |
             AgentExecutionBackend
          run / resume / steer / shutdown
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
- `src/backends/embedded.ts` owns the original SDK runner: resource loading,
  model/tool/skill resolution, session creation, turn limits, event forwarding,
  structured-output retry, signal handling, and per-invocation result extraction.
- `src/backends/embedded-lifecycle.ts` owns awaitable steer delivery and bounded,
  idempotent session shutdown.
- `src/agent-runner.ts` re-exports the embedded module, preserving all upstream
  imports, test doubles, and one shared instance of runner settings.
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
Streaming, usage, structured-result fields, and model-facing tool contracts are unchanged.

The embedded adapter accepts only its own handles for control operations. It rejects
foreign handles and resume/steer after shutdown; repeated valid shutdown stays
idempotent. UI and transcript code cannot reach SDK controls, extension runners,
model runtimes, or credential-bearing model headers through this view.

Shutdown emits `session_shutdown` before disposing the SDK session. A 3-second bound
prevents a hanging handler from blocking quit. Concurrent/repeated cleanup of the
same session shares one promise; failed handlers still reach disposal, and the
shutdown timer is cleared when cleanup finishes early. Eviction remains detached,
while manager disposal awaits child shutdown.

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
for a restricted first slice. External reattach/fork, interrupted-process recovery,
full policy parity and configuration routing remain separate integration steps. There is no public package subpath for this interface.

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
