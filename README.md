# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A small collection of composable extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

## Packages

Published packages are independently installable from npm. The unified subagent/workflow products are included in the Git/local suite but are not yet npm releases. Each package owns its behavior, configuration, examples, and tests.

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
| [`@maplezzk/pi-subagents`](./packages/pi-subagents) | Unified Agent/RPC/Fleet with configurable embedded or terminal Pi execution. Included in the Git/local profile; npm publication is separate. | [English](./packages/pi-subagents/README.md) · [中文](./packages/pi-subagents/README.zh-CN.md) |
| [`@maplezzk/pi-workflow`](./packages/pi-workflow) | Independent workflow DSL, `/wf`, journals, cancellation and recovery, using the unified execution runtime. Included in the Git/local profile. | [English](./packages/pi-workflow/README.md) · [中文](./packages/pi-workflow/README.zh-CN.md) |

Shared libraries are published for feature-package dependencies but are not loaded as extensions: [`pi-extensions-config`](./packages/pi-extensions-config) provides portable JSON config I/O, while [`pi-terminal-mux`](./packages/pi-terminal-mux) provides terminal surface operations.

> `pi-naming` is now part of `pi-spark`. Remove the old standalone extension before reloading; Spark reads its old config only when `spark.json` does not define `naming`. See [migration instructions](./packages/pi-spark/README.md#migrating-from-pi-naming).

> `pi-session-tools` has been retired and removed from this repository. Existing sessions with its historical `session-squash` entries remain readable by compatibility code in packages that explicitly support them.

> `pi-interactive-subagents` is retired from the default profile and release chain. Stop old work and remove separately installed old entries before reloading. See the [migration guide](./packages/pi-subagents/docs/migration.md); old tools and `/plan`/`/iterate`/`/subagent` aliases are not retained.

Extension management slash commands use the `/config:<feature>[-action]` convention. Workflow execution uses `/wf` and `/wf-cancel`.

## Install everything

Requirements: Pi 0.87.1 or a tested compatible extension runtime, and Node.js 22 or newer.

```bash
pi install git:github.com/maplezzk/pi-extensions
```

The repository root is also an explicit full-suite Pi profile. Its manifest allowlists every extension and includes the `pi-spark` themes; library-only packages such as `pi-terminal-mux` are never loaded as extensions. Adding a workspace package does not automatically add it to this profile.

The full profile intentionally enables invasive features together: `pi-spark` replaces the editor/footer and folds transcript activity, `pi-blackhole` owns automatic compaction, `pi-distill` transforms tool results, `pi-rewind` manages Git-backed checkpoints, and unified subagents can create terminal surfaces when terminal execution is selected. Prefer single-package npm installs for published capabilities when you do not want the complete composition.

Reload Pi after installation:

```text
/reload
```

To install a published package independently, use its npm package name (the two unified products remain unpublished):

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

The root profile loads [`pi-subagents`](./packages/pi-subagents/README.md) and [`pi-workflow`](./packages/pi-workflow/README.md). They remain npm-private products, not inactive workspaces: Agent/RPC/Fleet and configurable Pi execution belong to subagents; the independent DSL, runner, journals and `/wf` belong to workflow. They communicate through a versioned event bus. The retired interactive source is archived outside this repository; it is no longer a workspace, build/test target or release candidate. Absorbed-code attribution remains in unified subagents. Publication readiness and inherited UI localization remain separate from this runtime switch.

The repository pins `https://registry.npmjs.org/` in `.npmrc` so lockfile tarball URLs stay portable. Installing through a mirror registry rewrites those URLs and makes `npm ci` fail on npm 12+ with `EALLOWREMOTE`; `node scripts/check-lockfile-registry.mjs` (part of `npm run check`) blocks that before merge.

## License

[MIT](./LICENSE)
