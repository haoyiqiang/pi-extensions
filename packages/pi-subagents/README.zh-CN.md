# @maplezzk/pi-subagents — 统一子代理

> English documentation: [README.md](./README.md)

通过同一套 `Agent`、RPC 和管理界面，配置选择进程内或终端执行。代理定义、调度、队列、
结果和 Fleet/widget 界面属于 `pi-subagents`，终端操作使用 `pi-terminal-mux`。
独立的 `pi-workflow` 负责工作流定义、编排、日志和 `/wf`。

## 开发边界

本 workspace 仍为私有、显式加载，不发布，也尚未进入根分发配置。不要与旧
`pi-interactive-subagents` 产品或另一份上游 subagents 扩展同时加载。旧产品暂时保留在
仓库中，等待分发迁移。导入的管理界面文案仍需在公开分发前完成 catalog 迁移；
新增控制与诊断使用双语 catalog。

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
- `<cwd>/.pi/subagents.json`，项目字段覆盖全局字段。

agent 目录支持 `PI_CODING_AGENT_DIR`。已有运行设置见
[`config.example.json`](./config.example.json)。

```json
{ "backend": "embedded" }
```

使用 `"terminal"` 可在独立进程/终端中执行。也可运行
`/config:subagents embedded|terminal`，它会保留项目配置中的其他字段。
修改默认值只影响**新建代理**，已有句柄及被回收后通过 `@handle` 恢复的对话保留原后端。

普通 `Agent` 调用在两种后端中都默认自主完成，不会因为切换到 terminal 就让所有前台调用
变成无限等待人工操作。RPC、定时代理及工作流阶段里的 `Agent` 也使用同一后端选择。
不支持的执行模式会明确报错，不会静默降级到 embedded。

## 工具和控制

- `Agent`：保留前台/后台、代理类型、模型、思考等级、恢复和上下文继承接口。
  `run_in_background: false` 等待结果；后台调用返回 ID，并通过原有完成通知交付结果。
- `get_subagent_result`：查看或读取同一 manager 管理的记录。
- `steer_subagent`：`action` 默认为 `steer`，此时必须提供 `message`。
  `action: "interrupt"` 仅中断当前轮次，`action: "stop"` 退役代理并关闭终端。
  两者都使用原来的 `agent_id`/handle。
- `/agents`、Fleet/widget、mentions 和 RPC v2 仍为统一控制入口。

`Agent({ ..., interactive: true })` 请求由用户操作的交互终端，需要 terminal 后端，
仅适用于新建的非定时代理。终端可在模型一轮结束或当前轮次中断后继续保留。
对话结束时通过子 CLI 的正常退出入口或父会话的 stop 操作结束，不要轮询后台任务是否完成。

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

terminal 是进程边界，**不是操作系统沙箱**。扩展和工作流定义是可执行代码，只应安装可信
资源。可选终端依赖由 `pi-terminal-mux` 检测；可见交互需要合适的终端环境。目前不支持原生
Windows 进程监督。

## 工作流接入

主入口同时提供版本化工作流执行器，不要再额外加载 `workflow-executor.ts`。
只需要工作流的启动器可以单独使用该入口：它初始化运行时并提供子会话内的 Agent 工具，
不加载根会话 Fleet/widget。

默认 **standard** 配置保留原 SDK host 结构：

```text
pi-workflow DSL / runner
  → 标准 WorkflowHostContext
    → 使用正常、已授权 Pi 资源的原生阶段 AgentSession
      → 作用域内 Agent 工具
        → 同一个 embedded/terminal 子代理工厂
```

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
