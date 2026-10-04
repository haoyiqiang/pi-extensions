# Upstream provenance

- Project: [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)
- Upstream package: `@tintinweb/pi-subagents`
- Package version: `0.19.0`
- Baseline commit: [`e955e29c51b7a6cce37e1108cd2d6c57a77e151c`](https://github.com/tintinweb/pi-subagents/commit/e955e29c51b7a6cce37e1108cd2d6c57a77e151c)
- License: MIT; original copyright notice retained verbatim in `LICENSE`.

## Import scope

Imported `src/`, `test/` (including hidden `.pi` fixtures), `docs/`, `examples/`,
`LICENSE`, and `biome.json`. The upstream README is archived at
`docs/upstream-README.md`, with an archive banner and relocated example link.

Not imported: Git metadata, GitHub workflows, personal agent configuration,
media assets, generated `dist`, `node_modules`, upstream lockfile, release scripts,
changelog history, or upstream maintainer instructions. The repository's contribution
and release rules apply to this workspace.

## Local integration

- Renamed the private workspace to `@maplezzk/pi-subagents@0.1.0`.
- Added a source entrypoint, bilingual migration READMEs, and root architecture registration.
- No Pi resource registration, root-profile entry, or release metadata.
- Aligned Pi development dependencies to 0.87.1, TypeScript to 5.9.3, and Vitest to 5.0.1.
- Source remains TypeScript with the upstream `.js` import convention; bundler resolution
  and Pi's TypeScript loader resolve these paths. Builds run type checking, not dist generation.
- Tests run in bounded fork workers with isolated HOME/agent/session directories and
  a temporary project Git repository. Inherited Git overrides are cleared and real-model
  execution is disabled. Upstream test cases are retained.
- Replaced the Windows path fixture's user-directory spelling with a generic workspace path.
- Removed extra EOF blank lines from `agent-types.ts` and `enabled-models.ts` for the repository whitespace gate.

## Pi 0.87.1 compatibility delta

- `src/agent-runner.ts`: pass the parent's `ModelRuntime` rather than the removed SDK
  `modelRegistry` option. A hidden inline extension enforces live tool scope via the
  native `tool_call` veto, composing with loaded extension handlers.
- `src/mention-clone.ts`: seed cloned history through `SessionManager.inMemory` and
  provide the live prompt through `DefaultResourceLoader`; do not mutate the read-only
  agent system prompt or bypass the session's authoritative transcript. Resource
  loading and session construction both run under the child-session activation guard.
- `src/nested-tools.ts` and `src/structured-output.ts`: throw on tool errors, letting
  Pi construct failed tool results rather than silently ignoring a returned `isError`.
  Duplicate mention-clone spawns use the same contract.
- Test doubles and faux-provider responders now consume normalized transcript system
  messages (`getCurrentTools` / `getCurrentSystemPrompt`) and current settings/runtime
  APIs. Real-SDK tests retain tool visibility/veto, clone, usage, and workflow coverage.

The upstream access to the registry facade's wrapped `.runtime` remains a compatibility
boundary; a real-SDK regression test pins it for 0.87.1. This import is not a claim of
compatibility with untested future Pi releases.

## Embedded backend extraction

- Moved the original runner to `src/backends/embedded.ts`; `src/agent-runner.ts`
  preserves its exports and shared configuration instance.
- Added a private `AgentExecutionBackend` port to AgentManager; queues, records,
  ownership, worktrees, completion, and abort-controller policy remain manager-owned.
- Routed top-level/nested tool steering and queued steer delivery through the manager
  to the backend, retaining awaitable errors for tools and fire-and-forget UI behavior.
- Moved lifecycle cleanup to `embedded-lifecycle.ts`, retaining the 3-second shutdown
  bound and adding idempotency and early timer cleanup.
- Updated steering test doubles and added backend injection/lifecycle/facade tests.

The original seam used native Pi session types. It has since moved to the opaque
session boundary described below (see [execution boundary](./docs/execution-backend.md)).
Full terminal integration, shared configuration migration, localization, and release
activation remain separate steps.

## Terminal lifecycle groundwork

The private lifecycle primitive in `src/backends/terminal/` adapts the Pi-backed
launch/watch/interrupt semantics and session-summary extraction from this repository's
`@maplezzk/pi-interactive-subagents@3.16.2` (last package change `7ed4655`). That product
is derived from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents).
Its MIT notice is retained verbatim in [docs/LICENSE.interactive-subagents](./docs/LICENSE.interactive-subagents).
The active old package is not modified or imported as a runtime dependency.

This is a selective extraction, not a wholesale source copy. It replaces the global
run map/module abort/UI notification coupling with per-run handles and injected ports,
separates run/session identities, closes surfaces on startup failure, preserves exit
payloads, and excludes prior turns on resume. Public `pi-terminal-mux` handles terminal
operations. New diagnostic catalogs use `pi-extensions-i18n`; neither dependency
activates this private workspace. The strict source consumer enables
`allowImportingTsExtensions` for these source-distributed dependencies; a guarded
Herdr diagnostic interpolation was made strict-null-safe without changing behavior. See [terminal lifecycle](./docs/terminal-lifecycle.md)
for explicitly deferred CLI/child-bridge, session-store, terminal-manager wiring, and workflow work.

## Backend-neutral session observations

- Added `src/backends/session.ts` for read-only messages, observation events, stats,
  identity, and model/thinking metadata, without importing native session/event types.
- Added a per-manager embedded adapter that keeps native sessions in private weak
  lookups. Controls accept only owned handles; closed sessions cannot resume/steer.
  Event subscription teardown is idempotent and suppresses late callbacks.
- `AgentRecord.session`, manager/nested creation callbacks, UI, output streaming,
  and result formatting now consume these views. The raw runner facade still uses
  native sessions; its execution implementation is unchanged.
- Moved the existing transcript formatter into `src/transcript.ts`, preserving its
  facade export and display wording. Live getters preserve message identity and
  compaction replacement; no provider/custom message fields are stripped from output.
- Adapted GC fixtures to create sessions through the runner rather than overwrite
  manager records with raw SDK objects, and completed two RPC result fixtures that
  omitted required session/result fields. Preserved synchronous startup-error timing
  so failed launches are not announced as started. Added adapter ownership/lifecycle tests and
  a native-free fake backend covering manager resume, output, compaction, and viewer
  rendering. Workflow-menu sorting fixtures use distinct deterministic timestamps
  instead of relying on wall-clock millisecond differences. This fake backend is not
  a real terminal execution adapter.

Request preparation still uses Pi context and existing runner option types. There is
no new persisted configuration, root-profile change, release activation, or public API promise.

## Real terminal execution, initial private slice

- Added `terminal/backend.ts` implementing the manager port through a real Pi CLI
  process, canonical remote session views and acknowledged steering. Default manager
  construction remains embedded; only explicit factory injection selects terminal.
- Added an isolated launch-policy preparer reusing existing agent/model/prompt
  resolution. Unsupported inheritance, external resume/fork, memory, schemas and
  finite turn limits fail rather than silently degrade. The child uses the installed
  Pi peer's CLI, disables resource discovery and automatic refresh, and validates
  model identity plus a credential-free API/endpoint fingerprint.
- Added per-run authenticated loopback feedback with bounded sequenced frames. The
  child waits for authentication and a parent start grant; early steering is queued
  until the SDK's agent_start. Completion uses agent_settled, not agent_end.
- Added a process supervisor, owned POSIX group/visible-descendant cleanup, atomic
  exit receipts and bounded post-settlement retirement. Screen sentinels are never
  completion authority for this backend. Uncertain shutdown quarantines a session.
  Native Windows/PowerShell runtime is explicitly unsupported pending job-object
  guarantees; the lower-level command-construction helpers remain available.
- Added real Pi CLI/headless tests using a scripted native provider, alongside
  transport, child policy, process-tree, receipt, timeout and ownership regressions.
  No external model, credential or mux daemon is required by the tests.

This new bridge does not import the old product's private implementation or duplicate
its registry, notifications or widget. See [terminal backend](./docs/terminal-backend.md)
for the exact supported slice, lifetime limits and work deferred before activation.

## Terminal structured output and invocation limits

This step supersedes the initial slice's schema/finite-turn-limit rejection:

- Terminal preparation snapshots JSON-only schemas and resolved soft/grace turn
  budgets before environment work. Both the CLI registry allowlist and the child
  event/tool guards admit the synthetic `StructuredOutput` tool, including with
  no builtins enabled; unrelated provider tools remain excluded.
- The child reuses the shared validated capture tool and requests at most one
  missing-output continuation at `agent_before_settle`. Turn counting spans those
  continuations and automatic recovery; soft limits request wrap-up and exhausted
  grace aborts. Abort bookkeeping after that boundary does not add budget turns.
- Feedback carries structured JSON, retry and wrap-up flags. The parent validates
  returned JSON again, including any caller-side check, before exposing it. Owned
  terminal resumes retain policy but reset capture/retry/turn state per invocation.
- The neutral resume result and both manager paths propagate this metadata and
  discard stale prior results. A foreground resume now owns a fresh cancellation
  controller, busy resumes cannot replace it, and already-aborted parent signals
  reach both resume paths. Pool/notification ownership stays with the manager.
- Shared structured tool/schema diagnostics and the wrap-up prompt use bilingual
  catalogs without changing TypeBox's process-global locale. Embedded fresh-run
  behavior is unchanged apart from localized wording and the shared failure helper;
  embedded resume policy subscriptions remain a separate parity task.
- Extended the offline real Pi CLI provider/tests for schema correction, bounded
  recovery, sticky resume policy, turn-limit precedence and active-request cancel.

No configuration switch, root-profile activation, public export or release metadata
is added. External reattach/fork and the remaining backend parity work are still
required before production routing.
