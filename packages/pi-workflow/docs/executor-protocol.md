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

The executor-only entry subscribes to discovery. Its offers are bound to a Pi
session generation. Session startup/navigation invalidates previous offers and
retires that generation's executions; new offers remain separate while old cleanup
is pending. Shutdown removes only its own listeners and waits for known retirement.
Loading the legacy subagent factory is neither necessary nor equivalent.
The frontend's additive `/wf-cancel [run-id|all]` command operates on pending and
active runs through per-run controllers and awaited retirement. It does not change
the inherited `/wf` grammar or require a lane/widget implementation.

## Execution request

A request includes:

- `observer`: the current Pi context, not a captured old model registry or a
  launcher pretending to execute children. Its UI may be decorated by the frontend.
- `run`: resolved `runId`, absolute `childSessionsDir`, and optional name/workflow/input.
- `settings`: backend, optional agent type/concurrency/turn limits, explicit skill
  approvals and exact minimum required tool names.
- `cancellationError(signal)`: supplied by the actual executing workflow runner.
- Optional `signal` and saved `identity`.

The canonical error factory is essential: a similarly named error, DOM AbortError
or class imported from a different installed consumer copy does not satisfy nominal
cancellation classification. Consumer/run, observer and executor-generation signals
are combined rather than selected with `??`.

The executor resolves approved instructions synchronously at execution creation,
freezes their identity and snapshots the host's current execution context. No
ambient project skills, prompt templates, extensions or shell preprocessors are
loaded. Generic workflow definitions themselves remain trusted executable code.

## Identity and result

The result has a detached `host`, optional `signal`, required `identity`, synchronous
`dispose()`, awaited `close()`, and read-only `readSessionBranch(file)` observation.
The local consumer can also accept execution-scoped model resolvers.

```ts
interface Identity {
  version: 1;
  executor: string;
  backend: "embedded" | "terminal";
  promptBinding: {
    resolverId: string;
    resourceSetDigest: string;
    assetMode: "live";
  };
}
```

The consumer's generic saved identity permits other executor/backend strings and
an optional prompt binding for programmatic embedders; this managed protocol is
stricter. The workflow journal records the returned identity. Recovery passes it
back before dispatch; the recorded backend wins over changed new-run defaults.
Changed resource/resolver identity rejects rather than retuning saved policy.
Auth, model-runtime handles and credentials are not persisted in this identity.

`close()` closes admission synchronously and returns one shared retirement promise,
including under reentrant callbacks. It waits for known managed cleanup and preserves
failure; it is not a proof that an arbitrary external callback or escaped daemon has
stopped. Managed quarantine/lease rules remain authoritative for uncertain writers.
A fire-and-forget `dispose()` is not the consumer run's success boundary.

## Storage and validation

Managed files use `<childSessionsDir>/managed`. The workflow's exact child file hints
must survive stage records and recovery; its raw top-level JSONL sweep must never
be made recursive. Inspection returns authenticated raw branch entries, not projected
UI messages, and performs no SDK open/repair or writer acquisition.

The mirrored DTOs live in `pi-workflow/src/pi-protocol.ts` and
`pi-subagents/src/workflow/executor-protocol.ts`. A test-only compile contract checks
actual assignability, avoiding a production dependency between products. Focused
Pi discovery tests and real workflow-engine/managed-backend tests cover the runtime
path; the older structural upstream fixture alone is not sufficient evidence.
