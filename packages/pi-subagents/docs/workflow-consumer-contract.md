# Workflow consumer contract and upstream audit

The managed host/provider remain private source APIs. Independent `packages/pi-workflow`
is now the local consumer implementation; the explicit `workflow-executor.ts` entry
exposes managed execution through `pi-workflow:executor:discover:v1`, without importing
that product or modifying its registration slot. See the
[local consumer README](../../pi-workflow/README.md) for activation and compatibility.

The remainder records the **unmodified upstream consumer's gaps** and acceptance
requirements that motivated that local integration, not changes published to
`@juicesharp/rpiv-workflow` or a promise of drop-in compatibility.

The inspected reference is `@juicesharp/rpiv-workflow` 2.12.0 in `juicesharp/rpiv-mono`
at `68d9a0014b70006d7b04b57933752338a2716db7`. This is a source/export audit, not a
verification of the current npm tarball. No external checkout path is a runtime or
test dependency of this repository.

## What is already public

`@juicesharp/rpiv-workflow/startup` exports `registerWorkflowExecutionHost`. Provider
registration is therefore **not** missing. Provider types can also be obtained from
that function's parameter type. Public prompt-stage DSL operations provide a useful
future integration target without requiring the full rpiv-pi skill/tool ecosystem.

What the inspected package does not expose is the genuine cancellation constructor
or factory, an ownership-safe unregister operation, or an awaited run-close contract.
Its private implementation files are not public package subpaths; shipping them in
the tarball does not make deep imports portable.

## Cancellation identity must come from the executing consumer

The reference consumer uses `instanceof WorkflowAbortError`, not error-name matching.
Our local error or a DOM AbortError cannot substitute for it.

The minimum API change is a public canonical error factory. A more robust contract
passes a cancellation factory **from the executing runner into each `createHost`
call**, so the host throws the class instance that this runner actually recognizes.
This matters because provider registration shares a process-global slot across
duplicate package instances, while ordinary class constructors do not share identity.
A constructor imported from another installed copy can still fail `instanceof`.

The host already accepts an explicit `cancellationError(signal)` from a trusted owner.
That is an injection boundary, not evidence that today's consumer can supply it.
Do not patch the global provider slot, import private utility files, rename an error,
forge an aborted assistant, or modify `Symbol.hasInstance` to conceal this gap.

## Cancellation must survive extraction and retry

In the inspected consumer, `sessions/extraction.ts` converts some resend/wait,
collector, parser and validation exceptions into extraction-fatal values. Even a
genuine cancellation error can be swallowed in the validation-retry path.

A consumer update must preserve genuine cancellation before generic error conversion
and check cancellation after awaited extraction/before durable writes. In particular:

- A cancelled collect-all unit must not become a `collected: true` failed slot.
- A cancelled promotion must not fall through to a reattach nudge.
- A callback abandoned by the host's cancellation race must not later append a
  misleading audit row after the run has closed.
- Provider/policy failures remain failures, not cancellation merely because they
  occurred during an asynchronous operation.

These journal/routing semantics belong to the workflow consumer. The host cannot
repair them by fabricating history or suppressing an authentic invocation failure.

## Registration ownership and awaited retirement

The inspected registrar returns void and uses last-writer-wins replacement. For
reload-safe ownership, registration should return an idempotent remover guarded by
an **opaque registration token**, not just provider object equality. Removing an old
registration must neither erase a newer one nor resurrect a stale provider.

The current runner calls `dispose()` without awaiting it. Our provider closes
admission synchronously and exposes `close(): Promise<void>`, but the current
consumer ignores that extra barrier. An integration owner can track executions and
await them on its own shutdown; that alone does not make `runWorkflow()` an awaited
retirement boundary.

A consumer update should explicitly await close/async disposal and define ordering
relative to completion events and cleanup. An end-event listener is insufficient
because exceptional paths can bypass that event. Context/runtime/auth replacement
must also cancel and retire the old owner's executions.

## Preserve managed storage semantics

Our provider stores sessions below `<childSessionsDir>/managed` and records exact
file paths. This avoids the consumer's top-level raw-JSONL orphan sweep. Keep those
file hints on stage records; the parent's ID-only shortcut cannot locate nested files.

Do not make the raw sweep recursive. Policy sidecars, lifetime leases and quarantine
need a managed-store-aware cleanup owner. Host-level entry failures also lose session
provenance in the inspected generic failure rows; storage preservation alone does not
make those failures resumable through the journal.

## Acceptance tests before registration

An actual integration should run the real consumer in an isolated process, using a
pinned published package or explicitly selected development checkout. Do not commit
machine-specific paths or silently install the rpiv-pi bundle to make tests pass.

Required cases include:

1. Public registration is used by the real runner; two prompt stages and an owned
   predecessor fork work at concurrency one.
2. Pre-start, active-call, validation-retry and promotion cancellation retain the
   consumer's nominal classification; mismatched errors do not.
3. No cancelled unit is durably collected, no late callback appends after closure,
   and resume does not incorrectly skip or re-prompt a cancelled unit.
4. Registration cleanup is ownership-safe, including repeated registration of the
   same provider object and duplicate consumer module instances.
5. Delayed child retirement is awaited at the documented boundary, including
   exceptional paths, with managed file paths and source immutability preserved.
6. Explicit resource formats, required tools and saved-policy restrictions are
   honored rather than bypassed by ambient skill/extension hooks.

The original structural fixture and offline host tests validate only the boundary.
Local consumer tests additionally exercise the real imported engine; the Pi frontend
owns provider registration/teardown, and the executor owns backend lifecycle. Keep
that distinction when adding coverage: a fake runner or type-only compatibility check
cannot establish consumer cancellation, durable-state or retirement behavior.
