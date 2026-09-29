---
name: configure-pi-context-view
description: "配置与排查 pi-context-view 的上下文用量图和注入内容视图。Use when configuring or diagnosing Pi context visualization."
---

# 配置 pi-context-view

使用 `/context` 或 `/context usage` 查看上下文用量图。使用 `/context injections` 查看初始系统提示、工具定义、技能和其他扩展的注入内容。

## 配置

1. 执行 `/context config`。此命令只在配置文件不存在时创建 `~/.pi/agent/extensions/pi-context-view.json`。
2. 按需修改 `categoryColors` 和 `mapSize`。字段说明见包内 `doc/CONFIG.md`。
3. 修改配置后执行 `/reload`。

## 诊断

- 两个视图只在 TUI 模式中可用。
- 扩展优先被动捕获首个真实模型回合。若打开视图时还没有捕获，它会执行一次静默探测。
- 如果没有模型、没有鉴权或正在压缩，扩展会使用 Pi 原生信息生成降级视图。
- 扩展不会向模型上下文添加指令或普通消息。静默探测产生的内部消息会被过滤。

## 验证

在 TUI 中完成一个真实模型回合，然后运行 `/context usage` 和 `/context injections`。确认用量图可打开，注入列表可展开，并且 `/context config` 不覆盖已有配置。真实模型回合属于 E2E；未运行时明确报告 `NOT_RUN`。
