# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A small collection of composable extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

## Packages

Each package is independently installable and keeps its detailed behavior, configuration, examples, and tests in its own README.

| Package | Description | Documentation |
| --- | --- | --- |
| [`pi-blackhole`](./packages/pi-blackhole) | Provides deterministic compaction, session-aware observational memory, and raw-history recall. | [English](./packages/pi-blackhole/README.md) · [中文](./packages/pi-blackhole/README.zh-CN.md) |
| [`pi-context-view`](./packages/pi-context-view) | Visualizes context usage and inspects system prompt, tool, skill, and extension injections. | [English](./packages/pi-context-view/README.md) · [中文](./packages/pi-context-view/README.zh-CN.md) |
| [`pi-rewind`](./packages/pi-rewind) | Creates Git-backed checkpoints and restores files, conversation state, or both. | [English](./packages/pi-rewind/README.md) · [中文](./packages/pi-rewind/README.zh-CN.md) |
| [`pi-spark`](./packages/pi-spark) | Owns the compact editor/footer TUI, clean transcript folding, provider credits, model presets, idle recaps, metrics, session/terminal naming, and the `#` resource picker. | [English](./packages/pi-spark/README.md) · [中文](./packages/pi-spark/README.zh-CN.md) |
| [`pi-distill`](./packages/pi-distill) | Compacts verbose output from every active object-schema tool before it consumes the context window. | [English](./packages/pi-distill/README.md) · [中文](./packages/pi-distill/README.zh-CN.md) |
| [`pi-models-discovery`](./packages/pi-models-discovery) | Discovers models from `{baseUrl}/models` for providers marked with `discoverModels` in models.json, with a persistent startup cache and a manual refresh command. | [English](./packages/pi-models-discovery/README.md) · [中文](./packages/pi-models-discovery/README.zh-CN.md) |
| [`pi-extensions-i18n`](./packages/pi-extensions-i18n) | Provides shared locale selection, catalog loading, interpolation, and the `/config:language` command. | [English](./packages/pi-extensions-i18n/README.md) · [中文](./packages/pi-extensions-i18n/README.zh-CN.md) |
| [`@maplezzk/pi-web-search`](./packages/pi-web-search) | Combines LLM built-in web search, independent Search APIs, Gemini/Vertex URL Context, bounded web fetching, and opt-in GitHub repository extraction. | [English](./packages/pi-web-search/README.md) · [中文](./packages/pi-web-search/README.zh-CN.md) |
| [`@maplezzk/pi-interactive-subagents`](./packages/pi-interactive-subagents) | Non-blocking interactive subagents in multiplexer panes with live status widget, `/plan` and `/iterate` workflows. Fork of HazAT/pi-interactive-subagents. | [English](./packages/pi-interactive-subagents/README.md) · [中文](./packages/pi-interactive-subagents/README.zh-CN.md) |

Shared libraries are published for feature-package dependencies but are not loaded as extensions: [`pi-extensions-config`](./packages/pi-extensions-config) provides portable JSON config I/O, while [`pi-terminal-mux`](./packages/pi-terminal-mux) provides terminal surface operations.

> `pi-naming` is now part of `pi-spark`. Remove the old standalone extension before reloading; Spark reads its old config only when `spark.json` does not define `naming`. See [migration instructions](./packages/pi-spark/README.md#migrating-from-pi-naming).

> `pi-session-tools` has been retired and removed from this repository. Existing sessions with its historical `session-squash` entries remain readable by compatibility code in packages that explicitly support them.

Extension management slash commands use the `/config:<feature>[-action]` convention. Legacy names remain as compatibility aliases where a command was renamed; `/plan`, `/iterate`, and `/subagent` are intentionally short workflow shortcuts.

## Install everything

Requirements: Pi with the compatible extension API and Node.js 22 or newer.

```bash
pi install git:github.com/maplezzk/pi-extensions
```

The repository root is also an explicit full-suite Pi profile. Its manifest allowlists every extension and includes the `pi-spark` themes; library-only packages such as `pi-terminal-mux` are never loaded as extensions. Adding a workspace package does not automatically add it to this profile.

The full profile intentionally enables invasive features together: `pi-spark` replaces the editor/footer and folds transcript activity, `pi-blackhole` owns automatic compaction, `pi-distill` transforms tool results, `pi-rewind` manages Git-backed checkpoints, and interactive subagents create terminal surfaces. Prefer single-package npm installs when you do not want the complete composition.

Reload Pi after installation:

```text
/reload
```

To install a single package, use its npm package name:

```bash
pi install npm:<package-name>
```

## Configuration

Most configurable extensions keep state under the Pi agent directory; exact paths, command names, environment precedence, and verification steps differ by package. See [`packages/`](./packages) for configuration examples and detailed documentation.

## Development

```bash
npm install
npm run check
```

The check command runs workspace type checks, tests, and the portability/i18n gates.

[`packages/pi-subagents`](./packages/pi-subagents/README.md) and [`packages/pi-workflow`](./packages/pi-workflow/README.md) are private migration workspaces. The former unifies Agent/RPC/Fleet over configurable embedded/terminal execution without retaining the old interactive-tool aliases; the latter retains the independent workflow DSL, runner, journals and `/wf` frontend imported from `rpiv-workflow`. Standard SDK stages preserve normal resources and delegate through the common subagent runtime; managed isolation is an explicit profile. They collaborate through an explicit event-bus executor protocol rather than importing each other's internals. Both participate in development checks but are neither published nor loaded by the root Pi profile; the existing interactive-subagents package remains active.

The repository pins `https://registry.npmjs.org/` in `.npmrc` so lockfile tarball URLs stay portable. Installing through a mirror registry rewrites those URLs and makes `npm ci` fail on npm 12+ with `EALLOWREMOTE`; `node scripts/check-lockfile-registry.mjs` (part of `npm run check`) blocks that before merge.

## License

[MIT](./LICENSE)
