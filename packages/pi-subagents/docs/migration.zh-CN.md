# 切换到统一 Pi 子代理与工作流

> [English](./migration.md)

仓库默认 Git／本地 profile 现在加载 `pi-subagents` 和 `pi-workflow`，不再加载
`pi-interactive-subagents`。这是运行入口切换，不是 npm 发布。两个新产品仍为
`private: true`；旧包仅保留源码，不再进入发布流程。

## 重新加载前

1. 先完成或停止旧子代理。`/reload` 不会把旧进程、旧任务 ID 转交给新的管理器。
2. 用 `pi list` 检查安装方式。如果已经把本仓库作为 package source，更新仓库即可
   改变默认入口，不必改写全局设置。
3. 如果另装了旧 npm 包，或显式列出了旧扩展路径，应先移除对应声明，再启用统一入口。
   用 `pi list` 显示的准确 source 执行 `pi remove <source>`，或自行修改设置。
   不要同时加载新旧产品。
4. 修改配置前做好备份。本次迁移不会删除旧配置、会话文件、`.pi/workflows` 输出或
   `.rpiv` 运行日志。

完整套件的安装方式：

```sh
pi install git:github.com/maplezzk/pi-extensions
```

完整套件也会启用 Spark、Blackhole 等根 profile 扩展，不要与同一扩展的独立安装副本
重复加载。只选择新子代理与工作流时，可以在本仓库启动：

```sh
pi --no-extensions \
  -e ./packages/pi-extensions-i18n/index.ts \
  -e ./packages/pi-subagents/index.ts \
  -e ./packages/pi-workflow/extension.ts
```

仅提供工作流执行的 `pi-subagents/workflow-executor.ts` 是
`pi-subagents/index.ts` 的替代入口，不是需要额外叠加的执行器。

使用 Pi 0.87.1 或经过验证的兼容版本，以及 Node.js 22 或以上版本。停止旧任务后，
重新启动 Pi 或执行 `/reload`。新工具定义对新扩展代际生效；旧对话中仍可能保留已经
不存在的工具调用记录。

## 后端与代理定义

两种执行后端都使用 Pi，不再提供外部 Claude CLI 分支或 CLI 类型选择。Pi 自身的
模型 provider 与执行后端是两个独立维度。

- 默认 `embedded`，普通 Agent 自主执行。
- 使用终端执行：`/config:subagents terminal`。
- 切回进程内执行：`/config:subagents embedded`。
- 配置先读 `<agentDir>/subagents.json`，再由 `<project>/.pi/subagents.json` 覆盖；
  支持 `PI_CODING_AGENT_DIR`。

旧 interactive-subagents 配置不会被当成新的配置格式读取。代理 Markdown 定义从
`<agentDir>/agents`、`.agents/agents`、`.pi/agents` 读取，项目定义优先。
旧定义中 CLI 专属的工具或模型选项需要检查，不能假定名称在 Pi 中具有相同含义。

选择 terminal 不代表所有任务都变成人工交互任务。需要长驻交互终端时，在 Agent 调用
或代理定义中设置 `interactive: true`。可见交互会话需要支持的终端复用器；自主 terminal
任务可以使用 headless 子进程回退。已有会话保留自己的后端，terminal 后代仍固定在
保存的 terminal 分支上。

## 工具与命令变化

| 退役入口 | 统一入口 |
| --- | --- |
| `subagent` | `Agent`，使用 `prompt`、`description`、`subagent_type`，可设置 `run_in_background` |
| `subagent_resume` | `Agent` 的 `resume`，引用**新管理器拥有的**代理 ID |
| `subagent_interrupt` | `steer_subagent` 的 `action: "interrupt"` |
| 永久停止 | `steer_subagent` 的 `action: "stop"` |
| 后台结果 | `get_subagent_result` |
| `subagents_list`／旧管理命令 | `/agents` 及统一 Fleet/widget |
| `/plan`、`/iterate` | 显式定义工作流并使用 `/wf`，不提供别名 |
| `__pi_subagents` 全局桥 | 版本化事件总线 RPC，见 [RPC 文档](./rpc.md) |

原 `pi-subagents` 的 Symbol manager view 仍是同一个根管理器的视图，供其既有调用方
使用，不是旧交互桥。另一套上游 `SubagentWorkflow` 引擎不启用。

## 工作流迁移

`pi-workflow` 负责 `/wf`、`/wf-cancel`、DSL、日志和恢复。默认 `standard` 模式保留
原生 SDK 阶段会话与正常、已授权的 Pi 资源。阶段内的 Agent 委派使用统一子代理后端；
不要为了选择 Agent 的运行位置，就把阶段切换成 managed 后端。

项目定义继续使用 `.rpiv/workflows/config.ts`；用户定义和日志保留文档约定的原路径。
最小双阶段定义及模型／思考等级配置见[工作流 README](../../pi-workflow/README.zh-CN.md)。

- 工作流配置：`<agentDir>/extensions/pi-workflow/config.json` 与
  `<project>/.pi/pi-workflow.json`。
- 模型优先级：preset-stage → stage → skill → defaults。没有覆盖时，标准阶段使用
  Pi SDK 配置默认值，而不是当前主会话临时选择的模型。
- 本次迁移不安装整套 RPIV 技能包、工具集合或 lane dock。运行自有定义前，先配置它
  所依赖的资源。
- standard 可恢复普通 Pi JSONL 会话；managed 仍要求自己的策略与检查点证据，不会
  静默接管普通或旧会话。
- 旧 `.pi/workflows/*.json` 任务／报告输出不是可执行的工作流 DSL 定义。它们会保留，
  不会自动转换或执行。

## 验收

先检查一个新 Agent 任务、结果读取及 interrupt／stop，再运行一个小型文件工作流，
检查日志、取消任务并恢复失败阶段。确认本机具备定义所需的技能、工具和模型。

仓库测试覆盖组合加载及真实的离线 SDK／子进程链路，不代表已经运行每一份个人工作流
或验证每一个线上 provider。仓库迁移本身不会修改用户全局配置，也不会执行 npm 发布。
