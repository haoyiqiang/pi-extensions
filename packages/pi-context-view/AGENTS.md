# pi-context-view

TypeScript Pi extension (`index.ts` → `src/index.ts`) with two TUI-only overlays and one utility command:

- `/context` or `/context usage` — estimate current context composition.
- `/context injections` — inspect the frozen Initial snapshot with opt-in raw previews.
- `/context config` — explicitly create the defaults-populated global config file.

The command accepts only `usage`, `injections`, and `config`; keep both views unavailable outside TUI mode and `config` available in every run mode.

## Sources of truth

| Path                  | Read before                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc/ARCHITECTURE.md` | Changing lifecycle capture, silent probes, attribution, usage accounting, the semantic model, configuration semantics, or privacy behavior.                                                              |
| `doc/UI.md`           | Changing the shared frame, colors, casing, descriptions, interaction, responsive behavior, or release media. Per-view rules live in `doc/ui/usage.md`, `doc/ui/injections.md`, and `doc/ui/previews.md`. |
| `doc/THINKING.md`     | Changing reasoning-token accounting, signature handling, or thinking-preview notation.                                                                                                                   |
| `doc/PLAN.md`         | Adding commands, configuration, runtime inspection, or other roadmap work.                                                                                                                               |
| Root release files          | Changing versions or publishing. Releases are managed by the monorepo release-please workflow. |

## Repository rules

- **Architecture contract.** Preserve the invariants in `doc/ARCHITECTURE.md`; update that document with any lifecycle, capture, attribution, or usage behavior change.
- **Privacy gate.** Keep raw prompts and messages process-local and terminal-sanitized; expose them only after explicit Enter preview, and never log them, persist extra copies, include them in notifications, or inject them into later requests.
- **Module boundaries.** Keep `src/index.ts` to pi event and command wiring; put independently testable state, measurement, and rendering behavior in focused modules under `src/` and `src/ui/`.
- **Command contract.** Keep parsing, completions, registration text, README usage, and command tests synchronized whenever the `/context` grammar or mode guard changes.
- **Config contract.** Keep user-configurable state override-only: defaults in code, no auto-created or default-backfilled config file, invalid entries degrading to defaults. `doc/ARCHITECTURE.md` holds the full load and write contract.
- **UI contract.** Treat `doc/UI.md` and `doc/ui/` as canonical; update the owning page and focused tests whenever the specified TUI behavior changes.
- **Dependency contract.** Keep Pi packages as compatible peer dependencies and exact development pins aligned with the monorepo; refresh the root `package-lock.json` with npm after changing pins.

## Verification

```bash
npm run check --workspace pi-context-view
```

- **Lifecycle changes.** Load `tests/fixtures/marker.ts`, `tests/fixtures/forced-prompt.ts`, and `tests/fixtures/input-transform.ts` in both extension orders and use an `after_provider_response` sentinel to prove a probe makes no provider request.
- **TUI changes.** Follow the `pi-extension` skill for real-PTY and provider smoke tests, and exercise the dimensions and interactions required by `doc/UI.md`.
