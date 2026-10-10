# pi-spark

用于 [Pi](https://pi.dev/) 的日常体验增强扩展。

![Overview](./assets/screenshot-overview.png)

## 安装

```bash
# 从 npm 安装本包
pi install npm:pi-spark

# 或安装整个扩展仓库
pi install git:github.com/maplezzk/pi-extensions
```

安装后执行 `/reload` 或重启 Pi。

## 功能

### 紧凑 TUI：editor 与 footer

`pi-spark` 提供自定义 editor 和 footer，替换 Pi 的默认组件。

- editor 在顶部边框显示 working 指示、从发出消息起的全程耗时和当前模型；使用 presets 时同时显示激活的预设。
- footer 在一行内显示会话信息、扩展状态、花费和上下文用量。`style` 为 `p10k` 时，左侧改成 lean powerlevel10k：系统图标、fish 缩短路径、`on` 和分支。需要 Nerd Font。
- Pi 0.84.0 起原生支持全屏模式，因此 `pi-spark` 已移除自带的替代实现。用 `/settings`、`pi --tui-mode fullscreen` 或 `settings.json` 中的 `"tuiMode": "fullscreen"` 开启。升级时请从 `spark.json` 删除已废弃的 `fullscreen` 字段。

### Credits

在状态栏显示当前 provider 的余额或速率限制用量。

- 支持 DeepSeek、Fireworks、Kimi Code、Moonshot、OpenAI Codex、OpenRouter 和 Vercel AI Gateway。
- 多数 provider 的取数方式参考 [CodexBar](https://github.com/steipete/codexbar)。Fireworks 例外：它的余额位于内部 gRPC 接口之后，实现来自对 `firectl` 二进制的逆向分析，见 [`docs/reverse-engineering-fireworks-credits.md`](./docs/reverse-engineering-fireworks-credits.md)。
- OpenAI Codex 的 banked rate-limit resets 可以通过 `/codex-resets` 查看并兑换，见 [`docs/openai-codex-banked-rate-limit-resets.md`](./docs/openai-codex-banked-rate-limit-resets.md)。
- Pi 目前不支持按时段计价，`pi-spark` 会更新模型成本元数据，让 DeepSeek 等峰谷定价 provider 的后续用量计算反映当前费率。

### Presets

在 `spark.json` 中定义具名模型预设，避免重复输入 provider 与模型信息。

- `/preset` 交互切换，`/preset <name>` 直接切换。
- `pi --preset <name>` 以指定预设启动。
- `ctrl+super+p` 向前、`ctrl+shift+super+p` 向后循环。`super` 在 macOS 上是 `command`，需要终端转发该修饰键。

### 清爽模式

清爽模式把一次 agent 运行折叠成一行耗时头，只保留最终答案。按 `F2` 或运行 `/clean` 可展开中间解说、工具调用和扩展工作条目；`Shift+F2` 展开或收起全部动作组。

- agent 运行时保持展开，`agent_settled` 后自动收起；本轮手动切换过时尊重手动状态。
- 全屏 TUI 可以点击运行头、动作组和单条工具摘要。
- `/clean config` 和 `/config:clean-mode` 打开配置面板；`/config:clean-mode key=on|off` 可直接修改布尔项。
- `cleanMode: false` 关闭所有折叠。只有 `spark.json` 没有 `cleanMode` 时，才读取旧的 `extensions/pi-clean-mode/config.json`。
- 如果还安装了 `npm:pi-clean-mode`，请移除，否则命令和快捷键会冲突。

### 指标

记录会话耗时和 token 生成遥测。editor 边框显示例如 `⏱ 47s` 的总等待时间，跨轮不归零。

- `on-stop`（默认）：运行期间对话区保持安静，agent 停下后出一行汇总，包含耗时、混合 TPS、TTFT、token、stall 和成本。
- `live`：每轮结束出一行；多轮运行停下后再补一条 `⏱ <耗时>`。
- 每一轮仍写入 `tps` session entry。如果还安装了 `npm:@monotykamary/pi-tps`，请移除它，否则两边都会写重复记录。
- 用 `/config:metrics`，或 `/config:metrics enable|disable|live|on-stop|reset` 配置。只有 `spark.json` 没有 `metrics` 字段时，才会读取旧的 `extensions/pi-metrics/config.json`。

### 会话资源

在输入框的词边界键入 `#`，spark 编辑器上方会打开分类型的资源选择器。它收集当前会话里成功工具结果中的文件、网页和 PR/MR。Enter 插入普通引用，例如 `#src/index.ts`，不会重新读取文件，也不会写入隐藏上下文。

- 选择器包在 spark 编辑器外面，两边不再互相替换。
- 用 `/config:session-resources`，或 `/config:session-resources enable|disable`。`show|hide` 和 `/session-resources` 仍是别名。
- `resources: false` 关闭选择器。只有 `spark.json` 没有 `resources` 时，才会读取旧配置里显式的 `"enabled": false`。
- 如果还安装了 `npm:pi-session-resources`，请移除，否则命令会冲突。

### 会话与终端命名

命名功能已从独立的 `pi-naming` 合并到 Spark。

- 新的未命名会话收到第一条真实用户输入时，在后台生成标题；自动命名只尝试一次，不覆盖已有标题，也不处理扩展注入的输入。
- `/rename [名称]` 使用显式名称；省略名称时综合**当前分支全部用户消息**生成。后续明确纠正优先，“继续”等流程性消息不应盖过主要任务。
- `/config:naming` 打开配置菜单，`/config:naming reset` 恢复默认值；`/naming-config` 和 `/pi-naming-config` 保留为别名。
- `naming.targets` 分别控制 Pi 会话、工作区和标签页。关闭两个终端目标后，只命名会话，不加载终端适配器；`naming: false` 同时关闭自动和手动命名。
- 使用当前 Pi 模型及鉴权发起独立后台请求；OpenAI Codex 使用独立 UUIDv7 会话并在结束后清理。生成名称受长度限制，显式名称不截断。
- 手动请求使旧自动请求失效，会话变化使旧结果及错误失效。单个终端目标失败或不受支持，不影响其他目标。

`pi-terminal-mux` 继续作为独立库自动安装，负责终端操作；Spark 负责生成标题和命名策略。子会话使用 `PI_TERMINAL_RENAME_CONTEXT` 中的目标归属授权；共享或身份不明的目标会跳过，不使用当前焦点代替。受限子会话不能改共享工作区名称。Spark 要求 mux 导出 `resolveTerminalRenameTargets` 和 `renameTerminalTarget`；发布 CI 先发布 terminal-mux，再发布 Spark，并检查 npm 上的依赖范围已可用。

#### 从 pi-naming 迁移

移除旧扩展，避免命令和自动请求重复：

```bash
pi remove npm:pi-naming
```

同时移除扩展列表里显式配置的旧入口，再执行 `/reload`。如果此前安装在项目范围，也需要移除对应的项目包声明。本仓库不再加载或发布独立 naming 包，不会改变已经发布的 npm 版本。

只有全局和项目 `spark.json` **都没有** `naming` 字段时，才只读兼容 `<agent-dir>/extensions/pi-naming/config.json`。新字段即使为 `{}` 或 `false`，也会完全替代旧配置。配置菜单只写 `spark.json` 并保留其他功能：项目文件显式配置了 `naming` 时写项目，否则写全局。命名配置无效或配置文件不可读时禁用命名，不回退为自动发起模型请求。

如需在隔离 Pi 子代理中启用命名，应显式把已安装的 Spark 入口加入子会话扩展允许列表。这会一并加载 Spark 的其他功能，不需要的功能请在适用的 `spark.json` 中关闭；仅在父会话安装 Spark 不会绕过子会话隔离。

### Recap

会话空闲后自动生成简短回顾，灵感来自 Claude Code 的 session recap。

- 空闲时间超过 `recap.idle` 后自动生成。
- `/recap` 可随时手动生成。
- 回顾可以使用独立配置的模型，不必使用当前工作模型。

## 配置

配置读取顺序：`<agent-dir>/extensions/pi-spark/config.json`（全局）与当前项目的 `.pi/extensions/pi-spark/config.json`（项目覆盖同名字段）。新文件不存在时，才只读旧的 `spark.json`。agent 目录遵守 `PI_CODING_AGENT_DIR`。命名默认值示例见 [config.example.json](./config.example.json)。

```json
{
  "editor": { "spinner": "dots" },
  "footer": false,
  "presets": {
    "claude-opus": { "provider": "anthropic", "model": "claude-opus-4-8", "thinkingLevel": "high" }
  },
  "recap": { "idle": "5m", "provider": "openai-codex", "model": "gpt-5.4-mini", "thinkingLevel": "off" }
}
```

顶层字段全部可选，把功能设为 `false` 即可关闭：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `cleanMode` | `CleanModeConfig` | 把一次 agent 运行折叠成耗时头和动作组；设为 `false` 可关闭。 |
| `credits` | `CreditsConfig` | 状态栏的余额或速率限制用量。`providers` 可逐个 provider 开关。 |
| `editor` | `EditorConfig` | 顶部边框的 working 指示与模型名。`spinner` 可选 `dots`、`lights`、`tildes`（默认）、`pulse`。 |
| `footer` | `FooterConfig` | 会话信息、扩展状态、花费与上下文用量。`statusPosition` 可选 `inline`（默认）或 `below`。`style` 可选 `default`（默认）或 `p10k`。 |
| `metrics` | `MetricsConfig` | 耗时和 TPS/TTFT/token/成本遥测。`display` 为 `on-stop`（默认）或 `live`；设为 `false` 可关闭。 |
| `naming` | `NamingConfig` | 会话和授权终端目标的自动标题及 `/rename`；设为 `false` 关闭。 |
| `resources` | `{}` | `#` 会话资源选择器。设为 `false` 可关闭。 |
| `presets` | `{ [name]: Preset }` | 具名预设，每个预设必须给出 `provider`、`model`、`thinkingLevel`。 |
| `recap` | `RecapConfig` | 空闲回顾。`idle` 接受毫秒数或 `parse-duration` 字符串，最小 5000 ms，默认 5 分钟。 |

`CleanModeConfig` 的默认字段：`enabled: true`、`autoExpandWhileRunning: true`、`showRunHeader: true`、`enableActionGroups: true`、`showActivityArea: true`、`activityRows: 4`、`animateActivity: true`、`hideThinking: true`、`hideExtensionEntries: true`。

`thinkingLevel` 的合法值：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。recap 的 `thinkingLevel` 默认 `off`，并会被模型的可用等级收敛。

### NamingConfig

所有字段可省略。`automaticNaming`、`manualNaming` 以及 `targets.session`、`targets.workspace`、`targets.tab` 默认均为 `true`。

| `title` 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `maxLength` | `15` | 生成标题的最大 Unicode 码点数。 |
| `preferredLength` | `10` | 提示模型优先采用的长度，不得超过 `maxLength`。 |
| `language` | `"auto"` | 消息主要语言，也可指定 `"English"` 等；独立于 UI 语言。 |
| `instructions` | `""` | 补充命名风格要求，不是模板或可执行代码。 |
| `timeoutMs` | `10000` | 请求超时毫秒数，正安全整数且不大于 `2147483647`。 |
| `maxTokens` | `2048` | 输出预算，受模型上限约束，思考与标题共享。 |
| `effort` | `"low"` | `minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。 |

长度与 token 预算独立配置，均要求正安全整数。较长英文标题可用 `maxLength: 60`、`preferredLength: 40`、`language: "English"`。未知字段和非法值会报错；修改后执行 `/reload`。

## 主题

随包提供两个受 GitHub VS Code 主题启发的主题：

- [`github-light-default`](./themes/github-light-default.json)
- [`github-dark-default`](./themes/github-dark-default.json)

在 `/settings` 中选择，或配置自动切换：

```json
{
  "theme": "github-light-default/github-dark-default"
}
```

## 开发

从仓库根目录运行：

```bash
npm install
npm run typecheck --workspace pi-spark
npm run check --workspace pi-spark
```

`check` 执行类型检查、包测试和打包预检。

## 来源

本包基于 zlliang 的 [`pi-spark`](https://github.com/zlliang/pi-spark)，现由本仓库统一维护和发布。

## 许可证

MIT
