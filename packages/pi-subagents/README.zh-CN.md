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
- 本批次不实现 terminal backend、backend 路由、配置迁移或 rpiv-workflow 适配器。

## 导入范围

保留上游源码与回归测试：AgentSession 执行、AgentManager 生命周期与队列、
`Agent` / 结果查询 / steer 工具、agent 定义、结构化输出、session 持久化、
Git worktree、RPC/事件和 UI。上游 scheduler 与 JavaScript `SubagentWorkflow`
的源码、测试和示例也保留用于基线对比，但不在根 profile 中启用。

Pi 开发依赖统一为 **0.87.1**，TypeScript 为 **5.9.3**，Vitest 为 **5.0.1**。
本地 SDK 兼容调整记录在 [UPSTREAM.md](./UPSTREAM.md)，原始 MIT 版权声明保留在
[LICENSE](./LICENSE)。

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

下一步：保持行为不变地抽取 embedded backend，再集成当前 terminal backend，完成
本地化、UI/配置统一后，一次切换根 profile 与发布元数据，最后删除旧包。
