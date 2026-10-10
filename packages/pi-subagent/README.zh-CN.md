# pi-subagent

可观察、可持久化的 Pi 子代理，用于独立审查、调查和委派实现。

每个子代理通过 [`pi-terminal-mux`](../pi-terminal-mux) 在独立终端分栏中运行，并拥有自己的 Pi JSONL 会话。父会话可以查看状态、等待结果、转向正在进行的工作，或排队后续消息。分栏就在当前终端旁边，没有 `/subagent` 附着命令。

## 要求

- Pi
- Node.js 22 或更高版本
- 受支持的终端复用器（muxy、cmux、tmux、zellij、wezterm、herdr、otty 或 orca）。请在其中启动 Pi。可用 `PI_TERMINAL_MUX` 或 `PI_SUBAGENT_MUX` 指定后端。

## 安装

```bash
pi install npm:pi-subagent
# 或只在这一次启动时加载：
pi -e npm:pi-subagent
```

不需要手动软链接。父会话启动时，包括 `pi -e`，扩展会把自己的 `subagent.ts` 链接到 Pi 的 bin 目录（`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin`）。Pi 会把这个目录加到 bash 工具的 `PATH` 最前面。如果那里已经有一个不是软链接的 `subagent` 命令，则保持不动。

没有使用 npm `postinstall`。`pi -e <路径>` 不会运行包脚本，`pi -e npm:...` 则装到临时目录。在会话启动时链接可以同时覆盖这两种启动方式。

链进去的就是 TypeScript，这是有意的。shell 查找的是名字 `subagent`，不看 `.ts` 后缀。`subagent.ts` 开头是 `#!/usr/bin/env node`，内核会交给 Node 运行。Node 22.18 及以上会去掉类型并加载真实文件；`./shared.ts` 这类导入解析到该文件旁边，而不是 `bin` 目录里。

## 用法

用父会话的 provider、模型和思考级别启动，并给一个描述性名称：

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

名称显示在父会话界面。后续管理命令使用生成的 handle。spawn 会打印分栏 id。

需要时可以覆盖模型：

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

可以重复传入提示和文件：

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

只读调查可以限制工具：

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

用 handle 管理一次运行：

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

子代理以交互式子代理的圆角框列在输入框上方：左边是已运行时间，右边直接显示子代理自己的状态（`starting`、`busy`、`idle` 或 `error`）。`idle` 表示本轮已完成，子会话仍可接收后续消息。已退出的子代理不显示，没有剩余子代理时框会隐藏。

## 隔离

可选 spawn 参数：

- `--tools <names>`：逗号分隔的工具白名单
- `--no-extensions`：关闭扩展发现，仍加载控制桥
- `--no-skills`：关闭 skills
- `--no-prompt-templates`：关闭 prompt templates
- `--no-context-files`：忽略仓库指令文件

运行记录放在 `<agent-dir>/extensions/pi-subagent/runs`。`<agent-dir>/subagents` 里的旧记录仍然可以读取。不允许嵌套子代理。子会话不加载 subagent skill。子代理在 `/reload` 后继续存在。父会话退出或被替换时，正在运行的子代理会被挂起：分栏关闭，但记录和元数据保留。恢复该父会话时会用完整历史重新打开分栏。只有 `subagent stop` 会永久删除一次运行。
