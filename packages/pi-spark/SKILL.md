---
name: configure-pi-spark
description: "配置与排查 pi-spark 的 credits、presets、recap、title、紧凑 TUI 和主题。Use when configuring or diagnosing pi-spark features."
---

# 配置 pi-spark

`pi-spark` 是一个组合扩展。它用一个工厂注册多个功能：自定义 editor、footer、credits 状态、presets、recap、会话标题、流式 `write` 预览，以及两个主题。

## 配置文件

配置来自两个位置，项目配置覆盖同名的全局字段：

- 全局：`<Pi agent 目录>/spark.json`
- 项目：`<项目>/.pi/spark.json`

所有字段都是可选的。把某个功能设为 `false` 即可关闭它。

```json
{
  "footer": false,
  "editor": { "spinner": "dots" },
  "recap": { "idle": "5m", "provider": "openai-codex", "model": "gpt-5.4-mini", "thinkingLevel": "off" }
}
```

顶层字段：`credits`、`editor`、`footer`、`presets`、`recap`、`title`、`write`。字段含义和默认值见包内 `README.md` 的 References 小节。

## 命令与快捷键

- `/preset`、`/preset <name>`：交互选择或直接切换模型预设。
- `pi --preset <name>`：用指定预设启动。
- `/recap`：立即生成会话回顾。
- `/codex-resets`：查看并兑换 OpenAI Codex 的 banked rate-limit resets。
- `ctrl+super+p` / `ctrl+shift+super+p`：向前 / 向后循环预设。
- `ctrl+o`：展开完整的 `write` 预览。

## 诊断

1. 确认 `spark.json` 是合法 JSON（使用 zod 校验，非法字段会回退到默认值）。
2. 若 credits 状态不显示，检查对应 provider 是否被关闭，并确认该 provider 已配置鉴权。
3. 若 recap 或 title 没有生成，检查模型配置是否完整；不完整时会回退到当前会话模型。
4. 主题需要在 `/settings` 中选择，或配置 `"theme": "github-light-default/github-dark-default"` 自动切换。

## 验证

在 TUI 中完成一次真实模型回合：确认 editor 顶部显示模型名与 working 指示、footer 显示会话信息、credits 状态出现、会话在首轮结束后获得标题。运行 `/recap` 与 `/preset` 各验证一次。credits 与 recap 会产生网络或模型调用，需要明确授权；未运行时报告 `NOT_RUN`。
