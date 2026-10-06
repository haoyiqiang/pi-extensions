# Private Pi executor protocol, version 1

The frontend and executor are separate packages. This protocol coordinates them
inside one Pi extension runtime; it is **not JSON RPC** and is not a public stable
release promise. Function references, the live Pi observer and AbortSignals never
cross a child-process boundary. The terminal backend owns its separate authenticated
child protocol.

## Discovery and ownership

The consumer emits `pi-workflow:executor:discover:v1` with
`{ version: 1, offer(executor) }`. Providers answer synchronously in that emission:

```ts
interface Offer {
  version: 1;
  id: string;
  backends: readonly ("embedded" | "terminal")[];
  createExecution(request: Request): Execution | Promise<Execution>;
}
```

The frontend accepts one compatible offer for the configured executor. Late,
missing, incompatible or ambiguous discovery must not fall back to running stages
in the launcher. No global executor singleton is installed by `pi-subagents`.
The workflow package owns its own public provider registration and an idempotent,
opaque-token unregister operation; removing an old registration cannot erase a new
one even when both registrations used the same provider object.

The unified subagent entry and the alternative executor-only entry subscribe to
discovery; load only one. Offers are bound to a Pi session generation. Confirmed
new/resume/fork replacement supersedes old offers and retires managed executions,
while already-owned standard executions may drain. Cancellable before-navigation
hooks and tree browsing do not stop runs. Quit/reload closes all executions.
The consumer hands off cancellation controls through its existing owned provider
when a new root starts; filtered SDK child factories cannot claim the provider.
The frontend's additive `/wf-cancel [run-id|all]` command operates on pending and
active runs through per-run controllers and awaited retirement. It does not change
the inherited `/wf` grammar or require a lane/widget implementation.

## Execution request

A request includes:

- `observer`: the current Pi context, not a captured old model registry or a
  launcher pretending to execute children. Its UI may be decorated by the frontend.
- `run`: resolved `runId`, absolute `childSessionsDir`, and optional name/workflow/input.
- `settings`: `profile` (`standard` by default or explicit `managed`), optional
  concurrency/turn limits and minimum tool requirements. Managed execution also
  accepts stage backend/agent type and explicit skill approvals. The ordinary
  subagent backend default belongs to `subagents.json`.
- `cancellationError(signal)`: supplied by the actual executing workflow runner.
- Optional `signal` and saved `identity`.

The canonical error factory is essential: a similarly named error, DOM AbortError
or class imported from a different installed consumer copy does not satisfy nominal
cancellation classification. Consumer/run and observer signals are combined rather
than selected with `??`; managed executions also carry their generation signal.

Standard execution snapshots the launcher model/runtime/trust context, creates
native SDK stage sessions with normal resources, and injects scoped Agent tools
using the selected subagent backend. Managed execution instead snapshots explicitly
approved instructions and loads no ambient resources. Standard resources and
supporting assets remain live; neither profile is an OS sandbox. Workflow
definitions themselves remain trusted executable code.

## Identity and result

The result has a detached `host`, optional `signal`, required `identity`, synchronous
`dispose()`, awaited `close()`, and read-only `readSessionBranch(file)` observation.
The local consumer can also accept execution-scoped model resolvers.

```ts
interface Identity {
  version: 1;
  executor: string;
  backend: "embedded" | "terminal";
  profile?: "standard" | "managed";
  promptBinding: {
    resolverId: string;
    resourceSetDigest: string;
    assetMode: "live";
  };
}
```

The consumer's generic saved identity permits other executor/backend strings and
an optional prompt binding for programmatic embedders; this Pi protocol is stricter.
Recovery passes journal identity back before dispatch; the recorded backend wins
for new delegated agents (standard) or stage placement (managed). A profile-specific
resolver ID also identifies the profile when an older consumer omits `profile`.
Managed identity binds approved resources; standard identity binds the profile and
declared tool preconditions, not an immutable snapshot of live resources. Auth,
model-runtime handles and credentials are never persisted here.

`close()` closes admission synchronously and returns one shared retirement promise,
including under reentrant callbacks. It waits for owned resource cleanup and preserves
failure; it is not a proof that an arbitrary external callback or escaped daemon has
stopped. Managed quarantine/lease rules remain authoritative for uncertain writers.
A fire-and-forget `dispose()` is not the consumer run's success boundary.

## Storage and validation

Standard stages use native Pi JSONL under `childSessionsDir` and can reopen raw
legacy sessions. Managed files use `<childSessionsDir>/managed`. Exact child file hints
must survive stage records and recovery; its raw top-level JSONL sweep must never
be made recursive. Managed inspection returns authenticated raw branch entries,
not projected UI messages, without SDK repair or writer acquisition. Cleanup failures
are recorded separately from successful stage effects; automatic resume must not
turn such a failed retirement into success or blindly replay those effects.

The mirrored DTOs live in `pi-workflow/src/pi-protocol.ts` and
`pi-subagents/src/workflow/executor-protocol.ts`. A test-only compile contract checks
actual assignability, avoiding a production dependency between products. Focused
Pi discovery tests and real workflow-engine/managed-backend tests cover the runtime
path; the older structural upstream fixture alone is not sufficient evidence.
