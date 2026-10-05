# @maplezzk/pi-subagents — private migration baseline

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

This workspace imports the embedded subagent implementation from
[`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents), v0.19.0 at
`e955e29c51b7a6cce37e1108cd2d6c57a77e151c`. It is the starting point for a future
unified embedded/terminal subagent package, **not an installable replacement yet**.

## Activation and release boundary

- `private: true`; no Pi resource manifest or automatic activation.
- Not loaded by the root Pi profile; not included in release-please, publishing,
  or the public tarball gate.
- Existing `@maplezzk/pi-interactive-subagents` remains unchanged and active.
- Importing the entrypoint exports the upstream extension factory; it does not
  invoke it. Do not load both products into a production session during migration.
- A real terminal backend is available through explicit factory injection for
  isolated development. Default AgentManager construction remains embedded; config
  routing for top-level subagents and product migration remain deferred. The separate
  `workflow-executor.ts` entry offers managed embedded/terminal execution to the
  independent private `pi-workflow` package without loading the legacy tools/UI.
  `/wf` and its execution configuration belong to that consumer, not this package.

## Imported scope

The upstream source and regression suite are retained: AgentSession execution,
AgentManager lifecycle and queues, `Agent` / result / steering tools, custom agent
definitions, structured output, session persistence, worktrees, RPC/events, and UI.
The upstream scheduler and JavaScript `SubagentWorkflow` source, tests, and examples
are retained for baseline comparison, not enabled in the root profile.

Repository Pi development dependencies are pinned to **0.87.1**, TypeScript to
**5.9.3**, and Vitest to **5.0.1**. Local SDK compatibility changes are documented in
[UPSTREAM.md](./UPSTREAM.md). The original MIT notice is retained in [LICENSE](./LICENSE).

## Embedded backend extraction

The SDK execution implementation now lives in `src/backends/embedded.ts`, with
session steering/shutdown in `embedded-lifecycle.ts`. `agent-runner.ts` remains a
compatibility re-export. `AgentManager` accepts a private execution port for tests
and composition, while continuing to own queues, records, cancellation, worktrees,
and notifications. Tool steering no longer bypasses that port.

Manager session handles and UI/output observations are now backend-neutral.
`embedded-adapter.ts` keeps native sessions behind per-backend lookups; controls reject
foreign or closed handles. Live read-only views preserve transcript identity,
compaction behavior, stats, and metadata without exposing SDK controls or model headers.
The raw runner facade remains compatible. Fresh embedded runs and owned-session
resumes now share `embedded-invocation.ts`: resolved schema/turn/grace policy stays
with the native session, while capture, counters, retry allowance and listeners are
fresh per invocation. Cancellation and final provider errors suppress the one
structured-output retry; concurrent invocations are rejected before capture changes.

The opt-in `createManagedEmbeddedExecutionBackend()` now adds isolated persistent
reattach/fork using shared policy/checkpoints and lifetime leases. It requires the current
Pi model runtime on restore, keeps caller validators explicit, and quarantines uncertain
cleanup. The default embedded factory and raw runner are unchanged. See
[managed embedded](./docs/managed-embedded.md) for its narrower resource/settings scope.

`AgentManager.restore()` adopts managed embedded or terminal handles as idle records:
no prompt, result replay, usage replay or concurrency slot until an invocation starts.

Request preparation still uses Pi context; terminal execution is an explicit private opt-in.
See [execution boundary](./docs/execution-backend.md) for the private callback-contract
change, preserved behavior, and remaining work. Top-level subagent configuration is unchanged.

## Terminal execution (private opt-in)

`src/backends/terminal/` now provides an injected launch/completion/interrupt/cancel
primitive and a public `pi-terminal-mux` adapter, with explicit Bash/PowerShell
selection. Data-only run/session references
separate a single invocation from its persistent conversation. Startup/cancellation
cleanup is idempotent; resumed output excludes old turns and stale completion markers.

`createTerminalExecutionBackend()` now connects that primitive to a real Pi CLI child,
credential-free launch policy, authenticated loopback feedback, canonical session
views, acknowledged steering, and fresh-process resume of owned sessions. The first
slice requires POSIX/Bash, `isolated: true` and autonomous completion. JSON Schema
structured output and soft/grace/hard turn limits now work across fresh and owned-session
resume runs; each invocation resets capture, retry and turn counters. Resume results
propagate structured data and abort/steer flags without reusing the previous result.
Managed clean sessions can now be reattached across backend instances or forked into
a new identity with canonical branch history and saved policy. A handle-lifetime file
lease prevents cooperating owners from writing the same transcript. Raw JSONL import,
crash/uncertain-exit recovery, inheritance, memory and native Windows remain unsupported.
Completion uses a per-run supervisor receipt rather than spoofable screen text.

See [managed session recovery](./docs/managed-sessions.md) for validator requirements,
checkpoint/lease behavior and recovery limits; [terminal backend](./docs/terminal-backend.md) for the supported contract and
[terminal lifecycle](./docs/terminal-lifecycle.md) for the underlying primitive.
New diagnostics have English/Chinese catalogs; imported embedded strings remain a
separate migration. Workflow execution configuration is owned by the private `pi-workflow` consumer;
there is no top-level subagent backend switch yet.

## Managed workflow execution (private)

`src/workflow/execution-provider.ts` supplies a common host over either managed backend:
fresh prompts, no-replay reattach/fork, same-session sends, per-child waiting and cancellation.
It uses one run-scoped manager/backend, raw active-branch snapshots and per-invocation
concurrency. Callback lifetimes retain sessions without consuming execution capacity,
so recursive stage routing and forks of still-owned predecessors work at concurrency one.

The default remains **plain-prompt-only**. An explicit `preparePrompt` can prepare fresh
and resumed inputs; `createWorkflowSkillPreparer` snapshots approved instruction files
with canonical paths, hashes and a declared `pi` or `positional-v1` format. It does not
discover resources or execute preprocessing shell commands. Required tool names are
validated against actual managed policy before model execution, never used as grants;
missing requirements leave restored sessions clean. An explicit prompt binding records resolver/resource
identity in managed policy and rejects mismatched reattach/fork before writer acquisition.
Supporting assets remain live. See [workflow resources](./docs/workflow-resources.md).

This is not a completed rpiv-workflow migration. Saved policies are preserved;
incompatible restored model/thinking/CWD, unresolved slash commands and unsupported
nesting reject explicitly. The provider's synchronous `dispose`
is complemented by an awaited `close`. Managed files live below the consumer's raw-JSONL
sweep, and cancellation uses the factory supplied by the executing consumer.

For explicit development composition, load `workflow-executor.ts` (also exposed as
`@maplezzk/pi-subagents/workflow-executor`) alongside `pi-workflow/extension.ts` and
the i18n notice outlet. Discovery uses `pi-workflow:executor:discover:v1`, without a
cross-product runtime import or hidden global registration slot. The executor binds
approved skills/global minimum tools, pins saved backend identity on resume, and
retires old executions when the Pi session/runtime changes. It registers no Agent
UI, legacy `SubagentWorkflow` or `/wf` command itself. This entry remains private and
outside the root profile. See the [consumer README](../pi-workflow/README.md),
[workflow execution](./docs/workflow-execution.md) and
[consumer contract](./docs/workflow-consumer-contract.md).

## Configuration

No new production configuration is introduced, so this workspace intentionally has
no `config.example.json`. For isolated development, upstream configuration still
uses `<agentDir>/subagents.json` and `<cwd>/.pi/subagents.json`; project values override
global values. Existing interactive-subagent configuration is neither read nor rewritten.

Before activation or publication, the imported English strings, prompts, and direct
notices must be migrated to `pi-extensions-i18n`, and configuration I/O must be
adapted to `pi-extensions-config`. Keeping the upstream baseline private avoids
exposing an incomplete repository integration to users.

## Development

From the repository root, after `npm install`:

```bash
npm run typecheck -w @maplezzk/pi-subagents
npm test -w @maplezzk/pi-subagents
npm run test:e2e -w @maplezzk/pi-subagents
npm run check
```

Tests use scripted/faux providers, temporary HOME/agent/session directories, and a
temporary project repository. Inherited Git directory/config overrides are cleared.
`PI_E2E_LIVE` is forced off by the test configuration, even if inherited from the
shell. The retained upstream live-model tests remain skipped. Git/worktree tests
operate only in temporary repositories and require the Git executable; no API keys,
terminal multiplexer, or local Pi daemon are needed. Test fixtures under
`test/fixtures/.pi/` are intentionally versioned, unlike personal `.pi/` directories.

## Reference and next steps

- [Import provenance and local delta](./UPSTREAM.md)
- [Archived upstream README](./docs/upstream-README.md)
- [Upstream RPC reference](./docs/rpc.md)
- [Upstream scripted workflow reference](./docs/workflows.md)

Next: finish long-lived interactive terminal parity, then add top-level subagent backend
routing and unified UI/config/localization. Switch the root profile and
release metadata only after that integration is complete.
