# Pi Subagent

可观察、可持久化的 Pi 子代理，用于独立审查、调查和委派实现。

每个子代理在独立终端面板中运行，并拥有自己的 Pi JSONL 会话。父会话可以查看状态、等待持久结果、转向正在进行的工作，或排队后续消息；面板就在当前终端旁边，不需要附着命令。

## 要求

- Pi
- Node.js 22.18 或更高版本
- tmux 或 Orca。请在其中启动 Pi；可用 `PI_TERMINAL_MUX` 或 `PI_SUBAGENT_MUX` 覆盖检测结果。两者都不在时，spawn 会降级为 headless 后台子进程，没有可见面板，结果通过 `subagent status` 和 `subagent wait` 读取。

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

一次性委派可以自动收尾，不必记得手动 stop：

```sh
subagent spawn --auto-stop --name audit --prompt "审计依赖边"
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

用 `subagent status` 查看活跃运行及其当前状态。每次运行都会打印 panel ID，面板本身已经开在父会话旁边；headless 运行打印 `headless:` 开头 ID，没有面板可看。

## 隔离

可选 spawn 参数：

- `--tools <names>`：逗号分隔的工具白名单
- `--no-extensions`：关闭扩展发现，保留控制桥
- `--no-skills`：关闭 skills
- `--no-prompt-templates`：关闭 prompt templates
- `--no-context-files`：忽略仓库指令文件

不允许嵌套子代理。子会话不加载 subagent skill。子代理在 `/reload` 后继续存在。父会话退出或被替换时，正在运行的子代理会被挂起：面板关闭，但记录和元数据保留；恢复该父会话时会用完整历史重新打开。`subagent stop` 会永久删除运行；无法确认面板关闭时保留记录。`--auto-stop` 在发起或最后一次使用该 run 的回合结束时执行同样的 stop，前提是子代理已 idle 且没有排队消息；仍在运行、失败或已自行退出的 run 会保留记录以便查看。
