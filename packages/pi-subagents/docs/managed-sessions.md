# Private managed session recovery

The optional `AgentExecutionBackend.reattach(reference, options?)` and
`fork(reference, options?)` methods return **idle** `ExecutionSession` handles.
Terminal and the explicit [managed embedded profile](./managed-embedded.md) implement
them using shared `managed-policy.ts`, `managed-session.ts`, `session-witness.ts` and
`session-lease.ts`. Terminal retains its existing private facade names.
`AgentManager.restore()` can adopt these handles as idle records. No model-facing
command/tool, backend configuration route or root-profile activation is added.

## Identity and policy

- `reattach` retains the exact managed session ID and canonical JSONL path. A new
  backend instance may acquire it after the previous owner has **awaited shutdown**.
- `fork` creates a new ID and file with `parentSession` pointing at the source. It
  copies the active raw branch, preserving compactions/system checkpoints, context
  edits, model/thinking changes and opaque metadata. It does not reconstruct history
  from visible text or add only a lineage header. The source is never rewritten.
- Both restore the saved isolated launch policy: model identity/fingerprint, effective
  thinking when known, builtin tools, resolved system prompt, JSON schema and turn/grace
  budget. They do not reread current agent definitions or global turn defaults.
- An owned idle handle may be forked by its backend. Running, closed or quarantined
  sources cannot be forked. Another backend must first acquire the source's lease.
- After restore, normal `resume()` resets invocation state and returns only the new
  invocation's result. Terminal uses a fresh process/run/feedback channel; embedded
  uses its owned native SDK session. The idle view already exposes persisted history.
  Terminal context percentage is unknown until a child reports it.

For a structured session, callers must re-supply `structuredOutput: CompiledSchema`
with matching schema data for either operation. Schema object key order is immaterial;
array order is preserved. The caller is responsible for supplying the correct extra
validator semantics: closures cannot be serialized or compared for equivalence.
Missing/mismatched validators fail rather than silently accepting only JSON Schema.

This is **not raw session import**. JSONL without this backend's matching policy record
is rejected. Manually moving/copying the file and record is not a fork: record identity
is bound to its canonical path. No embedded-to-terminal conversion is implied.

## Files and ownership

Each new managed conversation has:

- `<session>.jsonl`: Pi v3 transcript, initially created exclusively with mode 0600;
- `<session>.jsonl.pi-subagents.json`: private versioned policy, reference and checkpoint;
- `<session>.jsonl.pi-subagents.lock/owner.json`: exclusive handle-lifetime lease.

A lease uses canonical paths, an exclusive mode-0700 directory, a random owner token
and file/directory/owner identities. Symlink path aliases converge on the same lease;
hardlinked transcripts are rejected. The owner PID is diagnostic only. Release is
idempotent and removes only that owner's files, never another owner's directory.
Handles must be shut down explicitly; garbage collection does not release a lease.

The lease lasts while the handle is owned, including idle time. This prevents two
backend factories/processes from opening simultaneous writers. For terminal, parent
and child are one owner: the supervised CLI writes under the parent's lease. Managed
embedded writes through one owned native SDK session under the same lifetime rule. A fork reads under the
source lease and acquires a separate lease for its destination.

This is a same-user cooperation protocol, **not an OS sandbox**. Pi clients/editors
that do not participate can still mutate files; checkpoint and identity checks detect
changes rather than pretending to prevent every external filesystem write.

## Checkpoints and recovery limits

Before launch the record changes from `ready` to `running`. Terminal requires
authenticated `agent_settled` feedback **and** verified supervisor retirement before
it becomes `ready` again. Managed embedded requires tracked SDK construction/invocation
and controls to settle, followed by native idle; eager hydration is also checkpointed. A ready checkpoint records exact byte length, SHA-256, entry count and leaf.
The executor's finalized in-memory witness must agree with the quiescent file; completion
also checks that the previous transcript prefix was not rewritten. Memory-only branch
changes, missing writes and transcript writes after settlement therefore fail closed. Failed model/schema/turn-budget
outcomes can still have a clean checkpoint if execution retired safely.

Unknown retirement or startup/feedback failure quarantines the session. Terminal
cancellation remains conservative and quarantined; embedded cancellation can checkpoint
only after its tracked prompt/abort/control work retires with a matching witness.
A quarantined session's lease is retained even on shutdown. Existing leases are never stolen merely because
a PID disappeared. A `running` or quarantined policy is rejected even if an operator
removed the lock. Crash takeover, uncertain-cancellation recovery, unsafe force-unlock and repair
of partial JSONL remain deliberately unsupported.

Readers validate v3 headers, identity/CWD, newline completion, unique entry IDs and
backward parent chains before using `SessionManager.inMemory` for canonical projection.
Read-only inspection never uses `open`/`forkFrom`: those APIs may repair newlines,
initialize empty files or migrate old sessions. A fork serializes the selected raw
branch to an exclusively created private destination, including header-only branches.

Reads are bounded to 64 MiB of transcript and 4 MiB of policy data. Policy updates use
exclusive temporary files and atomic rename. No fsync-based power-loss guarantee is
claimed; mismatched/missing checkpoint data fails closed. In-memory branch navigation
without a persisted entry is not recoverable: the persisted final entry is the tip.

## Compatibility boundary

Legacy embedded files and older private terminal files have no managed policy
checkpoint and are not automatically adopted. `run({ resumeSessionFile })` remains
unsupported by terminal and managed embedded so it cannot silently replace saved
policy with today's agent definition. The default legacy embedded factory's existing
`resumeSessionFile` behavior is unchanged. Provider definitions and authentication must
still be made available through the new backend's configuration; they are not copied
from the parent runtime into a recoverable record.

Tests use temporary files, deterministic lease contenders and real offline Pi CLI
processes. They do not require model credentials, external services or a live mux.
