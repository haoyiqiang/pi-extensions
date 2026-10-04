# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

面向 [Pi 编码助手](https://github.com/earendil-works/pi) 的一组可组合扩展。

> English documentation: [README.md](./README.md)

## 包清单

每个包都可以独立安装；具体行为、配置、示例和测试请查看对应包内的 README。

| 包 | 说明 | 文档 |
| --- | --- | --- |
| [`pi-naming`](./packages/pi-naming) | 统一自动和手动命名会话及允许修改的终端目标。 | [English](./packages/pi-naming/README.md) · [中文](./packages/pi-naming/README.zh-CN.md) |
| [`pi-blackhole`](./packages/pi-blackhole) | 提供确定性压缩、会话观察记忆和原始历史 Recall。 | [English](./packages/pi-blackhole/README.md) · [中文](./packages/pi-blackhole/README.zh-CN.md) |
| [`pi-context-view`](./packages/pi-context-view) | 可视化上下文用量，并检查系统提示、工具、技能和扩展注入。 | [English](./packages/pi-context-view/README.md) · [中文](./packages/pi-context-view/README.zh-CN.md) |
| [`pi-rewind`](./packages/pi-rewind) | 创建 Git 检查点，并恢复文件、会话状态或两者。 | [English](./packages/pi-rewind/README.md) · [中文](./packages/pi-rewind/README.zh-CN.md) |
| [`pi-spark`](./packages/pi-spark) | 统一管理紧凑 editor/footer、清爽对话折叠、provider 余额、模型预设、空闲回顾、指标和 `#` 资源选择器。 | [English](./packages/pi-spark/README.md) · [中文](./packages/pi-spark/README.zh-CN.md) |
| [`pi-distill`](./packages/pi-distill) | 在所有已启用 object-schema 工具的超长输出占满上下文前进行提炼。 | [English](./packages/pi-distill/README.md) · [中文](./packages/pi-distill/README.zh-CN.md) |
| [`pi-models-discovery`](./packages/pi-models-discovery) | 自动发现 models.json 中标记 `discoverModels` 的 provider 的模型列表，启动走持久化缓存，并提供手动刷新命令。 | [English](./packages/pi-models-discovery/README.md) · [中文](./packages/pi-models-discovery/README.zh-CN.md) |
| [`pi-extensions-i18n`](./packages/pi-extensions-i18n) | 提供共享的语言选择、catalog 加载、插值和 `/config:language` 命令。 | [English](./packages/pi-extensions-i18n/README.md) · [中文](./packages/pi-extensions-i18n/README.zh-CN.md) |
| [`@maplezzk/pi-web-search`](./packages/pi-web-search) | 整合 LLM 内置网络搜索、独立 Search API、Gemini/Vertex URL Context、有界网页抓取和可选 GitHub 仓库提取。 | [English](./packages/pi-web-search/README.md) · [中文](./packages/pi-web-search/README.zh-CN.md) |
| [`@maplezzk/pi-interactive-subagents`](./packages/pi-interactive-subagents) | 终端复用器分屏中的非阻塞交互式子 agent，带实时状态 widget、`/plan` 与 `/iterate` 工作流。Fork 自 HazAT/pi-interactive-subagents。 | [English](./packages/pi-interactive-subagents/README.md) · [中文](./packages/pi-interactive-subagents/README.zh-CN.md) |

共享库会发布到 npm 供功能包依赖，但不会被当作扩展加载：[`pi-extensions-config`](./packages/pi-extensions-config) 提供可移植的 JSON 配置读写，[`pi-terminal-mux`](./packages/pi-terminal-mux) 提供终端 surface 操作。

> `pi-session-tools` 已退役并从本仓库移除。对于历史会话中的 `session-squash` 条目，明确提供兼容逻辑的包仍可读取。

插件管理类斜杠命令统一采用 `/config:<功能>[-动作]` 命名。改名前的命令会继续作为兼容别名保留；`/plan`、`/iterate`、`/subagent` 是刻意保留的高频工作流快捷命令。

## 一键安装全部扩展

要求：具备兼容扩展 API 的 Pi，以及 Node.js 22 或更高版本。

```bash
pi install git:github.com/maplezzk/pi-extensions
```

仓库根目录本身也是一个显式维护的全量 Pi profile。manifest 逐项列出扩展入口，并包含 `pi-spark` 主题；`pi-terminal-mux` 等纯库包不会被当成扩展加载。新增 workspace 包不会自动进入这个 profile。

全量 profile 会有意同时启用若干侵入性能力：`pi-spark` 替换 editor/footer 并折叠运行过程，`pi-blackhole` 接管自动压缩，`pi-distill` 改写工具结果，`pi-rewind` 管理 Git 检查点，交互式子 agent 会创建终端 surface。如果不需要完整组合，优先按 npm 包名单独安装。

安装后重新加载 Pi：

```text
/reload
```

如果只想安装单个包，可以使用对应的 npm 包名：

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

[`packages/pi-subagents`](./packages/pi-subagents/README.zh-CN.md) 是从 `tintinweb/pi-subagents` 导入的私有迁移基线，参与开发检查，但不发布、也不加入根 Pi profile；现有 interactive-subagents 包仍保持启用。

仓库根 `.npmrc` 固定 `https://registry.npmjs.org/`，保证 lockfile 里的 tarball 地址可移植。用镜像 registry 安装会把地址改写成镜像域名，导致 npm 12+ 的 `npm ci` 报 `EALLOWREMOTE`；`node scripts/check-lockfile-registry.mjs`（已纳入 `npm run check`）在合并前拦下这类改动。

## 许可证

[MIT](./LICENSE)
