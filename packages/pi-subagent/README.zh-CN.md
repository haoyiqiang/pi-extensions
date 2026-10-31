# Pi Subagent

可观察、可持久化的 Pi 子代理，用于独立审查、调查和委派实现。

每个子代理在独立的 detached tmux session 中运行，并拥有自己的 Pi JSONL 会话。父会话可以查看状态、等待持久结果、转向正在进行的工作，或排队后续消息；扩展会在编辑器上方显示正在运行的子代理，`/subagent` 可以附着到其中一个。

## 要求

- Pi
- Node.js 22.18 或更高版本
- tmux

## 安装

```sh
pi install npm:@kevinhao/pi-subagent
```

在已有 Pi 会话中运行 `/reload`。扩展会自动提供随包附带的 skill。CLI 仍需以 `subagent` 出现在 bash 工具的 `PATH` 中。

## 用法

用父会话的 provider、模型和思考级别启动，并给一个描述性名称：

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

名称显示在父会话 UI 中。生成的 handle 是管理命令使用的稳定标识。

需要时可以覆盖模型配置：

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

spawn 打印 `spawned <handle> <name>`；后续所有命令都用 handle 标识运行。结果走 stdout，提示走 stderr，因此输出可管道化：`subagent wait <handle> > report.md` 只会写入响应内容。运行处于 idle 时，stderr 会追加一行给 agent 的指令，例如 ``Use `subagent stop a1b2c3` to stop this subagent when it is no longer needed.``。

`spawn`、`status`、`list` 支持 `--json`，输出机器可读字段。

用 handle 管理一次运行：

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent stop a1b2c3
subagent resume a1b2c3
subagent rm a1b2c3
subagent list
```

用 `subagent list` 查看本会话所有运行及其 handle、名称、状态、运行时长、工作目录和模型；`subagent status` 以 `key: value` 形式打印单个运行的同样信息。

每次运行拥有名为 `pi-subagent-<handle>` 的 tmux session。运行期间扩展会在编辑器上方画一个 `Subagents` 状态框；`/subagent` 可以选中并附着进去。session 名始终由 handle 推导，因此 `tmux attach -t pi-subagent-a1b2c3` 同样可用。

## 隔离

可选 spawn 参数：

- `--tools <names>`：逗号分隔的工具白名单
- `--no-extensions`：关闭扩展发现，保留控制桥
- `--extension <path>` / `-e <path>`：额外加载一个扩展（可重复）。配合 `--no-extensions` 时只保留控制桥和点名的扩展
- `--no-skills`：关闭 skills
- `--no-prompt-templates`：关闭 prompt templates
- `--no-context-files`：忽略仓库指令文件

不允许嵌套子代理。子会话不加载 subagent skill。子代理在 `/reload` 后继续存在。父会话退出或被替换时，正在运行的子代理进程会被关闭，但记录和元数据保留；恢复该父会话时会用完整历史重新拉起它们。这个关闭不等于 `subagent stop`：只有显式的 `stop` 或 `rm` 才结束一次运行，因此子代理自行退出或被外部杀掉后同样会被拉起。
