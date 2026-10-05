# Private managed workflow execution

This is an **unregistered development interface**, not a replacement `/wf` product.
The package remains private, the default manager remains legacy embedded, and the
active interactive-subagents extension is unchanged. There is no configuration
switch, root-profile entry, public package subpath, or workflow-engine dependency.

## Contract and ownership

`src/workflow/execution-contract.ts` describes the host/provider shape inspected in
[`@juicesharp/rpiv-workflow` 2.12.0](https://github.com/juicesharp/rpiv-mono/tree/68d9a0014b70006d7b04b57933752338a2716db7/packages/rpiv-workflow)
(`host.ts`, `execution-host.ts`, `sessions/spawn.ts`). The reference SDK host was
inspected for semantics, not copied as an execution implementation: it uses Pi
0.80.6, while this workspace uses 0.87.1. Attribution is retained in
[LICENSE.rpiv-workflow](./LICENSE.rpiv-workflow).

- `execution-provider.ts` builds one run-scoped host and backend. Callers supply a
  current Pi context, a managed backend factory and a read-only inspector.
- `execution-host.ts` adapts **AgentManager**, not raw SDK/CLI controls. All children
  in a run share that manager/backend, including a fork whose predecessor is still
  open in an ancestor callback. No process-global provider is registered.
- `execution-semaphore.ts` bounds active invocations, including queued resumes and
  restoration preparation. The default is four. Capacity is released **before**
  `withSession`: a sequential workflow can start its next root-host stage inside
  that callback even at concurrency one. Idle callback/session lifetimes do not
  consume model execution slots. Graph size and idle callback count remain the
  workflow owner's responsibility.
- `AgentManager.retain(id)` pins a record against timed GC during its callback;
  explicit reset/release/disposal still wins. `release(id)` closes admission for
  only that record, retires known resources and tracks late-handle cleanup without
  disposing its siblings. Existing foreground/background pools remain unchanged.

The upstream `src/workflow/host.ts` scripted-workflow adapter remains unchanged.
This interface targets the external host seam; it does not import another DSL,
UI, journal, scheduler, or command surface.

## Supported profile

Both `createManagedEmbeddedExecutionBackend()` and
`createTerminalExecutionBackend()` implement the required inspection/restoration
ports. The host refuses legacy backends missing those ports.

| Operation | Behavior |
| --- | --- |
| Fresh | Isolated persistent child, exactly one initial plain prompt; await the complete invocation before `withSession`. |
| Reattach | Managed clean source, same identity/file, **no initial prompt**, idle callback with existing history. |
| Fork | New identity/file with raw active history and saved policy; **no initial prompt**, source unchanged. |
| `sendUserMessage` | One new manager-owned resume invocation, never steering. Concurrent sends reject. |
| Child `waitForIdle` | Waits that child's actual invocation promise, including retries/checkpoint/retirement; never a sibling or UI status bit. |
| Root `waitForIdle` | Waits the host's admitted/queued invocations, not workflow callback completion. |
| History | Raw active-branch entries, including system/tool/custom/context-edit/compaction entries and real stop reasons. No projected-message envelopes or fabricated assistants. |
| Model | Exact `provider/model` lookup and separate thinking selection for fresh children, without changing the parent model. Explicit `off` is supported. |
| Cancellation | Per-child/run signals and the local child `abort()` addition; queued work never launches after cancellation. |

The callback result is returned unchanged. Session identity is the persistent
session ID/file, **not** the manager record ID. The local callback type also exposes
`reference` and `abort()`; an external consumer needs only the smaller structural
host/session interface.

The supported prompts are already composed **plain text**. Leading slash commands
(including `/skill:`), prompt-template expansion, interactive extension tools,
nested `child.spawnChild()`, and tool-timeout recovery are not provided. Use the
root host for workflow routing/fan-out. A leading absolute path should be described
in prose rather than supplied as a slash-command-shaped prompt. Managed backends
still enforce their builtin-only tool policy and isolated resource loading.

Saved model, effective thinking, tools, prompt, schema and budgets stay with a
restored session. Explicit restored model/thinking selections must match that
policy; thinking requests are compared after the SDK's model-capability clamp.
The saved working directory must resolve to the workflow's directory. Unknown
models, foreign CWD/backend, incompatible overrides, missing validators, bare
JSONL, dirty/quarantined checkpoints and failed restores **do not fall back** to
fresh execution. Current agent/profile defaults do not retune a restored child.
Caller validator closures remain explicit and caller-owned.

## Raw inspection and failure handling

`ExecutionSession.getBranch()` is an optional observation port. Embedded adapts
the native manager's raw branch; terminal reads its owned idle checkpoint. Workflow
reads clone the branch to prevent consumer mutation and reject while an invocation
is pending. Branch offsets count **all** entries, excluding the JSONL header.
A continuation consumer measures the hydrated fork's branch length before sending
its next message, then inspects the full branch with that inherited offset.

`backend.inspect(file)` / `inspectManagedSession(file, kind)` are bounded strict
read-only operations. They reuse managed reference/policy/checkpoint validation,
check stable file identity and exact ready-state contents, then recheck the policy
sidecar. They neither acquire a writer lease nor call `SessionManager.open()` or
repair files. Inspection works while another idle owner holds the source lease.
The provider's `readSessionBranch` is synchronous and fail-soft: invalid, running
or quarantined sessions return `undefined`, not stale projected history.

Every fresh/resumed manager outcome is checked independently of transcript stop
reason. A policy, structured-output or retirement failure cannot become success
just because the final assistant said `stop`. Simultaneous abort/failure diagnostics
are retained by the manager. The adapter throws actual failures; it never edits
history to make the consumer classify them differently. Callback success also requires
the latest invocation to have succeeded, even if its rejected promise was ignored or
caught. A callback that returns with a pending invocation is rejected; unused queued
sends are cancelled, and active work is retired without prematurely releasing capacity.

## Cancellation and disposal boundary

`cancellationError(signal)` must return the consumer's **actual cancellation error**
when that consumer uses nominal `instanceof` checks. The local default
`WorkflowExecutionAbortError` is not rpiv-workflow's class. The inspected reference
runner does not expose a public cancellation-factory registration; wiring that
bridge remains consumer integration work. Similarly named local or DOM errors do
not silently solve it.

An aborted spawn/wait rejects promptly. Invocations retain execution capacity
until their real promises settle; status changes alone do not release it. Child
reads/controls after cancellation also use the cancellation bridge, rather than
letting a quarantined transcript read become a generic error. No cancelled
transcript is invented. Controls reject after callback closure; captured identity
and snapshots remain ordinary data.

The reference provider's `dispose()` is synchronous and its runner does not await
it. Our provider therefore closes admission and cancels synchronously, observes
cleanup errors, and additionally exposes `close(): Promise<void>` for callers that
own an awaited teardown barrier. That shared barrier is published before firing abort
or shutdown callbacks, so reentrant disposal cannot return an already-resolved substitute. Normal `spawnChild` completion already awaits its
scoped release. Owners must call `dispose`/`close` on run/session shutdown and must
not keep using invalidated parent runtime/auth bindings.

Known cleanup is awaited; an opaque backend promise that ignores cancellation or
never publishes a handle is not made safe by waiting forever. Late handles remain
observed, and backend quarantine/lifetime leases still prevent uncertain writer
reuse. A callback that ignores cancellation may finish its own external work later,
but can no longer use the child controls.

## Managed storage versus consumer pruning

The provider passes **`<childSessionsDir>/managed`** to its backend factory, not
`childSessionsDir` itself. Fresh/fork destinations must remain inside that assigned
directory. A pre-existing managed-directory symlink or file is rejected before backend
construction; in particular, aliasing it back to the raw parent would defeat this layout.
This remains a cooperative same-user filesystem contract, not protection against a
concurrent actor replacing directories. The inspected workflow runner only sweeps top-level `*.jsonl`, without
understanding sidecars or leases; putting managed files there could unlink an
uncertain writer's file. The nested directory keeps them out of that sweep.

Every stage must retain the exact returned `sessionFile`. The reference locator
can use that file hint; its top-level ID-only shortcut does not locate these nested
files. No automatic managed orphan GC is introduced. Do not add recursive raw-file
pruning: session/policy/lease cleanup needs a managed-store-aware owner, especially
for quarantined sessions.

## Programmatic development example

The following symbols are private source imports, not npm package exports. Supply
`pi`, `ctx`, `observer`, `runId`, and an absolute `childSessionsDir` from the owning
development integration. Load the i18n notice outlet in the parent when relaying UI.

```ts
const provider = createWorkflowExecutionProvider({
  pi,
  getContext: () => ctx,
  createBackend: ({ sessionDir }) =>
    createManagedEmbeddedExecutionBackend({ sessionDir }),
  inspectSession: file => inspectManagedSession(file, "embedded"),
  maxConcurrency: 1,
  // A consumer with nominal abort checks must supply its own real error factory.
});
const execution = provider.createHost(observer, { runId, childSessionsDir });
try {
  await execution.host.spawnChild({
    prompt: "Inspect the requested change and summarize the findings.",
    withSession: async first => execution.host.spawnChild({
      prompt: "Not dispatched for a fork.",
      fork: { sessionFile: first.reference.sessionFile },
      withSession: async next => {
        const offset = (next.sessionManager.getBranch() as unknown[]).length;
        await next.sendUserMessage("Review those findings and identify missing checks.");
        await next.waitForIdle();
        return { reference: next.reference, offset, branch: next.sessionManager.getBranch() };
      },
    }),
  });
} finally {
  await execution.close();
}
```

For terminal execution, inject `createTerminalExecutionBackend({ sessionDir, ... })`
and the terminal inspector instead. Child-visible provider definitions/credentials,
POSIX/Bash and the terminal backend's existing restrictions still apply.

## What this does not migrate

No `/wf` registration, skill/argument expansion, questionnaire/advisor/web extension
loading, lane UI, interactive terminal handoff, cross-backend conversion, crash
recovery or production configuration migration is included. The reference runner
also catches some validation-retry send errors as extraction failures, so the host
alone cannot guarantee that every cancellation path is classified identically.
Host-level failures can lose session provenance in that runner's generic entry-throw
rows. Those consumer issues must be resolved before claiming a seamless migration.

Package typecheck also compiles a version-pinned structural consumer fixture; this
checks assignability, not full runtime/feature compatibility. Tests use injected
native-free backends and offline real SDK/CLI providers. They do
not require credentials or a real terminal multiplexer. Full product readiness still
requires composition, localization/configuration migration and real mux validation.
