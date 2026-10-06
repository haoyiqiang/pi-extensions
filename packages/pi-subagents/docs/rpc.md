# Cross-extension RPC — protocol v3

The unified product exposes one in-process service over `pi.events`. Consumers do
not import the manager or select another runtime. The retained upstream reference
is [upstream-README.md](./upstream-README.md); its v2 `stop` examples are historical,
not the current control contract.

## Discovery and replies

Handlers become available on the bound root `session_start`, not while extension
factories are evaluated. Listen for `subagents:ready` and confirm availability with
`subagents:rpc:ping`. Excluding the product from a session looks like an unavailable
service, so discovery should have a bounded timeout. Shutdown removes listeners.

Every request includes a unique `requestId`. Replies use
`<channel>:reply:<requestId>` and one of:

```ts
{ success: true, data?: T }
{ success: false, error: string }
```

Subscribe to the reply **before** emitting. Ping returns:

```ts
{ version: 3, controlActions: ["steer", "interrupt", "cancel", "close"] }
```

The bus is synchronous and in-process, although handlers may await execution.
`AbortSignal`, model instances and callbacks work because no JSON transport is
involved; serializing them does not recreate those capabilities remotely.

## Channels

| Channel | Request fields after `requestId` | Successful data |
|---|---|---|
| `subagents:rpc:ping` | none | version and control actions |
| `subagents:rpc:spawn` | `type`, `prompt`, optional `options` | `{ id }` |
| `subagents:rpc:control` | `agentId`, explicit `action`, optional `message` | `{ action, applied }` |
| `subagents:rpc:consume` | `agentId` | omitted |

`subagents:rpc:stop` is removed. There is no implicit mapping from the old verb;
clients must negotiate v3 and choose the intended action.

### Spawn

Spawn is detached and waits for startup admission before replying. `options.model`
accepts a model instance or `"provider/modelId"`; strings resolve against the active
registry and caller overrides obey model scope. `null` means no override.

Common options include `description`, `name`, `maxTurns`, `thinkingLevel`,
`isBackground`, `inheritContext`, `isolated`, `isolation: "worktree"`, absolute `cwd`,
`structuredOutput` and `signal`. RPC uses `isBackground`, not the Agent tool's
`run_in_background`. `isolated` strips resources; it does not create a worktree.
`isBackground` selects the background concurrency pool; it does not turn RPC into
an inline model tool call. Idle interactive sessions release execution capacity.

The root wrapper removes internal ownership, configuration, restoration and policy
fields, including `parentAgentId`, `workflowId`, `depth`, `maxSubagentDepth`,
`configCwd`, `rootSessionId`, `resumeSessionFile`, `reclaim`, `blocking`, `backend`,
`agentConfig` and `runtimePolicy`. Caller options cannot replace the session's
selected backend, captured policy or manager-owned activity callbacks. Scoped
workflow services similarly pin their owning scope and backend.

Unknown option names are not a general feature negotiation mechanism. Use the
current `SpawnOptions` implementation and explicit errors; do not assume tool or
frontmatter spellings have the same meaning.

### Control

All frontends dispatch through `AgentManager.control(id, request)`:

| Action | Meaning |
|---|---|
| `steer` | Deliver nonempty `message`; continue or guide the owned conversation. |
| `interrupt` | Cancel only the active SDK turn, retaining a resumable session. Idle/queued turns are not active interruptions. |
| `cancel` | End the delegated task and owned children, await job retirement, and retain healthy session handles/history for a later resume. |
| `close` | End manager ownership only after confirmed cleanup; persisted history is not implicitly deleted. |

Repeated terminal controls are no-ops once their intended transition has already
happened: `applied: false` is a successful reply, not a fabricated second cancel.
Concurrent cancel/close callers share the manager's retirement barrier. Cleanup
failure returns an error and leaves the failed record quarantined rather than
allowing a second writer or claiming safe retirement.

The root service cannot control nested or workflow-owned records. Scoped services
apply their own ownership filter. An unknown record is an error except for `close`,
which is idempotent. RPC control takes an ID; model tools also resolve handles.

```ts
const requestId = crypto.randomUUID();
const replyChannel = `subagents:rpc:control:reply:${requestId}`;
const unsubscribe = pi.events.on(replyChannel, (reply) => {
  unsubscribe();
  // Check reply.success before reading reply.data.
});
pi.events.emit("subagents:rpc:control", {
  requestId, agentId, action: "interrupt",
});
```

### Consume and notifications

`consume` marks a settled owned result as read, suppressing its completion nudge.
To avoid duplicate model turns, emit consumption synchronously from the lifecycle
completion handler that reports the result. There is also a short held-nudge
window, but a late consume cannot retract an already-delivered follow-up. Resume
and guidance that produce a new reply clear the consumed state.

Top-level lifecycle events and `subagents:record` history entries remain available.
Nested/workflow records do not become root-owned merely because a caller knows
an ID. Session history entries are append-only inspection data, not another RPC
control plane.

## Compatibility registry

The upstream `globalThis[Symbol.for("pi-subagents:manager")]` registry is retained
for in-process integrations that need `waitForAll`, `hasRunning`, `spawn` or a
filtered `getRecord`. Child activation cannot claim a root's registry, and only
the owning activation releases it. Prefer the versioned event bus for controls.

This is not the retired `__pi_subagents` facade. Old interactive tool aliases,
`/plan` and the retained upstream `SubagentWorkflow` are not activated.

## Validation

`test/cross-extension-rpc.test.ts` pins v3 replies, one control dispatch, removed
`stop`, ownership, model scope and reply isolation. `rpc-lifecycle-gating.test.ts`
covers bound-session registration; `rpc-result-consumption.test.ts` covers nudge
suppression; `nested-tools.test.ts` covers scoped ownership. Manager and terminal
lifecycle tests cover actual cancellation, resumption, activity admission and
confirmed retirement rather than treating an RPC reply as proof by itself.
