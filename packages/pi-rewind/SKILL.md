---
name: configure-pi-rewind
description: "启用与排查 pi-rewind 的 Git 检查点、文件回退和会话回退。Use when configuring or diagnosing Pi rewind checkpoints."
---

# 配置 pi-rewind

`pi-rewind` 只在 Git 工作区中运行。它在会话开始时创建恢复检查点，并在包含 `write`、`edit` 或 `bash` 变更的模型回合结束后创建一个检查点。

## 使用

1. 确认当前目录位于 Git 仓库中。
2. 运行 `/rewind`，选择检查点并查看 diff。
3. 选择恢复文件和会话、仅恢复文件，或仅恢复会话。
4. 也可以按 `Ctrl+Shift+R` 进入快速的仅文件回退流程。

## 安全说明

- 检查点保存在 `refs/pi-checkpoints/`，不会创建普通提交。
- 跨分支恢复会被阻止。
- 被 Git 忽略的文件、依赖目录、超过限制的大文件或大目录不会进入快照。
- 默认每个会话最多保留 50 个检查点；启动时会清理旧会话的检查点。

## 诊断与验证

若状态栏不显示检查点数量，先确认当前目录是 Git 仓库，并确认扩展已加载。完成一次由 `write` 或 `edit` 产生实际文件差异的回合，然后运行 `/rewind`。确认列表包含会话开始检查点和变更回合检查点，预览正确，并且取消操作不修改文件。真实 Agent 回合属于 E2E；未运行时明确报告 `NOT_RUN`。
