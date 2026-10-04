# Embedded execution boundary

This is a private refactoring boundary, **not** the final dual-backend API. The
workspace remains inactive and unpublished. No terminal implementation, backend
configuration, or workflow adapter is introduced here.

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
         backends/embedded.ts
         backends/embedded-lifecycle.ts
                      |
                 Pi AgentSession
```

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
signal. Manager cancellation marks the run stopped immediately; the backend forwards
the signal to Pi and settles through the existing manager path. Queued cancellation
never constructs a child session. Pool slots are released by settlement, not twice
by cancellation and settlement.

Steering has two consumers:

- UI `manager.steer()` returns synchronously and ignores delivery failure, as before.
- Tools use `manager.steerAndWait()` and report delivery errors. Both route through
  the same backend. Messages queued before session creation are flushed in order.

Session creation callbacks retain their timing and native Pi session payload. The
manager publishes the session and metadata before forwarding the caller callback;
streaming, usage, and structured-result fields are unchanged.

Shutdown emits `session_shutdown` before disposing the SDK session. A 3-second bound
prevents a hanging handler from blocking quit. Concurrent/repeated cleanup of the
same session shares one promise; failed handlers still reach disposal, and the
shutdown timer is cleared when cleanup finishes early. Eviction remains detached,
while manager disposal awaits child shutdown.

## Deliberate remaining coupling

The port still uses `ExtensionContext`, `RunOptions`, and `AgentSession`, and
`AgentRecord.session` remains available to existing transcript/UI consumers. This
batch does **not** pretend a terminal process can provide an in-process session.
Separating opaque run/session references and remote transcript views is the next
step when integrating the second backend. There is no public package subpath for
this interface yet.

The mention clone remains a separate throwaway launcher. The agent it starts flows
through the manager normally; its off-screen prompt is not a new backend or registry.

## Verification

Existing runner, SDK/faux-provider, queue, worktree, nested delegation, usage,
structured-output, and workflow tests continue exercising the same implementation
through the compatibility entrypoint. Additional tests cover injected execution,
steer delivery, cancellation, cleanup idempotency/timeouts, and shared facade state.
All tests remain offline; terminal/mux behavior is outside this batch.
