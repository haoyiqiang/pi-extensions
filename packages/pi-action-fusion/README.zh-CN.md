# pi-action-fusion

将单文件 `edit` 或 `write` 与可选的后续命令合并为一次工具调用。改编自 NVIDIA 的 [SoL-Pi Action Fusion](https://github.com/NVlabs/SoL-Pi)。不额外调用模型，不压缩上下文，也不摘要工具输出。

> English: [README.md](./README.md)

## 加载与启用

要求：Node.js 22+，Pi 0.87.1 或经验证的兼容版本。

仓库 Git／本地 profile 已显式加载本包，但**功能默认关闭**。独立本地试用：

```bash
pi -e ./packages/pi-action-fusion/index.ts
```

按包目录安装：

```bash
pi install ./packages/pi-action-fusion
```

随后明确启用并重新加载：

```text
/config:action-fusion enable
/reload
```

`/config:action-fusion status` 显示已加载状态和配置状态；`disable` 同样需要 `/reload`。仅加载扩展不会写入配置。

也可手动创建 `<Pi agent 目录>/extensions/pi-action-fusion/config.json`：

```json
{ "enabled": true }
```

通常 agent 目录为 `~/.pi/agent`，支持 `PI_CODING_AGENT_DIR`。不读取项目级配置，不自动迁移 `sol-pi.json`。配置缺失时关闭；配置无效时警告并保持关闭，需手动修复（配置命令不会覆盖无效文件）。默认值见 [config.example.json](./config.example.json)。不要与原始 SoL-Pi Action Fusion 或另一个替换 `edit`／`write` 的扩展同时加载。

## 工具契约

启用后，用原生定义加可选 `then_run` 替换 `edit` 和 `write`：

```json
{
  "path": "src/parser.ts",
  "edits": [{ "oldText": "return input", "newText": "return parse(input)" }],
  "then_run": { "command": "npm test", "timeout": 120 }
}
```

`write` 使用原有 `path` 和 `content`，后续命令参数相同。省略超时时沿用原生 Bash 的无默认超时行为。

1. 执行原生单文件修改。
2. 如果请求了命令，检查是否观察到文件干扰，然后在 `ctx.cwd` 执行命令。
3. 一起返回修改确认和命令输出：

```text
Successfully replaced 1 block(s) in src/parser.ts.
[then_run:succeeded]
...测试输出...
```

没有 `then_run` 时，原生修改结果不变。保留原生 edit 参数兼容转换及多处替换语义。命令失败、超时或取消会产生带 `[then_run:failed]` 的失败工具结果；已完成的文件修改**不回滚**。修改失败或检测到命令执行前的文件干扰时，返回 `[then_run:skipped]`。融合调用失败时保留修改确认文本，但与上游一样，Pi 对抛出异常的结果进行标准化后，不再保留原生 diff／patch details。

成功／流式结果保留原生 edit details，并新增 `details.actionFusion`，包含命令、状态和嵌套的 `bashDetails`（适用时包含原生截断信息及完整日志路径）。命令输出沿用原生 Bash 的大小限制，不会无界返回日志。机器标记保持固定；描述、错误、命令和 UI 标签使用双语 catalog。

## 两阶段工具卡片

融合调用仍是一张工具卡片，保留原生文件标题并加一个轻量融合标识。修改与命令状态分别显示：

```text
write target.txt · 融合
✓ 修改已保存，未回滚
✕ 后续命令 · 退出 7  $ npm test
```

折叠态只显示两个阶段及有界命令预览；通过 Pi 原生工具展开操作查看原生修改 diff／write 预览和可展开的 Bash 日志。机器标记仅用于解析，不直接作为状态标签显示，模型可见内容不变。“省去一次模型往返”只作为成功结果展开后的次要信息。退出 0 仅表示命令正常结束，不等于测试全部通过。

修改失败时显示修改失败、命令未执行；命令前检测到干扰时显示修改已保存、命令跳过。命令失败、超时或取消时明确保留“修改已保存”。安静命令在 stdout 到达前就发布执行中更新。渲染也支持会话恢复后 Pi 标准化的失败文本，包括另一种支持语言记录的错误。未知或歧义边界回退原生渲染，不猜测状态。

没有 `then_run` 时原生展示完全不变。成功／流式结果复用原生 diff；抛出错误被标准化后仍可能丢失 diff metadata，此时展示保留下来的修改确认，不重建 diff。Distill 的独立审计及来源展示仍由 Distill 自己负责。

## 并发与安全

队列覆盖同一规范化文件的“修改＋命令”，包括常规符号链接别名；不同文件可独立执行。命令前的 SHA-256 检查是尽力检测干扰，**不是**外部进程文件锁、事务或完全防竞态保证。

**后续命令是内部执行，不是第二次 `bash` 工具调用。**只触发外层 `edit`／`write` 的原生工具事件。仅针对 Bash 的权限检查、工具包装、摘要及命令路由不会自动看到它。如果安全策略只依赖独立 Bash 钩子，请不要启用。它不是沙箱。

默认入口使用内置本地 Bash 后端的默认设置，不借用其他扩展的 Bash 覆盖，也不自动继承 SDK／自定义 shell 选项。嵌入调用者可通过 `createActionFusionExtension(options)` 明确传入 `bashOptions`、`editOptions` 和 `writeOptions`。干扰检查读取本地文件系统，远程修改适配器需要对应的本地目标；不支持的纯远程目标会跳过后续命令。

`pi-distill` 负责可选的原文归档及 `then_run` 诊断日志证据处理，Fusion 集成默认关闭，需在 Distill 中明确启用。它保留修改确认、diff／patch details 和工具错误状态。Action Fusion 本身不归档或摘要日志，也不依赖 Distill。

## 开发与来源

```bash
npm run typecheck --workspace pi-action-fusion
npm test --workspace pi-action-fusion
```

回归测试覆盖上游融合语义、取消、队列、路径和原生工具兼容性；离线 SDK 测试验证实际工具事件和错误状态，无需 API Key。上游归属见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 [LICENSE](./LICENSE)。
