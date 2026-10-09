# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A small collection of composable extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

## Packages

Published packages are independently installable from npm. Each package owns its behavior, configuration, examples, and tests.

| Package | Description | Documentation |
| --- | --- | --- |
| [`pi-blackhole`](./packages/pi-blackhole) | Provides deterministic compaction, session-aware observational memory, and raw-history recall. | [English](./packages/pi-blackhole/README.md) · [中文](./packages/pi-blackhole/README.zh-CN.md) |
| [`pi-context-view`](./packages/pi-context-view) | Visualizes context usage and inspects system prompt, tool, skill, and extension injections. | [English](./packages/pi-context-view/README.md) · [中文](./packages/pi-context-view/README.zh-CN.md) |
| [`pi-rewind`](./packages/pi-rewind) | Creates Git-backed checkpoints and restores files, conversation state, or both. | [English](./packages/pi-rewind/README.md) · [中文](./packages/pi-rewind/README.zh-CN.md) |
| [`pi-spark`](./packages/pi-spark) | Owns the compact editor/footer TUI, clean transcript folding, provider credits, model presets, idle recaps, metrics, session/terminal naming, and the `#` resource picker. | [English](./packages/pi-spark/README.md) · [中文](./packages/pi-spark/README.zh-CN.md) |
| [`pi-distill`](./packages/pi-distill) | Archives sources before summarizing enabled tool results, with opt-in locally verified diagnostic evidence. | [English](./packages/pi-distill/README.md) · [中文](./packages/pi-distill/README.zh-CN.md) |
| [`pi-action-fusion`](./packages/pi-action-fusion) | Opt-in single-file edit/write plus a follow-up command in one tool call; adapted from SoL-Pi, disabled by default. New package, pending first npm release; available in the Git/local suite. | [English](./packages/pi-action-fusion/README.md) · [中文](./packages/pi-action-fusion/README.zh-CN.md) |
| [`pi-models-discovery`](./packages/pi-models-discovery) | Discovers models from `{baseUrl}/models` for providers marked with `discoverModels` in models.json, with a persistent startup cache and a manual refresh command. | [English](./packages/pi-models-discovery/README.md) · [中文](./packages/pi-models-discovery/README.zh-CN.md) |
| [`pi-utils`](./packages/pi-utils) | Shared portable JSON config I/O, locale/catalog runtime with source-tagged notices, and deterministic test fixtures. | [English](./packages/pi-utils/README.md) · [中文](./packages/pi-utils/README.zh-CN.md) |
| [`@maplezzk/pi-web-search`](./packages/pi-web-search) | Combines LLM built-in web search, independent Search APIs, Gemini/Vertex URL Context, bounded web fetching, and opt-in GitHub repository extraction. | [English](./packages/pi-web-search/README.md) · [中文](./packages/pi-web-search/README.zh-CN.md) |
| [`@maplezzk/pi-todo`](./packages/pi-todo) | Branch-replayed task lists, dependency validation and a compact owned task panel. | [English](./packages/pi-todo/README.md) · [中文](./packages/pi-todo/README.zh-CN.md) |

Shared libraries are published for feature-package dependencies. [`pi-utils`](./packages/pi-utils) owns portable JSON config I/O, the locale/catalog runtime, the shared notice renderer, and deterministic test fixtures; feature packages load its extension entry through a shipped `i18n-entry.ts` shim. [`pi-terminal-mux`](./packages/pi-terminal-mux) provides terminal surface operations.

> `pi-naming` is now part of `pi-spark`. Remove the old standalone extension before reloading; Spark reads its old config only when `spark.json` does not define `naming`. See [migration instructions](./packages/pi-spark/README.md#migrating-from-pi-naming).

> `pi-session-tools` has been retired and removed from this repository. Existing sessions with its historical `session-squash` entries remain readable by compatibility code in packages that explicitly support them.

> `pi-interactive-subagents`, `pi-subagents`, and `pi-workflow` are retired and removed from this repository. Stop old work and remove separately installed old entries before reloading; the old subagent tools, `/plan`/`/iterate`/`/subagent` aliases, and `/wf` commands are not retained.

Extension management slash commands use the `/config:<feature>[-action]` convention.

## Install everything

Requirements: Pi 0.87.1 or a tested compatible extension runtime, and Node.js 22 or newer.

```bash
pi install git:github.com/maplezzk/pi-extensions
```

The repository root is also an explicit full-suite Pi profile. Its manifest allowlists every extension and includes the `pi-spark` themes; library-only packages such as `pi-terminal-mux` are never loaded as extensions. Adding a workspace package does not automatically add it to this profile.

The full profile intentionally enables invasive features together: `pi-spark` replaces the editor/footer and folds transcript activity, `pi-blackhole` owns automatic compaction, `pi-distill` transforms tool results, and `pi-rewind` manages Git-backed checkpoints. Prefer single-package npm installs for published capabilities when you do not want the complete composition.

`pi-action-fusion` is also loaded by the profile but stays disabled until explicitly enabled with `/config:action-fusion enable` followed by `/reload`. It does not replace `pi-distill` or add another compaction owner.

Reload Pi after installation:

```text
/reload
```

To install a published package independently, use its npm package name:

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

The retired subagent/workflow products are not workspaces, root-profile entries, or release candidates. Their external archive is not a repository dependency.

The repository pins `https://registry.npmjs.org/` in `.npmrc` so lockfile tarball URLs stay portable. Installing through a mirror registry rewrites those URLs and makes `npm ci` fail on npm 12+ with `EALLOWREMOTE`; `node scripts/check-lockfile-registry.mjs` (part of `npm run check`) blocks that before merge.

## License

[MIT](./LICENSE)
