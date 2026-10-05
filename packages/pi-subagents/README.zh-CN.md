# @maplezzk/pi-subagents — 私有迁移基线

> English documentation: [README.md](./README.md)

本 workspace 导入 [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)
v0.19.0 的实现，固定上游提交为 `e955e29c51b7a6cce37e1108cd2d6c57a77e151c`。
它是后续统一进程内与终端子 agent 的起点，**目前不是可安装的替代包**。

## 加载与发布边界

- `private: true`，不声明 Pi 资源，不自动加载。
- 不加入根 Pi profile、release-please、发布流程或公开包 tarball 门禁。
- 现有 `@maplezzk/pi-interactive-subagents` 保持不变，仍是正式使用的扩展。
- 入口只导出上游扩展工厂，不调用它；迁移期间不要在生产会话同时加载两套产品。
- 真实 terminal backend 已可通过私有工厂显式注入用于开发验证；AgentManager 默认仍为
  embedded。配置路由、迁移与 rpiv-workflow 适配器尚未实现。

## 导入范围

保留上游源码与回归测试：AgentSession 执行、AgentManager 生命周期与队列、
`Agent` / 结果查询 / steer 工具、agent 定义、结构化输出、session 持久化、
Git worktree、RPC/事件和 UI。上游 scheduler 与 JavaScript `SubagentWorkflow`
的源码、测试和示例也保留用于基线对比，但不在根 profile 中启用。

Pi 开发依赖统一为 **0.87.1**，TypeScript 为 **5.9.3**，Vitest 为 **5.0.1**。
本地 SDK 兼容调整记录在 [UPSTREAM.md](./UPSTREAM.md)，原始 MIT 版权声明保留在
[LICENSE](./LICENSE)。

## Embedded backend 抽取

SDK 执行实现已移至 `src/backends/embedded.ts`，steer 与 session 清理位于
`embedded-lifecycle.ts`；`agent-runner.ts` 保留兼容导出。AgentManager 可注入私有
执行接口用于测试和组合，但队列、记录、取消、worktree 与通知仍由它负责。
工具的 steer 不再绕过此接口。

Manager 的会话句柄以及 UI/输出观察接口已与原生 `AgentSession` 脱钩。
`embedded-adapter.ts` 在每个 backend 内部保管原生会话，拒绝跨实例或已关闭句柄的控制请求。
只读视图保留消息对象、压缩、统计和模型元数据，但不暴露 SDK 控制方法或模型鉴权头。
原始 runner 兼容入口保持不变。首次 embedded 执行与 owned-session resume 现共用
`embedded-invocation.ts`：schema 数据、turn limit 与宽限值在创建时保存，捕获、计数、
补救次数和监听则每次调用重建。取消或最终错误后不再补救；并发调用在修改捕获状态前被拒绝。

请求准备仍使用 Pi context，terminal 需要显式私有工厂注入。私有回调契约变化、兼容约定
及剩余工作见 [执行边界](./docs/execution-backend.md)。此步没有新增用户配置。

## Terminal 执行（私有显式启用）

`src/backends/terminal/` 新增了可注入依赖的启动、完成等待、Escape 中断、取消和清理实现，
通过 `pi-terminal-mux` 的公开 API 操作终端，支持显式选择 Bash/PowerShell。
纯数据 run/session 引用区分单次执行和持久会话；
启动失败和取消均清理自建 pane，resume 结果不会复用旧轮次文本或旧完成标记。

`createTerminalExecutionBackend()` 已将该实现接入真实 Pi CLI 子进程、启动策略、带认证的
本地反馈通道、规范会话视图、带确认的 steer，以及同一会话的新进程 resume。
目前支持 POSIX/Bash、`isolated: true` 的自主完成型任务。已接通 JSON Schema 结构化输出
（缺失时最多补救一次）及 turn limit 的软上限、宽限和硬中止。owned-session resume 保留策略，
但每次重置捕获、补救次数和 turn 计数；manager 传回新的结构化结果与中止/收尾状态，不复用旧结果。
已有干净检查点的 terminal 受管会话现在可跨 backend 实例 reattach，或 fork 为新身份并保留有效分支历史。
保存的执行策略随会话恢复；文件租约覆盖句柄整个持有期，阻止协作方并发写入同一记录。
裸 JSONL 导入、崩溃/不确定退出后的恢复、继承上下文、memory 和原生 Windows 仍明确拒绝。
embedded 已对齐 owned-session resume 的结构化输出与轮次策略；恢复端口的双后端整合仍未完成。
完成判断使用独立的进程退出回执，不信任屏幕文本中的结束标记。

策略、校验器要求与租约限制见 [受管会话恢复](./docs/managed-sessions.md)。
完整执行契约与限制见 [terminal 后端](./docs/terminal-backend.md) 和
[terminal 生命周期](./docs/terminal-lifecycle.md)。新增诊断已有中英文 catalog；上游
embedded 文案仍待迁移，目前没有用户配置开关。

## 配置

本批次没有新增生产配置，因此有意不添加 `config.example.json`。隔离开发仍使用上游的
`<agentDir>/subagents.json` 与 `<cwd>/.pi/subagents.json`，项目级覆盖全局值。
不会读取、改写或删除当前 interactive-subagents 的配置。

正式启用或发布前，必须将上游英文提示、工具说明、模型提示词和直接通知迁入
`pi-extensions-i18n`，并将配置读写接入 `pi-extensions-config`。保持私有状态是为了
不向用户暴露尚未完成仓库集成的版本。

## 开发验证

在仓库根目录执行 `npm install` 后：

```bash
npm run typecheck -w @maplezzk/pi-subagents
npm test -w @maplezzk/pi-subagents
npm run test:e2e -w @maplezzk/pi-subagents
npm run check
```

测试使用脚本化/faux provider、临时 HOME/agent/session 目录及临时项目仓库，并清除
继承的 Git 目录和配置覆盖。测试配置强制关闭
`PI_E2E_LIVE`，即使外部 shell 已设置也不会启用真实模型；保留的上游 live-model
测试继续跳过。Git/worktree 测试只操作临时仓库，需要 Git 可执行文件，不需要 API key、
终端复用器或本机 Pi 服务。`test/fixtures/.pi/` 是受版本控制的测试资源，不是个人配置。

## 参考与后续

- [导入来源和本地差异](./UPSTREAM.md)
- [上游 README 存档](./docs/upstream-README.md)
- [上游 RPC 协议参考](./docs/rpc.md)
- [上游脚本 workflow 参考](./docs/workflows.md)

下一步：完善会话存储、恢复和 terminal 能力对齐，再加入后端路由、本地化和统一 UI/配置。完成整合后才切换根 profile 与发布元数据。
