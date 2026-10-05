# Private managed terminal session recovery

The optional `AgentExecutionBackend.reattach(reference, options?)` and
`fork(reference, options?)` methods return **idle** `ExecutionSession` handles. Only
the terminal backend implements them in this slice. No command, model-facing tool,
manager-record adoption, backend routing or root-profile activation is added.

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
- After restore, normal `resume()` creates a fresh process/run/feedback channel, resets
  invocation state and returns only the new invocation's result. The idle view already
  contains the canonical projection of the persisted history; context percentage is
  unknown until a child reports it.

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
backend factories/processes from opening simultaneous writers. Parent and child are
one owner: the supervised CLI writes under the parent's lease. A fork reads under the
source lease and acquires a separate lease for its destination.

This is a same-user cooperation protocol, **not an OS sandbox**. Pi clients/editors
that do not participate can still mutate files; checkpoint and identity checks detect
changes rather than pretending to prevent every external filesystem write.

## Checkpoints and recovery limits

Before launch the record changes from `ready` to `running`. Only after authenticated
`agent_settled` feedback **and** verified supervisor retirement can it become `ready`
again. A ready checkpoint records exact byte length, SHA-256, entry count and leaf.
The child's finalized in-memory witness must agree with the retired file; completion
also checks that the previous transcript prefix was not rewritten. Memory-only branch
changes, missing writes and transcript writes after settlement therefore fail closed. Failed model/schema/turn-budget
outcomes can still have a clean checkpoint if the process retired safely.

Unknown retirement, startup/feedback failure or cancellation quarantines the session.
Its lease is retained even on shutdown. Existing leases are never stolen merely because
a PID disappeared. A `running` or quarantined policy is rejected even if an operator
removed the lock. Crash takeover, cancellation recovery, unsafe force-unlock and repair
of partial JSONL remain deliberately unsupported.

Readers validate v3 headers, identity/CWD, newline completion, unique entry IDs and
backward parent chains before using `SessionManager.inMemory` for canonical projection.
They do not use `open`/`forkFrom` to inspect a source: those APIs may repair newlines,
initialize empty files or migrate old sessions. A fork serializes the selected raw
branch to an exclusively created private destination, including header-only branches.

Reads are bounded to 64 MiB of transcript and 4 MiB of policy data. Policy updates use
exclusive temporary files and atomic rename. No fsync-based power-loss guarantee is
claimed; mismatched/missing checkpoint data fails closed. In-memory branch navigation
without a persisted entry is not recoverable: the persisted final entry is the tip.

## Compatibility boundary

Older private terminal files have no policy checkpoint and are not automatically
adopted. Legacy `run({ resumeSessionFile })` remains unsupported by terminal so it cannot
silently replace saved policy with today's agent definition. Embedded's existing
`resumeSessionFile` behavior is unchanged. Provider definitions and authentication must
still be made available through the new backend's configuration; they are not copied
from the parent runtime into a recoverable record.

Tests use temporary files, deterministic lease contenders and real offline Pi CLI
processes. They do not require model credentials, external services or a live mux.
