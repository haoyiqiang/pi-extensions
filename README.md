# pi-extensions

[![CI](https://github.com/haoyiqiang/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/haoyiqiang/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A small collection of composable extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

## Packages

Published packages are independently installable from npm. Each package owns its behavior, configuration, examples, and tests.

| Package | Description | Documentation |
| --- | --- | --- |
| [`@kevinhao/pi-spark`](./packages/pi-spark) | Owns the compact editor/footer TUI, clean transcript folding, provider credits, model presets, idle recaps, metrics, session/terminal naming, and the `#` resource picker. | [English](./packages/pi-spark/README.md) · [中文](./packages/pi-spark/README.zh-CN.md) |
| [`@kevinhao/pi-utils`](./packages/pi-utils) | Library for portable JSON config I/O and deterministic test fixtures. Not a Pi extension. | [English](./packages/pi-utils/README.md) · [中文](./packages/pi-utils/README.zh-CN.md) |
| [`@kevinhao/pi-web-search`](./packages/pi-web-search) | Combines LLM built-in web search, independent Search APIs, Gemini/Vertex URL Context, bounded web fetching, and opt-in GitHub repository extraction. | [English](./packages/pi-web-search/README.md) · [中文](./packages/pi-web-search/README.zh-CN.md) |
| [`@kevinhao/pi-subagent`](./packages/pi-subagent) | Runs persistent subagents in detached tmux sessions; their status shows above the editor and `/subagent` attaches to one. | [English](./packages/pi-subagent/README.md) · [中文](./packages/pi-subagent/README.zh-CN.md) |

Shared libraries are published for feature-package dependencies. [`@kevinhao/pi-utils`](./packages/pi-utils) is a library, not a Pi extension. It owns portable JSON config I/O and deterministic test fixtures.

> `pi-naming` is now part of `pi-spark`. Remove the old standalone extension before reloading; Spark reads its old config only when `spark.json` does not define `naming`. See [migration instructions](./packages/pi-spark/README.md#migrating-from-pi-naming).

> `pi-session-tools` has been retired and removed from this repository. Existing sessions with its historical `session-squash` entries remain readable by compatibility code in packages that explicitly support them.

> `pi-interactive-subagents`, `pi-subagents`, and `pi-workflow` are retired and removed from this repository. Stop old work and remove separately installed old entries before reloading; the old subagent tools, `/plan`/`/iterate`/`/subagent` aliases, and `/wf` commands are not retained. [`@kevinhao/pi-subagent`](./packages/pi-subagent) is a separate panel-based runner and does not restore those commands.

Extension management slash commands use the `/config:<feature>[-action]` convention.

## Install everything

Requirements: Pi 0.87.1 or a tested compatible extension runtime, and Node.js 22 or newer.

```bash
pi install git:github.com/haoyiqiang/pi-extensions
```

The repository root is also an explicit full-suite Pi profile. Its manifest allowlists every extension and includes the `pi-spark` themes; library-only packages such as `pi-utils` are never loaded as extensions. Adding a workspace package does not automatically add it to this profile.

The full profile intentionally enables invasive features together: `pi-spark` replaces the editor/footer and folds transcript activity. Prefer single-package npm installs for published capabilities when you do not want the complete composition.

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

The retired interactive-subagent and workflow products are not workspaces, root-profile entries, or release candidates. Their external archive is not a repository dependency. `pi-subagent` is the current panel-based package.

The repository pins `https://registry.npmjs.org/` in `.npmrc` so lockfile tarball URLs stay portable. Installing through a mirror registry rewrites those URLs and makes `npm ci` fail on npm 12+ with `EALLOWREMOTE`; `node scripts/check-lockfile-registry.mjs` (part of `npm run check`) blocks that before merge.

## License

[MIT](./LICENSE)
