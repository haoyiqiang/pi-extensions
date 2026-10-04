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
- No terminal backend, backend router, config migration, or rpiv-workflow adapter
  has been implemented in this batch.

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

The port still uses native Pi session types; it is not yet a terminal-capable or
public workflow API. See [execution boundary](./docs/execution-backend.md) for the
scope, preserved contracts, and remaining coupling. No new user configuration is added.

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

Next: separate backend-neutral run/session references and integrate the current
terminal implementation, localize and unify UI/config, then switch the root profile
and release metadata before removing the old package.
