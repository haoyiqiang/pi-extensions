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
- 私有 terminal 生命周期已可用于开发验证，但尚未接入 AgentManager；后端路由、配置迁移
  和 rpiv-workflow 适配器仍未实现。

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

接口仍使用原生 Pi session 类型，尚不是可承载 terminal 的最终接口，也不是公开
workflow API。详细范围、兼容约定和剩余耦合见 [执行边界](./docs/execution-backend.md)。
此步没有新增用户配置。

## Terminal 生命周期基础

`src/backends/terminal/` 新增了可注入依赖的启动、完成等待、Escape 中断、取消和清理实现，
通过 `pi-terminal-mux` 的公开 API 操作终端，支持显式选择 Bash/PowerShell。
纯数据 run/session 引用区分单次执行和持久会话；
启动失败和取消均清理自建 pane，resume 结果不会复用旧轮次文本或旧完成标记。

这还没有接入 AgentManager，也不负责模型选择、子进程 CLI 策略或工具注册。
完整契约与限制见 [terminal 生命周期](./docs/terminal-lifecycle.md)。新增诊断已使用中英文
catalog；上游 embedded 文案仍待迁移。

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

下一步：迁移 manager/UI/输出订阅对原生 session 的依赖，接入 terminal 执行与子进程策略，
再完善会话存储语义、后端路由、本地化和统一 UI/配置。完成整合后才切换根 profile 与发布元数据。
