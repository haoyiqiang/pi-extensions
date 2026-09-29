---
name: configure-pi-blackhole
description: "配置与排查 pi-blackhole 的确定性压缩、观察记忆、后台模型回退和 recall。Use when configuring or diagnosing Blackhole context management."
---

# 配置 pi-blackhole

`pi-blackhole` 用确定性结构摘要接管可配置的 Pi compaction，并提供 Observer、Reflector、Dropper 观察记忆流水线和 `recall` 历史检索。

## 基本规则

1. 不要同时启用独立的 `pi-vcc` 或 `pi-observational-memory`。它们与 Blackhole 的 hook 和工具冲突。
2. 不要同时启用另一个自动上下文所有者。若必须共存，把 Blackhole 的 `compaction` 或 `compactionEngine` 调整为不会争用的模式。
3. 配置文件位于 `<Pi agent 目录>/pi-blackhole/pi-blackhole-config.json`。全局、项目、环境变量和会话配置按包内 `docs/CONFIG.md` 的优先级合并。
4. 用 `/blackhole settings` 修改配置。手动编辑后执行 `/reload`。

## 模式选择

- `auto`：后台记忆继续运行，达到阈值时自动压缩。
- `manual`：后台记忆写入待处理缓冲；用户运行 `/blackhole` 时刷新并压缩。
- `off`：Pi 负责自动压缩；显式 `/blackhole` 仍可用。
- `compactionEngine: "blackhole"`：Pi 发起的压缩使用确定性摘要。
- `compactionEngine: "pi-default"`：Pi 使用原生摘要器。

Observer、Reflector 和 Dropper 会产生独立的计费模型调用。优先为它们配置便宜模型和回退链。需要避免意外使用当前会话模型时，关闭相应的 session fallback。

## Recall

Agent 使用 `recall` 搜索原始 session 记录。`#N` 展开条目，`#N:path` 查看工具文件内容，`#N:text` 查看消息正文，`mode:file` 只搜索文件内容，`mode:touched` 汇总修改文件，`scope:all` 跨 lineage 搜索。12 位十六进制 ID 用于恢复观察或反思的来源证据。

## 验证

1. 运行 `/blackhole-memory status`，确认模式、游标和 worker 状态。
2. 运行 `/blackhole`，确认出现结构摘要且最近对话按配置保留。
3. 用 `/blackhole-recall <query>` 或 `recall` 验证原始历史仍可检索。
4. 检查后台 worker 使用的是预期模型，并确认失败会进入配置的回退链。

更完整的字段和行为矩阵见 `docs/CONFIG.md`、`docs/vcc-compaction.md`、`docs/observational-memory.md` 和 `docs/recall.md`。真实模型 worker 会产生费用；未获授权时不要运行，并明确报告 `NOT_RUN`。
