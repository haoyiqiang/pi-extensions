# @maplezzk/pi-todo

面向 Pi 的分支感知任务清单扩展。它注册模型可调用的 `todo` 工具、`/todos` 命令，以及 TUI 编辑器上方的紧凑型 `rpiv-todos` 组件。

## 功能

- 每次 `todo` 工具结果都保存完整任务快照，因此状态会跟随当前会话分支，并可在 `/reload`、会话树切换和上下文压缩后恢复。
- 内存状态按 session id 隔离，根会话与子会话互不污染。
- `blockedBy` 会拒绝不存在、已删除、自引用和循环依赖。
- 组件展示待处理、进行中和已完成任务；下一轮开始时隐藏上一轮完成项；支持行数预算和折叠。
- 无头、print、JSON、RPC 和嵌套 SDK 会话仍可使用工具和状态回放，但不会接管根 TUI 组件。
- 所有生效的界面、guidance、schema 和模型提示均来自仓库的 `en-US` / `zh-CN` catalog；启动语言解析和语言切换后会刷新工具／schema／命令元数据，不重置任务状态或手工配置的 guidance。

## 安装

```sh
pi install npm:@maplezzk/pi-todo
```

安装后重新加载 Pi。本包也会加载 `pi-utils`，提供 `/config:language` 和 `/languages`。

## 工具

`todo` 支持：

- `create`：创建 `pending` 任务，必须提供 `subject`。
- `update`：修改字段、状态、metadata 或依赖。
- `list`：列出任务，可按状态筛选；默认隐藏 deleted 墓碑。
- `get`：查看单个任务及正向、反向依赖。
- `delete`：将任务标为 deleted，保留历史 id。
- `clear`：清空清单并将下一个 id 重置为 1。

状态为 `pending`、`in_progress`、`completed` 和 `deleted`。详见 [docs/tool-schema.md](docs/tool-schema.md)。

## 界面

- `/todos` 按状态分组输出当前会话的可见任务。
- TUI 组件保留历史 key `rpiv-todos`，兼容已有行为。
- 默认折叠快捷键为 `ctrl+shift+t`；将 `collapseKey` 设为 `"off"` 可禁用。
- 失败操作显示为错误，即使请求目标状态为 completed；失败的修改不会改变任务快照。
- 本扩展不会替换 Pi 的编辑器、页脚或页眉。

## 配置

创建：

```text
~/.pi/agent/extensions/pi-todo/config.json
```

若设置 `PI_CODING_AGENT_DIR`，则以该目录替代 `~/.pi/agent`。

```json
{
  "maxWidgetLines": 12,
  "collapseKey": "ctrl+shift+t",
  "guidance": {
    "promptSnippet": "Manage a task list to track multi-step progress",
    "promptGuidelines": ["Create and update tasks as work progresses."]
  }
}
```

仅当规范路径不存在时，才会只读回退到旧的 XDG `rpiv-todo/config.json`；本包不会写入旧路径。详见 [docs/configuration.md](docs/configuration.md)。

## 开发

```sh
npm test
npm run typecheck
```

测试使用临时 HOME 和 agent 目录，不需要网络、凭据、真实模型或终端复用器。

## 来源与许可证

本包是 MIT 许可 `rpiv-todo` 针对 Pi `0.87.1` 的移植。参见 [UPSTREAM.md](UPSTREAM.md) 和 [LICENSE](LICENSE)。
