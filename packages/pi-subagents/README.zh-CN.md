# @maplezzk/pi-subagents — 统一子代理

> English documentation: [README.md](./README.md)

通过同一套 `Agent`、RPC 和管理界面，配置选择进程内或终端执行。代理定义、调度、队列、
结果和编辑器上方的 AgentWidget 属于 `pi-subagents`，终端操作使用 `pi-terminal-mux`。
独立的 `pi-workflow` 负责工作流定义、编排、日志和 `/wf`。

## 启用与发布

仓库 Git／本地 profile 已默认加载本产品及 `pi-workflow`。npm 包仍为私有、未发布，
发布准备与运行入口启用分开处理。不要与已退役的 `pi-interactive-subagents` 入口或另一份
上游 subagents 扩展同时加载。旧源码已移出仓库归档，不再属于 workspace 或构建／测试
目标；历史源码仍可从 Git 获取，所吸收代码的归属信息继续保留在本包。
导入管理界面的完整 catalog 迁移仍属于 npm 发布准备；新增控制与诊断使用双语 catalog。

重新加载既有环境前，请阅读[迁移指南](./docs/migration.zh-CN.md)。旧活跃任务和 ID
不会自动转交给新管理器。

统一入口**不提供**旧 `subagent`、`subagent_resume`、`subagents_list`、
`subagent_interrupt`、`/plan` 或 `__pi_subagents` 兼容层，也不启用上游另一套
`SubagentWorkflow` 引擎。上游源码与测试保留用于对照，不代表还有第二个正式工作流产品。

可在本仓库启动一个隔离的开发会话：

```sh
pi --no-extensions \
  -e ./packages/pi-extensions-i18n/index.ts \
  -e ./packages/pi-subagents/index.ts \
  -e ./packages/pi-workflow/extension.ts
```

主会话需要其他工具扩展时，请显式加载。该命令不会改写已安装的扩展组合。

## 选择执行后端

规范配置按顺序读取：

- `<agentDir>/subagents.json`；
- `<cwd>/.pi/subagents.json`，**仅在项目获准时**由项目字段覆盖全局字段。

agent 目录支持 `PI_CODING_AGENT_DIR`。已有运行设置见
[`config.example.json`](./config.example.json)。

```json
{ "backend": "embedded" }
```

使用 `"terminal"` 可在独立进程/终端中执行。**不带参数**运行 `/config:subagents`
打开完整管理面板，再选择**设置 → 执行后端（项目）**。只写入已获准项目的
`.pi/subagents.json`，保留其他字段；全局默认值只读。
`/agents` 和命令参数式后端切换不再支持。FleetView 已彻底移除且没有替代视图；
编辑器上方的 AgentWidget 保留。旧 `fleetView` 配置会被忽略，不迁移既有文件。
修改默认值只影响**新建代理**，已有句柄及被回收后通过 `@handle` 恢复的对话保留原后端。

普通 `Agent` 调用在两种后端中都默认自主完成，不会因为切换到 terminal 就让所有前台调用
变成无限等待人工操作。RPC、定时代理及工作流阶段里的 `Agent` 也使用同一后端选择。
不支持的执行模式会明确报错，不会静默降级到 embedded。

## 工具和控制

- `Agent`：保留前台/后台、代理类型、模型、思考等级、恢复和上下文继承接口。
  `run_in_background: false` 等待结果；后台调用返回 ID，并通过原有完成通知交付结果。
- `get_subagent_result`：查看或读取同一 manager 管理的记录。
- `steer_subagent`：必须显式指定 `action`，使用 `agent_id`/handle。
  `steer` 要求非空 `message`；`interrupt` 仅中断活跃轮次；
  `cancel` 结束任务及所属子任务，保留健康、可恢复的会话；
  `close` 确认清理成功后结束管理关系，不删除持久化历史。
- `/config:subagents`、AgentWidget、mentions 和 **RPC v3** 使用同一套 manager 控制。
  不再提供含义模糊的 `stop` action/channel；调用方必须选择明确动词。

AgentWidget 自行管理实时刷新计时器：设为 `off` 会隐藏并停止刷新；任务仍活跃时
重新开启，会恢复活动信息和耗时的实时更新。

并发限制统计活跃执行，不统计打开的终端数量。交互会话 idle 时释放槽位，下一轮执行前
重新获取；排队轮次显示为等待，不被误报为模型正在运行。

`Agent({ ..., interactive: true })` 请求由用户操作的交互终端，需要 terminal 后端，
仅适用于新建的非定时代理。终端可在模型一轮结束或当前轮次中断后继续保留。
对话结束时通过子 CLI 的正常退出入口或父会话的 `close` 操作结束，不要轮询后台任务是否完成。

代理定义也可以声明交互模式：

```md
---
name: interactive-reviewer
description: 与用户一起审查改动
interactive: true
---
检查改动，并在此终端中与用户讨论发现。
```

同时支持 `auto-exit`。显式调用参数覆盖定义中的模式；未声明时默认自主完成并退出。
两种后端都使用 Pi，不再提供 CLI 类型选择或外部 Claude 执行分支。
terminal 会话的嵌套 Agent 也固定使用 terminal，包括默认后端配置随后发生变化的情况。

## 定义和策略

定义优先级：项目 `.pi/agents` 高于 `.agents/agents`，再高于 `<agentDir>/agents`。
用户定义可以覆盖 `general-purpose`、`Explore`、`Plan`；禁用默认代理不会禁用用户覆盖。
普通产品和独立工作流执行入口共用初始化器，读取同一份 registry 与设置。

工具、扩展、技能、提示词、memory、模型和轮次策略继续由代理定义决定。定义在进入队列前
解析，避免另一个工作流/配置目录在执行时替换代理的工具权限。定义中的 `cwd` 相对于父项目
目录解析，配置来源与工具实际工作的目录仍然分开。

项目代理、subagents 配置及可执行资源遵从 Pi project trust。未获准时只使用全局定义和
设置；子会话继承已经捕获的决定，不会重新发现项目并将其误当成已信任。策略在准入时
固定，替换根会话不会改变正在执行的代理默认值或权限。

对于只有扩展自有资源的项目，Pi 0.87.1 可能未经询问就返回隐含信任。本产品要求 Pi 已保存
的信任决定或原生 `defaultProjectTrust: "always"`；此时未记录的单会话批准不足以放行。
程序化宿主可显式传入已确认的授权决定。使用的是 Pi 原生信任库，不另建审批数据库。

terminal 是进程边界，**不是操作系统沙箱**。扩展和工作流定义是可执行代码，只应安装可信
资源。可选终端依赖由 `pi-terminal-mux` 检测；可见交互需要合适的终端环境。目前不支持原生
Windows 进程监督。

### 默认扩展策略

`/config:subagents` → **设置 → 默认加载插件（项目）**打开策略选择器。Enter 打开，
空格不修改此行。**所有已发现插件**保存 `true`，包含未来新增的已获准资源。
**指定插件**打开可搜索多选列表：空格勾选，Ctrl+A 全选*当前可用*资源，Ctrl+R 清空，
Enter 保存显式数组（包括 `[]`），Esc 取消且不写入。保存过但当前不可发现的选择器会保留，
除非明确移除；不会静默规范化已保存的大小写或路径。**不加载**保存 `false`；
**重置项目覆盖**仅删除项目字段，恢复继承全局策略或兼容默认值。界面不写全局配置。

`subagents.json` 的 `defaultExtensions` 可省略。两层均省略时保留兼容默认 `true`；
`true` 从已获准 Pi 资源发现普通子会话扩展，`false` 与 `[]` 禁用，字符串数组指定名称／路径。
代理省略 `extensions` 时使用此分层默认；显式 `extensions: true`、`false`、`[]` 或名称／路径
覆盖默认。内置代理省略该字段；已有用户 Explore／Plan 文件中的 `extensions: true`
仍为显式策略，不修改文件。`isolated: true` 始终禁用扩展；`exclude_extensions` 仍优先，
根／UI 产品继续过滤。

发现**不是严格继承父会话实际加载的扩展**：使用 Pi 已获准的全局／项目 manifest 与资源路径，
不包含临时 CLI 来源。打开列表仅读取元数据，不导入扩展模块、不执行 factory、不安装缺失
npm／git 来源，也不重新加载资源。详情展示策略与来源，不冒充实际加载列表。策略在准入时
固定；修改默认只影响新准入，不改变已排队／运行代理或保留会话。

旧字段 `inherit_extensions` 已被拒绝，即使同时存在 `extensions` 也不接受。
请重命名为 `extensions` 并移除旧字段；若代理应跟随可配置默认值，则省略 `extensions`。

## 工作流接入

主入口同时提供版本化工作流执行器，不要再额外加载 `workflow-executor.ts`。
只需要工作流的启动器可以单独使用该入口：它初始化运行时并提供子会话内的 Agent 工具，
不加载根会话管理面板或 AgentWidget。

默认 **standard** 配置保留原 SDK host 结构：

```text
pi-workflow DSL / runner
  → 标准 WorkflowHostContext
    → 使用正常、已授权 Pi 资源的原生阶段 AgentSession
      → 作用域内 Agent 工具
        → 同一个 embedded/terminal 子代理工厂
```

`/wf` 整体仍在后台运行，但阶段内的 `Agent` 默认前台委派，阶段会等待结果。
显式 `run_in_background: true` 仍然有效；阶段作用域结束时，会取消尚未完成的后台子任务。
根会话普通 Agent 继续遵从 `backgroundByDefault`。

阶段会话本身仍使用 SDK。在 `subagents.json` 选择 terminal，改变的是阶段内委派的
`Agent` 工作，不会静默搬迁整个阶段或关闭它的扩展与技能。首次提示、continuation 分叉、
原始 Pi 会话恢复、模型/思考等级覆盖、嵌套作用域和 bash 超时恢复使用原工作流契约。
子会话对话框串行显示，并随所属作用域取消；子会话不能接管主会话编辑器、页脚或悬浮组件。
这不是 RPIV lane dock 的迁移。

本包**不附带**原 RPIV 的全部技能与工具扩展。迁移引擎不等于安装原宿主的整套资源包；
这些资源需要正常配置，所需工具必须实际可用。

### 显式 managed 配置

更严格的受管 embedded/terminal 实现仍可通过工作流
`execution.profile: "managed"` 使用。它的内置工具限制、批准技能快照、已存策略、
租约/检查点和保守恢复边界，不再施加到普通 Agent 调用或标准工作流阶段。

见[受管会话](./docs/managed-sessions.md)、[受管 embedded](./docs/managed-embedded.md)
和[受管工作流资源](./docs/workflow-resources.md)。这些文档描述的是隔离配置，而非通用产品后端。

## 验证与来源

```sh
npm run typecheck -w @maplezzk/pi-subagents
npm test -w @maplezzk/pi-subagents
npm run check
```

测试使用临时配置/会话目录和脚本化 provider，不依赖凭据、在线模型或特定终端守护进程。
真实 provider 与可见终端行为还需要人工冒烟验证。

进程内基线来自 `tintinweb/pi-subagents` v0.19.0，提交
`e955e29c51b7a6cce37e1108cd2d6c57a77e151c`。终端能力借鉴
`HazAT/pi-interactive-subagents` 及本仓库原 fork。MIT 归属保留在
[LICENSE](./LICENSE) 与 [LICENSE.interactive-subagents](./LICENSE.interactive-subagents)。
另见 [UPSTREAM.md](./UPSTREAM.md) 和 [RPC 参考](./docs/rpc.md)。
