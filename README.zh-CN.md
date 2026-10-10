# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

面向 [Pi 编码助手](https://github.com/earendil-works/pi) 的一组可组合扩展。

> English documentation: [README.md](./README.md)

## 包清单

已发布的包可以通过 npm 独立安装。具体行为、配置、示例和测试请查看各包 README。

| 包 | 说明 | 文档 |
| --- | --- | --- |
| [`pi-spark`](./packages/pi-spark) | 统一管理紧凑 editor/footer、清爽对话折叠、provider 余额、模型预设、空闲回顾、指标、会话/终端命名和 `#` 资源选择器。 | [English](./packages/pi-spark/README.md) · [中文](./packages/pi-spark/README.zh-CN.md) |
| [`pi-distill`](./packages/pi-distill) | 已启用工具结果先归档再摘要，可选本地核验的诊断证据提取。 | [English](./packages/pi-distill/README.md) · [中文](./packages/pi-distill/README.zh-CN.md) |
| [`pi-action-fusion`](./packages/pi-action-fusion) | 将单文件编辑／写入与后续命令合并为一次工具调用，改编自 SoL-Pi，默认关闭。新包待首次 npm 发布，现可通过 Git／本地套件使用。 | [English](./packages/pi-action-fusion/README.md) · [中文](./packages/pi-action-fusion/README.zh-CN.md) |
| [`pi-models-discovery`](./packages/pi-models-discovery) | 自动发现 models.json 中标记 `discoverModels` 的 provider 的模型列表，启动走持久化缓存，并提供手动刷新命令。 | [English](./packages/pi-models-discovery/README.md) · [中文](./packages/pi-models-discovery/README.zh-CN.md) |
| [`pi-utils`](./packages/pi-utils) | 工具库：可移植的 JSON 配置读写，以及确定性的测试 fixture。不是 Pi 扩展。 | [English](./packages/pi-utils/README.md) · [中文](./packages/pi-utils/README.zh-CN.md) |
| [`@maplezzk/pi-web-search`](./packages/pi-web-search) | 整合 LLM 内置网络搜索、独立 Search API、Gemini/Vertex URL Context、有界网页抓取和可选 GitHub 仓库提取。 | [English](./packages/pi-web-search/README.md) · [中文](./packages/pi-web-search/README.zh-CN.md) |
| [`pi-subagent`](./packages/pi-subagent) | 通过 `pi-terminal-mux` 在终端分栏中运行持久子代理，不提供 `/subagent` 命令。 | [English](./packages/pi-subagent/README.md) · [中文](./packages/pi-subagent/README.zh-CN.md) |

共享库会发布到 npm 供功能包依赖。[`pi-utils`](./packages/pi-utils) 是工具库，不是 Pi 扩展，负责可移植的 JSON 配置读写和确定性测试 fixture。[`pi-terminal-mux`](./packages/pi-terminal-mux) 提供终端 surface 操作。

> `pi-naming` 已合并到 `pi-spark`。重新加载前请移除旧的独立扩展；只有 `spark.json` 没有 `naming` 时才兼容读取旧配置。详见 [迁移说明](./packages/pi-spark/README.zh-CN.md#从-pi-naming-迁移)。

> `pi-session-tools` 已退役并从本仓库移除。对于历史会话中的 `session-squash` 条目，明确提供兼容逻辑的包仍可读取。

> `pi-interactive-subagents`、`pi-subagents` 与 `pi-workflow` 已退役并从本仓库移除。重新加载前，请先停止旧任务，并移除单独安装的旧入口；不保留旧子代理工具、`/plan`／`/iterate`／`/subagent` 别名及 `/wf` 命令。[`pi-subagent`](./packages/pi-subagent) 是独立的分栏子代理，不会恢复这些命令。

插件管理类斜杠命令统一采用 `/config:<功能>[-动作]` 命名。

## 一键安装全部扩展

要求：Pi 0.87.1 或经过验证的兼容扩展运行时，以及 Node.js 22 或更高版本。

```bash
pi install git:github.com/maplezzk/pi-extensions
```

仓库根目录本身也是一个显式维护的全量 Pi profile。manifest 逐项列出扩展入口，并包含 `pi-spark` 主题；`pi-terminal-mux` 等纯库包不会被当成扩展加载。新增 workspace 包不会自动进入这个 profile。

全量 profile 会有意同时启用若干侵入性能力：`pi-spark` 替换 editor/footer 并折叠运行过程，`pi-distill` 改写工具结果。如果不需要完整组合，已发布的能力包可以通过 npm 单独安装。
profile 也加载 `pi-action-fusion`，但功能保持关闭，需明确运行 `/config:action-fusion enable` 并 `/reload` 才启用。它不替换 `pi-distill`，也不接管自动压缩。

安装后重新加载 Pi：

```text
/reload
```

如果只想独立安装某个已发布的包，可以使用对应的 npm 包名：

```bash
pi install npm:<package-name>
```

## 配置

多数可配置扩展会在 Pi agent 目录下保存状态；具体路径、命令、环境变量优先级和验证方式以各包为准。配置示例和详细文档请查看 [`packages/`](./packages)。

## 开发

```bash
npm install
npm run check
```

`check` 会执行 workspace 类型检查、测试，以及可移植性和 i18n 门禁。

已退役的交互式 subagent 与 workflow 产品不再是 workspace、根 profile 入口或发布候选；其外部归档不是本仓库依赖。当前的分栏子代理是 `pi-subagent`。

仓库根 `.npmrc` 固定 `https://registry.npmjs.org/`，保证 lockfile 里的 tarball 地址可移植。用镜像 registry 安装会把地址改写成镜像域名，导致 npm 12+ 的 `npm ci` 报 `EALLOWREMOTE`；`node scripts/check-lockfile-registry.mjs`（已纳入 `npm run check`）在合并前拦下这类改动。

## 许可证

[MIT](./LICENSE)
