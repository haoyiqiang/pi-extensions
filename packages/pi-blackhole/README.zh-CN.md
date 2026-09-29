# pi-blackhole

面向 [Pi 编码助手](https://github.com/earendil-works/pi) 的确定性上下文压缩、观察记忆和历史检索扩展。

`pi-blackhole` 用规则驱动的结构摘要替代可配置的 Pi LLM 压缩。压缩本身不调用模型。Observer、Reflector 和 Dropper 会在独立的计费模型调用中提取观察、反思和保留决策。原始 session 记录仍保存在 Pi session 文件中，并可通过 `recall` 按需检索。

> 本扩展仍属于实验性功能。确定性摘要是有损的工作上下文投影，不等于压缩算法意义上的无损压缩。原始记录和 Recall 共同提供可恢复性。后台记忆 worker 会产生真实模型费用。

## 安装

```bash
pi install npm:pi-blackhole
```

也可以安装整个扩展仓库：

```bash
pi install git:github.com/maplezzk/pi-extensions
```

不要同时安装独立的 `pi-vcc` 或 `pi-observational-memory`。它们会与 Blackhole 的 hook、命令或工具冲突。安装后执行 `/reload` 或重启 Pi。

## 核心能力

- **确定性压缩**：用 `compile()` 流水线提取任务目标、文件变更、提交、用户偏好、未完成事项和简化对话。
- **观察记忆**：Observer 记录事实，Reflector 提炼长期信息，Dropper 控制保留和丢弃。
- **原始历史 Recall**：直接搜索 session 文件，不受当前压缩摘要限制。
- **模型回退链**：每个 worker 可配置模型、fallback 和冷却状态。
- **手动与自动模式**：可以自动压缩、只在显式命令时压缩，或把自动压缩交还 Pi。
- **项目记忆导出**：汇总跨 session 的观察和反思。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/blackhole` | 立即执行确定性压缩；在手动模式中也会刷新待处理记忆。 |
| `/blackhole settings` | 打开配置界面；`configure` 是兼容别名。 |
| `/blackhole changelog` | 查看包内变更日志。 |
| `/blackhole cleanup` | 清理孤立的待处理文件。 |
| `/blackhole om-on` / `om-off` | 开启或关闭观察记忆。 |
| `/blackhole-memory [status|view|full]` | 查看 worker、计数器和记忆内容。 |
| `/blackhole-recall <query>` | 以用户命令方式搜索历史。 |
| `/blackhole-export` | 导出项目级观察和反思。 |

Agent 同时获得统一的 `recall` 工具。

## Recall 语法

- 自由文本：BM25 排序搜索。
- 正则表达式：模式搜索。
- `#N`：展开指定 session 条目。
- `#N:text`：分页读取消息正文。
- `#N:path`：分页读取工具写入或编辑的文件内容。
- 12 位十六进制 ID：恢复观察或反思的来源证据。
- `mode:file`：只搜索文件内容。
- `mode:touched`：按路径汇总改动文件。
- `scope:all`：搜索全部 lineage；默认只搜索 active lineage。

单次响应受 `recallResponseMaxChars` 限制。截断标记会说明如何继续分页。

## 压缩模式

### `auto`（默认）

后台 worker 正常运行。达到配置阈值后自动压缩。若 `compactionEngine` 是 `blackhole`，Pi 发起的阈值压缩、溢出恢复和 `/compact` 都由确定性管线处理。

### `manual`

后台 worker 继续运行，但观察先写入 session 待处理文件。只有运行 `/blackhole` 时才刷新记忆并压缩。适合希望明确控制检查点的用户。

### `off`

Blackhole 不自动压缩，Pi 处理原生压缩。显式 `/blackhole` 仍可运行。再配合 `memory: false` 或 `PI_BLACKHOLE_PASSIVE=true`，可以关闭后台 worker。

## 配置

默认配置文件：

```text
~/.pi/agent/pi-blackhole/pi-blackhole-config.json
```

配置按全局、项目、环境变量和 session 层合并。推荐先运行：

```text
/blackhole settings
```

多数用户至少应为 Observer、Reflector 和 Dropper 指定便宜模型。每个 worker 的回退顺序是该阶段模型、该阶段 fallbacks、共享模型、可选 session 模型。若要避免意外使用当前会话模型，请关闭 session fallback。

完整字段、默认值、阈值曲线和模式交互见：

- [`docs/CONFIG.md`](./docs/CONFIG.md)
- [`docs/vcc-compaction.md`](./docs/vcc-compaction.md)
- [`docs/observational-memory.md`](./docs/observational-memory.md)
- [`docs/recall.md`](./docs/recall.md)
- [`example-config.json`](./example-config.json)

## 工作原理

压缩时，VCC 管线先标准化消息、过滤噪声、构建结构章节，再把可见的观察和反思附加到摘要中。最近对话按保留边界原样留在工作上下文。被压缩的原始条目不会从 session JSONL 中删除，因此 Recall 仍可读取。

观察记忆与确定性摘要解决不同问题：前者由模型提炼长期事实，后者用规则建立当前任务工作集。观察可能判断错误，规则摘要也可能漏掉语义，因此重要信息应通过 Recall 回查原始证据。

## 开发

从仓库根目录运行：

```bash
npm install
npm run typecheck --workspace pi-blackhole
npm test --workspace pi-blackhole
npm run check --workspace pi-blackhole
```

测试不应要求 API Key 或真实模型。涉及实际 worker 的手动验证会产生费用，运行前需要明确授权。

## 来源

本包融合并扩展了 [`pi-vcc`](https://github.com/sting8k/pi-vcc) 和 [`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory)，原始统一实现来自 [`k0valik/pi-blackhole`](https://github.com/k0valik/pi-blackhole)。现由本仓库统一维护和发布。

## 许可证

MIT
