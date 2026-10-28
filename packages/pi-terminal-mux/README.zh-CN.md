# @kevinhao/pi-terminal-mux

供 Pi 扩展使用的终端 surface API，仅支持 **tmux**、**Orca** 和 **headless** 后台进程。

[English README](./README.md)

## 安装

```bash
npm install @kevinhao/pi-terminal-mux
```

## 创建时启动命令

```ts
import { createSurface, createSurfaceSplit, readScreen, closeSurface } from "@kevinhao/pi-terminal-mux";

const surface = createSurface("my-agent", {
  command: "pi --session /tmp/child.jsonl",
});

const sibling = createSurfaceSplit("review", "right", surface, {
  command: "pi --session /tmp/review.jsonl",
});

const tail = readScreen(surface, 50);
closeSurface(sibling);
closeSurface(surface);
```

`command` 是可选的、非空的 **shell 命令字符串**，包含启动参数。动态值在 POSIX shell 中使用 `shellEscape()` 转义。这条路径不再另外调用 `sendCommand()`，也没有库内固定的 shell-ready 等待：

- **tmux**：将命令直接传给 `tmux split-window`，在创建 pane 时启动。
- **Orca**：传给 `terminal create` / `terminal split` 的 `--command`。Orca 自己启动 shell 并提交命令，不等同于直接按 argv spawn 程序。
- **Headless**：用 `bash -c` 启动命令，stdout/stderr 写入日志文件。

返回 handle 只证明创建/提交成功，不保证应用已就绪或任务成功。仍需使用应用自身的就绪信号、日志或退出协议。创建错误向上抛出；Orca 输入和读屏错误也会抛出，不再伪报成功。

不传 options 的既有调用保持原来的行为：

```ts
import { createSurface, sendLongCommand } from "@kevinhao/pi-terminal-mux";

const surface = createSurface("my-agent");
const scriptPath = sendLongCommand(surface, "pi --session /tmp/child.jsonl", {
  scriptPreamble: "export MY_FLAG=1",
});
```

`sendLongCommand` 先写脚本，再向终端提交 `bash <script>`，仍供旧调用和长命令使用。已经在创建时传入的启动命令不要再发送一次，否则会重复执行。

## 后端探测

| 后端 | 条件 |
|------|------|
| tmux | 存在 `TMUX` 环境变量及 `tmux` 可执行文件 |
| Orca | `TERM_PROGRAM=Orca`、存在 `orca` 可执行文件，且 runtime 可达 |
| Headless | 上述终端后端均不可用 |

自动探测优先 tmux，其次 Orca。可用 `PI_TERMINAL_MUX=tmux|orca` 强制指定；保留 `PI_SUBAGENT_MUX` 兼容别名。强制指定的后端不可用时不改选另一终端后端；未知或已移除的后端配置明确报错。

## API

| 函数 | 行为 |
|------|------|
| `createSurface(name, options?)` | tmux 与 Orca 一致：从调用方 pane 出发做 BFS 网格分屏；Orca 没有调用方 handle 时新建 tab；无后端时 headless。`options.command` 在创建时启动任务 |
| `createSurfaceSplit(name, direction, fromSurface?, options?)` | 指定方向 left/right/up/down 分屏；可传 `options.command`。要求 tmux 或 Orca，headless 没有布局 |
| `sendCommand(surface, command)` | 向现有终端发送文本并回车 |
| `sendLongCommand(surface, command, options?)` | 先写脚本再执行；支持 `scriptPath`、`scriptPreamble` 和 `interpreter: "bash" | "powershell"` |
| `sendEscape(surface)` | 发送 Escape；headless 使用 SIGINT |
| `readScreen(surface, lines?)` / `readScreenAsync` | 读取终端输出或 headless 日志 |
| `closeSurface(surface)` | 关闭 pane 或 headless 进程 |
| `renameSurface(surface, name)` | 修改后端对应的 window/tab 名称 |
| `getLastSplitSource()` / `clearLastSplitSource()` | 最近一次分屏来源 |
| `pollForExit(surface, signal, options)` | 等待 `.exit` sidecar、sentinel 或 headless 进程退出 |

`CreateSurfaceOptions` 和 `CreateSurfaceSplitOptions` 均提供 `command?: string`。分屏的前三个位置参数保持不变。

探测工具包括 `getMuxBackend`、`isMuxAvailable`、`isHeadlessMode`、`muxSetupHint`、`getAgentPaneId`、`backendAgentPaneEnvVar`；shell 工具包括 `shellEscape`、`isFishShell`、`exitStatusVar`。

统一 API 同样从 `@kevinhao/pi-terminal-mux/mux` 导出；Orca 原生工具从 `@kevinhao/pi-terminal-mux/orca` 导出。

## 改名归属

`createSurfaceRenameContext(surface)` 为子进程启动方生成 `PI_TERMINAL_RENAME_CONTEXT` 协议。每次启动和恢复都替换继承值。

子 pane 不能证明独占 tmux window 或 Orca tab，因此子进程不获得共享 window/tab 或 workspace 改名权限。协议损坏时不退回父会话权限。

普通会话使用 `resolveTerminalRenameTargets({ tab, workspace })` 解析明确身份，再通过 `renameTerminalTarget(reference, title)` 对捕获的目标执行，而不是使用 UI 焦点：

- tmux：`tab` 对应 window，`workspace` 对应 session。
- Orca：`tab` 对应终端 tab，不支持 `workspace`。
- Headless：不支持终端改名。

旧 `renameCurrentTab` / `renameWorkspace` 返回可判别的成功、不支持、禁用或失败结果。tmux 的旧入口分别要求 `PI_SUBAGENT_RENAME_TMUX_WINDOW=1` / `PI_SUBAGENT_RENAME_TMUX_SESSION=1`；明确 ID 的解析不受这两个开关影响。

## 迁移

`MuxBackend` 仅保留 tmux 和 Orca。其他后端实现、原生导出/子路径、WezTerm 的 `activate` 参数、Herdr 的读屏 source 参数已移除。请更新旧后端环境配置和导入路径。这是支持范围/API 的不兼容精简；既有 tmux/Orca 调用不传启动参数时保持兼容。

代码不硬编码本地可执行文件路径；Orca 调用方 handle 在模块加载时捕获，后续焦点变化不会改变分屏来源。Headless 保留 Bash 默认运行时；需要 PowerShell 时显式使用 `sendLongCommand({ interpreter: "powershell" })`。

## License

MIT
