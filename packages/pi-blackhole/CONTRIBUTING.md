# Contributing

Thanks for improving `pi-blackhole`. This package is maintained and released from the parent `pi-extensions` monorepo.

## Development setup

Run commands from the monorepo root:

```bash
npm install
npm run typecheck --workspace pi-blackhole
npm test --workspace pi-blackhole
npm run check --workspace pi-blackhole
```

The deterministic tests use fake agent loops and local fixtures. They must not require API keys, network access, or live model calls.

## Change rules

- Keep changes focused on compaction, observational memory, recall, or their direct configuration and presentation.
- Preserve the package boundaries documented in `AGENTS.md`.
- Treat `src/pi-base/` as vendored upstream code. Change it only when a runtime issue requires a focused fix.
- Keep `README.md`, `README.zh-CN.md`, `docs/CONFIG.md`, `llms.txt`, and `src/core/unified-config.ts` synchronized when configuration or defaults change.
- Update the relevant architecture or feature document for substantial behavior changes.
- Add a user-facing entry under `CHANGELOG.md` → `Unreleased` for substantial changes.
- Keep tests deterministic and cover fallback, empty-input, and failure branches.

## Commits and pull requests

Use Conventional Commits such as `feat:`, `fix:`, `refactor:`, `docs:`, and `chore:`. A pull request should explain:

1. the user or maintenance problem;
2. the observable behavior that changed;
3. alternatives or compatibility concerns;
4. tests and manual validation performed;
5. documentation and changelog impact.

## Releases

Do not publish this package manually and do not add a package-local release workflow or lockfile. The parent repository uses release-please, the root npm workspace, and the shared GitHub Actions OIDC publishing workflow.
