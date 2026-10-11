# pi-subagent

可观察、可持久化的 Pi 子代理，用于独立审查、调查和委派实现。

每个子代理通过 [`pi-terminal-mux`](../pi-terminal-mux) 在独立终端分栏中运行，并拥有自己的 Pi JSONL 会话。父会话可以查看状态、等待结果、转向正在进行的工作，或排队后续消息。分栏就在当前终端旁边，没有 `/subagent` 附着命令。

## 要求

- Pi
- Node.js 22.18 或更高版本，用于原生执行 TypeScript
- tmux 或 Orca。请在其中启动 Pi。可用 `PI_TERMINAL_MUX` 或 `PI_SUBAGENT_MUX` 指定后端。

## 安装

```bash
pi install npm:pi-subagent
# 或只在这一次启动时加载：
pi -e npm:pi-subagent
```

扩展向父会话提供 [subagent 技能](skills/subagent/SKILL.md)。CLI 仍位于包根目录的 `subagent.ts`，并提供 npm bin 入口。父会话启动时，包括 `pi -e`，扩展会将它链接到 Pi 的 bin 目录（`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin`）。Pi 会把这个目录加到 bash 工具的 `PATH` 最前面。如果那里已经有一个不是软链接的 `subagent` 命令，则保持不动。

不增加手动链接、npm `postinstall` 钩子、运行时 loader 或 JavaScript 构建。CLI 通过 `#!/usr/bin/env node` 直接执行。Node 原生 TypeScript 类型剥离不支持 `node_modules` 内的文件，软链接不能绕过此限制；直接运行需要位于 `node_modules` 外的源码目录，npm 安装后的 CLI 限制仍未解决。包的 `build` 脚本仅执行类型检查，不生成文件。

在任务目录中调用命令。用 `--role` 按名称选择内置角色，角色路径从包目录解析。扩展负责子代理消息、状态、挂起和恢复。

## 用法

按需查看命令及其参数、默认值和示例：

```sh
subagent --help
subagent roles --help
subagent spawn --help
subagent send --help
subagent wait --help
```

所有操作子命令都支持 `<command> --help` 或 `<command> -h`，也可使用 `subagent help [command]`。帮助输出到 stdout，以状态码 0 退出，不读取运行记录、不创建面板，也不要求模型配置或终端复用器。无效命令或参数仍以非零状态退出。详细参数以 CLI 帮助为准，skill 专注于委派流程。

用父会话的 provider、模型和思考级别启动，并给一个描述性名称：

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

名称显示在分栏标题和 CLI 输出中。后续管理命令使用生成的 handle。spawn 会打印分栏 id。

首次启动和恢复运行都通过 `pi-terminal-mux` 的 `createSurface(name, { command })` 在创建面板时提交 Pi 命令。不再生成 `launch.sh`，不再固定等待 shell 就绪，也不再单独向终端注入启动输入。tmux 通过 `split-window` 启动命令；Orca 接收 `--command`，自行管理 shell 启动和命令提交。返回面板 id 只证明创建/提交成功，不保证 Pi 已就绪；子代理状态由控制桥记录。

需要时可以覆盖模型：

```sh
subagent spawn \
  --model openai-codex/gpt-5.4-mini \
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

用户可以在子面板按 Esc 打断，再直接输入校正指令继续。当最新 assistant 回复的 `stopReason` 为 `aborted` 时，`wait` 保持等待，在子代理空闲后返回下一份正常回复。执行错误、子代理退出和超时仍返回失败；`wait` 不会关闭面板。默认 1800 秒的期限包含等待用户输入的时间。Pi 以错误报告的重试取消仍按错误处理。

## 角色

父模型已能看到角色目录。需要时通过 CLI 检查预设，再启动角色，无需重复传入预设参数：

```sh
subagent roles
subagent spawn \
  --role explore \
  --name authentication-lookup \
  --prompt "Find authentication entry points and references. Search breadth: medium. Return absolute paths and line references; do not modify files or run builds/tests."
```

角色是 `skills/subagent/references/` 中的 Markdown 文件：必须包含 `name` 和 `description`，可选启动预设，正文是系统指令：

```yaml
name: explore
description: Locate files, symbols, and references through read-only search.
tools: [read, bash, grep, find, ls]
extensions: true
```

扩展只将角色名称和描述公布到**父代理**系统提示，并要求模型委派前读取并遵循 subagent 技能。子代理不会收到这个目录，也不会通过本扩展加载 subagent 技能。父代理目录不包含完整正文或配置值。`spawn --role <name>` 自动应用预设，剥离 frontmatter 后追加正文。`--role` 可选：普通子代理只使用 CLI 参数和父会话／Pi 默认配置。`--name` 是独立的显示标签。

优先级统一为 **显式 CLI > Markdown 预设 > 父会话／Pi 默认配置**，不报告配置冲突。`--model provider/model` 和 `--thinking` 覆盖角色值；`--tools` 或 `--no-tools` 整体替换角色工具列表。任意 `-e/-ne` 整体替换角色扩展预设：`-e A` 保留普通发现并加载 A，`-ne -e A` 只加载 A 和必须保留的控制桥，不隐式合并角色扩展列表。

`tools` 支持字符串数组，`[]` 禁用全部工具。`extensions` 支持 `true`（正常发现）、`false/[]`（关闭普通发现）或数组（仅加载指定路径／包来源）。角色扩展相对路径从角色文件目录解析；包来源保持原样。未声明字段使用默认配置，未知 frontmatter 字段忽略。仅扫描包内角色目录。

`subagent roles` 保留为检查命令，以 Markdown 展示 **Name、Description、Model、Thinking、Tools、Extensions** 六列。未声明值显示长破折号，列表使用 JSON 且保留路径空白。该命令不安装扩展、不启动实例。[SKILL.md](skills/subagent/SKILL.md) 负责流程，CLI 帮助负责参数。

三个内置角色借鉴 [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)，参考版本为 `e955e29c51b7a6cce37e1108cd2d6c57a77e151c`，统一使用小写名称：

| 角色 | 适用任务 | 工具预设 |
|---|---|---|
| [general-purpose](skills/subagent/references/general-purpose.md) | 实现、研究、代码审查及其他多步骤任务 | CLI／Pi 默认配置 |
| [explore](skills/subagent/references/explore.md) | 定位文件、符号和引用；指定 quick、medium 或 very thorough 搜索范围 | `read,bash,grep,find,ls` |
| [plan](skills/subagent/references/plan.md) | 只读分析并返回包含具体步骤、取舍和关键文件的实现计划 | `read,bash,grep,find,ls` |

三个角色都继承模型和 thinking，不复制上游模型固定值。Explore 和 Plan 指令根据参考项目适配，并保留其 [MIT 许可证](skills/subagent/references/LICENSE)。general-purpose 使用简短的任务驱动指令，不特别限制工具；省略 `--role` 仍可启动普通子代理。所有指令保持追加模式，不使用上游替换模式。不强制要求 TODO 工具、报告文件、提交或多阶段审批流程。

代码审查、设计文档审计、跨文件一致性检查及开放式分析使用 `general-purpose` 或普通子代理，不交给定位型 `explore`。编辑、检查和提交遵循本次任务授权。角色不授予操作权限、不将 Bash 变成沙箱，也不自动停止实例。

自定义指令继续使用可重复的 `--append-system-prompt <text|path>`。已有文件按原文读取，包括可能存在的 frontmatter；其他值按字面文本处理。确认自定义文件路径存在；相对路径从调用 shell 的目录解析，不受 `--cwd` 影响。选中角色正文在前，额外指令按参数顺序追加。合并内容保存为 run 目录中的 `append-system-prompt.md`，追加到 Pi 正常系统提示，保留 `APPEND_SYSTEM.md`。后续消息、`/reload` 和恢复运行沿用快照。普通 Pi 配置和上下文文件仍正常发现。

`--prompt` 是任务用户消息，`--file` 是任务附件。角色本身不是任务，仍需至少一个上述输入。子代理从新对话开始，不 fork 父会话历史，也不提供系统提示替换模式。

## 隔离

可选 spawn 参数：

- `--tools <names>`：逗号分隔的工具白名单，覆盖角色工具配置
- `--no-tools`：禁用全部工具，与 `--tools` 互斥
- `-e / --extension <path|source>`：显式加载扩展文件、目录或包来源，可重复
- `-ne / --no-extensions`：关闭普通扩展发现，显式扩展和控制桥仍加载
- `--no-skills`：关闭 skills
- `--no-prompt-templates`：关闭 prompt templates
- `--no-context-files`：忽略仓库指令文件

用 `-ne -e ./extensions/todo.ts` 只选择显式扩展，不进行普通扩展发现。CLI 中的本地扩展路径从调用 shell 的目录解析，不受 `--cwd` 影响；包来源原样交给 Pi。解析后的工具和扩展配置保存用于恢复，控制桥始终保留。启动器固定调用 Pi，不再自动选择工作目录中的 `pi-test.sh`。关闭扩展发现时，应显式保留注册自定义模型 provider 所需的扩展。

运行记录放在 `<agent-dir>/extensions/pi-subagent/runs`。`<agent-dir>/subagents` 里的旧记录仍然可以读取。不允许嵌套子代理。子会话不加载 subagent skill。子代理在 `/reload` 后继续存在。父会话退出或被替换时，正在运行的子代理会被挂起：分栏关闭，但记录和元数据保留。恢复该父会话时会用完整历史重新打开分栏。inbox 消息保留到带标识的用户消息写入持久会话后才删除，异步接收失败不会丢失消息。未接收的消息会报告错误，修正原因后可通过子会话 reload／恢复重试。metadata 更新使用跨进程锁；`wait` 不返回 send 之前的旧回复。只有确认面板已关闭后，`stop` 才永久删除运行；关闭失败或无法确认时保留记录。
