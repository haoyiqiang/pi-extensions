# pi-extensions agent and contributor guide

This repository contains small, independently installable extensions for the [Pi coding agent](https://github.com/earendil-works/pi). The project is public and portable: changes must work without access to a maintainer's machine, private services, or local daemon.

## Repository map

```text
pi-extensions/
├── packages/
│   ├── pi-action-fusion/        # Opt-in edit/write + follow-up command (SoL-Pi adaptation)
│   ├── pi-utils/                # Library: config I/O, locale helpers, and test fixtures
│   ├── pi-web-search/    # LLM/API search, URL Context, and bounded web fetch
│   ├── pi-distill/              # Tool-output distillation
│   ├── pi-terminal-mux/         # Terminal multiplexer abstraction (muxy/cmux/tmux/zellij/wezterm/herdr/otty/orca + headless fallback)
│   ├── pi-models-discovery/     # Dynamic model discovery for providers marked with discoverModels
│   ├── pi-blackhole/            # Deterministic compaction, observational memory, and recall
│   ├── pi-context-view/         # Context usage and injection inspection
│   ├── pi-rewind/               # Git-backed checkpoints and rewind
│   ├── pi-subagent/             # Persistent subagents in a terminal panel
│   └── pi-spark/                # Compact TUI, clean transcript, credits, presets, recap, metrics, resources, naming
├── scripts/                     # Repository checks and workspace helpers
├── .github/workflows/           # CI and release automation
├── README.md                    # English project documentation
├── README.zh-CN.md              # Chinese project documentation
├── AGENTS.md                    # This guide
└── package.json                 # Private npm workspace root
```

Each package owns its entrypoint, tests, configuration example, localization resources, and package README. The public package source of truth is this repository; consumers should install the published npm packages instead of copying package source into another project.

The layer model, allowed workspace dependency edges, UI ownership, and root distribution-profile rules are enforced by `scripts/check-package-boundaries.mjs` and `scripts/check-package-config.mjs`. The root Pi manifest is an explicit allowlist; never restore a `packages/*/index.ts` loading glob.

## Package boundaries

- `pi-spark` owns automatic Pi session titles and manual terminal naming under `spark.json`'s `naming` feature. It uses the Pi model registry and terminal-mux; automatic and manual naming share configurable session/workspace/tab targets. The retired `pi-naming` config is read-only fallback, not a second runtime or write target.

- `pi-action-fusion` owns opt-in native `edit`/`write` replacements with `then_run`; it does not summarize outputs or compact context. Internal follow-up commands emit only the outer mutation's tool events, not a separate Bash call. Do not co-load another mutation-tool replacement or assume Bash-only guards cover fused commands.
- `pi-distill` discovers active tools with object parameter schemas and observes their results through Pi's native `tool_call` and `tool_result` events. It owns ordinary summaries and opt-in exact-quote diagnostic evidence, requiring source archival before any lossy replacement. RAW and failures retain received content; native `read` with RAW handles source readback. Fusion handling is opt-in and command-log-only; never summarize mutation confirmations or diff/patch. It does not register duplicate or readback tools and renders audit information through its own UI-only session entry.
- `pi-utils` is a library, not a Pi extension. It owns portable agent-dir/JSON config I/O and the deterministic test fixtures (`createExtensionRegistrationHarness`, temp-directory isolation, and `pi-utils/rpiv`). It does not own locale selection, notice rendering, or a Pi extension entry. Feature packages call `ctx.ui.notify` directly and keep user-facing text in English.
- Background chat requests from an extension go through `ctx.modelRegistry.streamSimple(...).result()`, the same way `pi-spark` recap does. `ModelRuntime.prepareRequest` resolves auth and a resolved `baseUrl`. `openai-codex` background calls use an isolated `uuidv7` session and clean it up afterwards. Raw HTTP transports use `modelRegistry.getApiKeyAndHeaders` directly. Do not add another shared request wrapper, and do not call `pi-ai` `complete` / `completeSimple` for these side requests.
- `pi-web-search` owns the public `web_search`, `url_context`, and `web_fetch` tools. It routes explicitly between LLM built-in web search and one configured Search API, keeps URL Context limited to supported Google/Vertex transports, and returns bounded fetch output with an opt-in rpiv-compatible GitHub repository interceptor, without adding general PDF or local-video pipelines.
- `pi-terminal-mux` owns terminal multiplexer detection and pane/surface operations. Extensions that need terminal interaction depend on it instead of re-implementing backend detection.
- `pi-models-discovery` owns dynamic model discovery: it reads `discoverModels` providers from models.json, fetches `{baseUrl}/models`, persists a startup cache, and exposes `/model-discovery` plus `/model-discovery-refresh` commands.
- `pi-blackhole` owns deterministic compaction, observational-memory workers, and raw-session recall. Do not combine its automatic compaction ownership with another automatic context owner.
- `pi-context-view` passively inspects context composition and hidden injections; it must not add persistent model-context instructions or messages.
- `pi-rewind` owns Git-backed worktree checkpoints and coordinated file/session restore. It is not a substitute for context compaction.
- `pi-subagent` owns persistent subagent runs. It opens panels through `pi-terminal-mux` and does not register `/subagent`.

Keep packages composable and independently installable. Avoid coupling one extension to another extension's private implementation details or display state.

## Portability and safety

- Do not commit user-specific paths, credentials, private domains, internal service names, or machine-specific defaults.
- Resolve user directories with `os.homedir()` or Pi's standard configuration directory. Support `PI_CODING_AGENT_DIR` where the package already exposes that configuration point.
- Optional external tools must be detected at runtime and have a graceful fallback or noop path.
- `pi-spark` owns transcript folding, provider credit reporting, model presets, idle recap, session metrics, the `#` session resource picker, and the compact editor/footer TUI. It replaces Pi's editor and footer, so do not combine it with another extension that owns the same surfaces. Its naming feature also owns session and terminal titles; `pi-terminal-mux` remains the independent operation library.
- Do not make network calls, model assumptions, or local daemon availability implicit in deterministic tests.
- Shared test scaffolding belongs in the `pi-utils` workspace; keep domain-specific fixtures with their owning package.
- Use configuration or injected adapters for environment-specific behavior.

## User-facing text and localization

User-visible messages, command descriptions, tool descriptions, and agent-facing prompts are English string literals in the owning package. Do not add a locale catalog, translator, or `/pi-language` command.

User-visible notices call `ctx.ui.notify(message, level)` directly. Do not add a shared notice renderer or source-tag wrapper. `pi-utils` is a library, not a Pi extension.

Keep developer comments and implementation notes concise. Keep the English and Chinese README files separate so each language has a complete, readable entrypoint.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical label names without overrides. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See `docs/agents/domain.md`.

## Development

Requirements: Node.js 22 or newer and a compatible Pi extension runtime for manual smoke tests.

```bash
npm install
npm run typecheck
npm test
npm run check
```

`npm run check` is the repository gate. It runs type checks, package tests, dependency-boundary checks, npm tarball manifest checks, release checks, and the local-binding policy check. Tests should be deterministic and must not require API keys, a live reviewer model, or a particular filesystem layout.
Workspace development dependencies on `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui` use one exact version (`0.87.1` at this revision). Keep them in lockstep; package peer ranges continue to describe the package's tested runtime compatibility.

When changing a package, also inspect its package-level README and `config.example.json`. If the public behavior changes, add or update focused tests and document the configuration or compatibility impact.

## Pull requests

Use Conventional Commits such as `feat:`, `fix:`, `refactor:`, `docs:`, and `chore:`. A pull request should explain:

1. the user problem or maintenance problem;
2. the observable behavior that changed;
3. package and documentation impact;
4. validation performed, including any limitations.

Keep unrelated refactors out of a focused pull request. Run `npm run check` before requesting review.

## Releases

Versions and changelogs are managed by release-please. Merging a release PR runs the repository gate once, then publishes changed packages to npm in workspace-dependency order: `pi-utils` first, terminal-mux and other direct consumers after that, and terminal-mux consumers last. External historical archives are not publication candidates. Publish jobs verify their own tarball plus the npm visibility of workspace dependency ranges. Do not publish manually from a local machine unless the release procedure explicitly requires it.
ase procedure explicitly requires it.
