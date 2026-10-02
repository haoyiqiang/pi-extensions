# pi-rewind contributor guide

`pi-rewind` is a Git-backed checkpoint and rewind extension for Pi. The package is maintained and released from the parent `pi-extensions` monorepo.

## Architecture

- `index.ts` is the public package and Pi extension entrypoint.
- `src/index.ts` wires Pi lifecycle events to checkpoint behavior.
- `src/core.ts` owns pure Git operations and must not depend on Pi.
- `src/commands.ts` owns `/rewind`, the `Ctrl+Shift+R` shortcut, diff preview, restore choices, and fork/tree restore prompts.
- `src/state.ts` owns runtime state.
- `src/ui.ts` owns footer status rendering.
- `tests/core.test.ts` exercises Git behavior in disposable repositories.
- `tests/e2e.sh` starts real Pi sessions and is not part of deterministic CI.

## Behavior contracts

- Create one resume checkpoint on session startup.
- Create at most one mutation checkpoint at `turn_end`, after all tools in the response finish.
- Track `write`, `edit`, and `bash` as potentially mutating tools, then deduplicate snapshots when the worktree tree is unchanged.
- Store checkpoints below `refs/pi-checkpoints/`; do not create ordinary commits or modify the user's branch history.
- Block cross-branch restore.
- Preserve ignored paths, dependency directories, pre-existing untracked files, oversized files, and oversized directories according to the filters in `src/core.ts`.
- Checkpoint failures are non-fatal and must not block the agent.
- Use argument arrays with `spawn`; never concatenate untrusted values into shell commands.

## Package rules

- Use `@earendil-works/pi-coding-agent`; do not restore the old `@mariozechner` package name.
- Keep `main`, `exports`, and `pi.extensions` pointed at `./index.ts`.
- Keep `README.md` and `README.zh-CN.md` synchronized with command and restore behavior.
- Versions and npm publication are managed by the parent repository's release-please workflow. Do not add a package-local publish workflow or lockfile.

## Verification

Run from the repository root:
```bash
npm run typecheck --workspace pi-rewind
npm test --workspace pi-rewind
npm run check --workspace pi-rewind
```

Run `tests/e2e.sh` only with explicit authorization for real Pi/model calls. If it is not run, report `NOT_RUN`.