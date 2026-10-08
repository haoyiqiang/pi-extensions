# @maplezzk/pi-ask-user-question

这是一个 Pi 扩展，注册 `ask_user_question` 工具，让智能体在需求含糊时通过结构化问卷向用户确认，而不是自行猜测。

## 功能

- 每次可提出 1–4 个问题。
- 每题包含 2–4 个选项。
- 支持单选与多选。
- 每题自动提供自由文本回答行。
- 支持逐题备注和提交页全局备注。
- 单选选项可附带 Markdown 预览。
- 多问题模式支持标签页检查和部分提交。
- 自定义回答使用问卷内自持的 Pi 多行编辑器：行内按 `Ctrl+G` 进入编辑子视图，配置的确认键应用草稿，`Esc` 放弃；子视图内再按 `Ctrl+G` 启动配置好的外部编辑器。
- RPC 模式使用原生 `select` / `input` 对话框降级。
- 工具结果包含可供回放和渲染器使用的结构化 details。
- 保留兼容事件：`rpiv:ask-user:prompt` 与 `rpiv:ask-user:blocked`。
- UI、提示词、schema 描述、错误和通知均提供简体中文与英文。

## 不同宿主模式

- **TUI：**仅当 `ctx.mode === "tui"` 时显示扩展自有的 `ctx.ui.custom()` 覆盖层。
- **RPC：**依次使用原生 `ctx.ui.select()` 与 `ctx.ui.input()` 对话框。
- **Print/JSON/无界面：**从活动工具集中移除该工具；若直接调用，则返回结构化 `no_ui` 或 `no_custom_ui` 结果。UI 加载失败绝不会伪装成用户拒绝。

本扩展不会替换 Pi 的根编辑器、页脚、页眉、小组件、状态区或终端标题；多行编辑器仅存在于当前问卷覆盖层内部。

## 配置

创建：

```text
$PI_CODING_AGENT_DIR/extensions/pi-ask-user-question/config.json
```

`PI_CODING_AGENT_DIR` 默认是 `~/.pi/agent`。

```json
{
  "collapseKey": "ctrl+]",
  "guidance": {
    "description": "可选的工具描述覆盖",
    "promptSnippet": "可选的提示摘要覆盖",
    "promptGuidelines": ["可选的指导规则覆盖"]
  }
}
```

`collapseKey` 接受 Pi 按键格式，例如 `alt+o`、`ctrl+shift+h`；设为 `off` 可关闭折叠。无效字段会安全回退，并通过来源标签为 `ask` 的通知报告。仅当规范配置不存在时才会只读兼容旧 RPIV 配置路径，绝不会写入旧路径。

外部编辑器命令依次取自 Pi 的 `externalEditor` 设置、`$VISUAL`、`$EDITOR` 和平台默认值。扩展始终读取全局设置；只有持久信任存储明确将当前工作目录标记为可信，或目录未被明确拒绝且全局 `defaultProjectTrust` 为 `always` 时，才读取 `.pi/settings.json`。扩展不会从宿主私有状态猜测仅本次会话有效的信任。取消操作会等待本扩展启动的 launcher 进程真实关闭后再恢复 TUI；若编辑器把工作委托给已运行的共享 GUI，该 GUI 可能继续存在。

## 工具结果

工具返回普通 Pi 工具内容和结构化 details：

```ts
{
  answers: Array<{
    questionIndex: number;
    question: string;
    kind: "option" | "custom" | "multi";
    answer: string | null;
    selected?: string[];
    notes?: string;
    preview?: string;
  }>;
  cancelled: boolean;
  globalNote?: string;
  error?: string;
}
```

## 事件

- `rpiv:ask-user:prompt`：在可用的 TUI 或 RPC 提问开始前触发。
- `rpiv:ask-user:blocked`：等待用户期间发送 `{ active: true }`，清理时始终配对发送 `{ active: false }`。

## 开发

```bash
npm test --workspace @maplezzk/pi-ask-user-question
npm run typecheck --workspace @maplezzk/pi-ask-user-question
```

来源信息见 `UPSTREAM.md`。
