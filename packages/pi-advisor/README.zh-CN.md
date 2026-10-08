# @maplezzk/pi-advisor

为 Pi 提供零参数 `advisor()` 工具，由单独选择的审阅模型给当前模型提供计划、纠正或停止建议。

## 功能

- 转发当前有效分支上下文，包括压缩摘要和分支摘要。
- 转发前移除正在执行的 `advisor` 调用；审阅模型不获得任何工具。
- 正常结束但文本为空时，使用同一份已快照的上下文、模型和推理强度仅重试一次。
- 旁路请求使用 `ctx.modelRegistry.streamSimple(...).result()`；OpenAI Codex 使用独立 UUIDv7 会话并在 `finally` 中清理。
- 将旁路请求 usage 放入工具结果，供 Pi 统计。
- 顾问选择由每个扩展/会话 runtime 独立持有，SDK 或工作流子会话不会覆盖根会话选择。
- `disabledForModels` 可按执行模型及推理强度动态隐藏工具。
- UI、提示、工具指导和顾问提示词均支持简体中文与英文；`--locale` 启动解析和语言切换后会刷新工具／命令元数据，保留手工配置的 guidance。

## 安装与使用

```bash
pi install npm:@maplezzk/pi-advisor
```

重载 Pi 后运行以下任一命令：

```text
/config:advisor
/advisor
```

两个命令打开同一个选择器，并修改同一份 runtime 状态和配置；`/advisor` 保留为原有短别名。TUI 中支持模糊筛选，RPC 客户端使用 Pi 原生选择界面。

## 配置

规范路径：

```text
~/.pi/agent/extensions/pi-advisor/advisor.json
```

支持 `PI_CODING_AGENT_DIR`。规范文件不存在时，可只读旧 RPIV 路径 `$XDG_CONFIG_HOME/rpiv-advisor/advisor.json`（默认 `~/.config/rpiv-advisor/advisor.json`）。显式选择始终只写规范路径，并使用仅所有者可读写权限。

```json
{
  "modelKey": "anthropic/claude-opus-4-6",
  "effort": "high",
  "disabledForModels": [
    "anthropic/claude-opus-4-6",
    { "model": "openai/gpt-5.2", "minEffort": "high" }
  ],
  "guidance": {
    "promptSnippet": "在作出重要决定前升级审阅。"
  }
}
```

- `modelKey`：`provider/modelId`；读取时兼容旧的 `provider:modelId`。
- `effort`：`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`；省略表示不显式发送推理强度。
- `disabledForModels`：执行模型禁用列表；`minEffort` 表示仅在达到该强度时禁用。
- `guidance.promptSnippet`、`promptGuidelines`、`description`：可选模型提示覆盖。

命令保存时会保留未知字段以及手工编辑的 guidance/blocklist。

未配置审阅模型或当前执行模型命中禁用规则时，工具会从 active tools 中移除。切换执行模型或推理强度会立即重新计算。扩展工厂加载时不会自动调用模型。鉴权、headers 与取消统一由原生请求准备路径处理，不额外执行预检；工具清单每次根据调用方当前定义生成，不跨会话缓存。

历史上游文档保留在 [`docs/upstream`](./docs/upstream)，其中路径和 transport 描述针对原 RPIV 包。移植来源见 [UPSTREAM.md](./UPSTREAM.md)。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
