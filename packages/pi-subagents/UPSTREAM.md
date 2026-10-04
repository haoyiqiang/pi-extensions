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

The seam intentionally still uses native Pi session types (see
[execution boundary](./docs/execution-backend.md)). Terminal integration, shared
configuration migration, full localization, and release activation belong to later
batches. No code from `pi-interactive-subagents` is imported yet.
