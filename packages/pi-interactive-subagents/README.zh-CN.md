# pi-interactive-subagents

根 Git／本地安装默认启用的统一 Pi 子代理实现；完整配置和 API 见 [English README](./README.md)。原生 `subagent` 异步启动，`subagents_list` 发现角色，`subagent_message` 发送消息／恢复，`subagent_status` 查询，`subagent_stop` 保留历史地停止。结果和问题自动回传，不要求轮询。

## 安装与兼容

```sh
pi install git:github.com/haoyiqiang/pi-extensions
```

- 需要 Pi 0.87.1+、Node.js 22.19+，以及有父终端身份的 tmux 或 Orca；明确拒绝 headless。
- 本 workspace 保留上游 `pi-interactive-subagents` 名称、版本、许可证和归属，标记为 **private integration-only**。只验证本地打包和根部署，不进入 npm 发布自动化，也不迁移包所有权。
- `@kevinhao/pi-subagent` 仍是独立安装的 CLI 包；其 CLI、run store 和历史不变。根 profile 不加载它的控制器，不导入／删除其数据，也不修改用户额外安装的配置。若此前单独装过旧交互扩展，请自行检查并只保留一个控制器入口；本包不会自动卸载其他安装。
- 兼容的旧 interactive 记录可读，但缺失／无效的限制性 loadout 或无法确认的 writer 必须拒绝恢复。旧名称映射、心跳超时、终端消失都不是 writer 退出证明。请保留历史并以有效角色启动新子代理。

## 有意修正的契约

- `tools` 必须显式声明；遗漏报错，`tools:` 空集只允许对话和控制。
- 缺省 `auto-exit` 是自主退出；常驻必须 `auto-exit: false`。人工输入不会隐式改变策略。
- 回答问题必须 `subagent_message({ id, replyTo: questionId, message })`，即使只有一个问题；普通消息不回答问题。
- 角色的相对 `cwd` 按来源根目录解析（项目根／全局 agent 配置根／包根），调用参数按父 cwd 解析；恢复重用已验证的快照，不用修改后的角色扩大权限。
- `/reload` 只替换观察者。正常退出／切换会话挂起 owned tree；返回同一父会话会自动续作状态明确的任务，可能消耗模型额度并修改文件。活动工具、副作用或消息消费不确定时暂停，普通恢复不授权重试；核对后只授权确切 `actionId`。
- `subagent_stop` 确认所有 owned writer 退出和终端关闭，保留会话、问题、消息及完整结果，不提供 purge。
- Pi tools 白名单**不是 OS 沙箱**；bash/write 仍拥有用户权限，`safe_bash` 不是安全边界。可选 Claude 路径不在新 managed-Pi 可靠性保证范围内。

执行与整个会话用量分别显示；容量未知不猜测百分比。紧凑结果保留完整结果文件入口，核心交付不依赖 UI。

## 验证

仓库根运行 `npm run check`，独立安装验证见 `npm run test:install -w pi-interactive-subagents`。默认测试使用确定性本地 provider，不访问付费模型或用户终端。真实 tmux／Orca 进程 smoke 需显式选择，见英文文档。

## 归属

由 [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) 和 Amos Blomqvist 的上游工作衍生，保留 [MIT LICENSE](./LICENSE)。
