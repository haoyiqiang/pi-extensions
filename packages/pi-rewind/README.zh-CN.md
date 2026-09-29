# pi-rewind

用于 [Pi 编码助手](https://github.com/earendil-works/pi) 的 Git 检查点和回退扩展。当 Agent 修改错误时，可以恢复文件、会话分支，或同时恢复两者。

## 功能

- `/rewind` 检查点浏览器、diff 预览和恢复确认。
- 按 `Ctrl+Shift+R` 快速进入仅文件回退。
- 每个包含 `write`、`edit` 或 `bash` 变更的模型回合只创建一个检查点。
- 工作树没有实际变化时自动去重。
- 支持仅文件、仅会话、文件和会话三种恢复模式。
- 支持多级撤销回退。
- 阻止跨分支恢复。
- 自动排除 Git 忽略内容、依赖目录、大文件和大型目录。
- 检查点存入 `refs/pi-checkpoints/`，重启后仍可读取。
- 会话开始时创建恢复检查点，并自动清理旧会话和超量检查点。
- 与 `/fork` 和 `/tree` 导航集成。

## 安装

```bash
pi install npm:pi-rewind
```

也可以安装整个扩展仓库：

```bash
pi install git:github.com/maplezzk/pi-extensions
```

安装后执行 `/reload` 或重启 Pi。

## 使用

在 Git 仓库中运行：

```text
/rewind
```

流程如下：

1. 选择检查点。
2. 查看变更 diff。
3. 选择恢复文件和会话、仅恢复文件，或仅恢复会话。
4. 确认恢复。

状态栏会显示当前会话的检查点数量。默认每个会话最多保留 50 个检查点。

## 安全边界

- 扩展只在 Git 仓库中启用。
- 跨分支检查点不会恢复，避免把其他分支状态写入当前分支。
- 恢复不会故意删除 `node_modules`、`.venv` 和其他排除目录。
- 被 `.gitignore` 忽略的文件不会写入快照。
- 单文件超过 10 MiB 或目录文件数超过限制时会被排除。
- 检查点是独立 Git refs，不会污染普通提交历史。

## 性能

上游基准覆盖小型仓库到包含约 18.2 万文件的仓库。创建检查点通常约为 60–142 ms，启动时加载检查点约为 8 ms。实际耗时取决于 Git、磁盘和工作树规模。

## 开发

从仓库根目录运行：

```bash
npm install
npm run typecheck --workspace pi-rewind
npm test --workspace pi-rewind
npm run check --workspace pi-rewind
```

`tests/e2e.sh` 会启动真实 Pi 会话并可能调用模型。只在具备授权和测试环境时运行。

## 来源

本包基于 arpagon 的 [`pi-rewind`](https://github.com/arpagon/pi-rewind)，并延续 `checkpoint-pi` 与 `pi-rewind-hook` 的设计来源。现由本仓库统一维护和发布。

## 许可证

MIT
