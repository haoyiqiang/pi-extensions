# pi-context-view

用于 [Pi](https://pi.dev) 的上下文可视化扩展。它显示上下文窗口的组成，并允许检查通常不可见的内容，包括系统提示、工具定义、技能和其他扩展注入的指令。

## 功能

- **上下文用量图**：按工具、技能、消息等类别显示已用和剩余空间。
- **上下文注入检查**：浏览初始系统提示、工具定义和扩展注入。
- **无常驻上下文开销**：扩展不会向模型上下文添加指令或普通消息。
- **安全降级**：无法执行静默探测时，使用 Pi 原生信息生成可用视图。

## 安装

```bash
pi install npm:pi-context-view
```

也可以安装整个扩展仓库：

```bash
pi install git:github.com/maplezzk/pi-extensions
```

安装后执行 `/reload` 或重启 Pi。

## 命令

- `/context`：等同于 `/context usage`。
- `/context usage`：打开上下文用量图。
- `/context injections`：显示会话开始或恢复时捕获的隐藏上下文。
- `/context config`：在配置文件不存在时创建默认配置。

用量和注入视图只支持 TUI 模式。若在第一次真实模型回合前打开视图，扩展会执行一次无指令的静默探测。探测消息不会保留在后续模型上下文中。

## 配置

运行：

```text
/context config
```

默认文件位置：

```text
~/.pi/agent/extensions/pi-context-view.json
```

当前可以配置：

- `categoryColors`：各上下文类别的主题颜色或十六进制颜色。
- `mapSize`：用量图的行数和列数。

字段、默认值和示例见 [`doc/CONFIG.md`](./doc/CONFIG.md)。手动修改后执行 `/reload`。

## 工作方式

扩展优先被动捕获第一次真实模型请求的上下文。若尚未捕获，它会在用户打开视图时尝试一次静默探测。没有可用模型、没有鉴权或正在压缩时，扩展不会强行启动探测，而是回退到 Pi 原生 session context。

## 开发

从仓库根目录运行：

```bash
npm install
npm run typecheck --workspace pi-context-view
npm test --workspace pi-context-view
npm run check --workspace pi-context-view
```

## 来源

本包基于 Dmitry Makarov 的 [`pi-context-view`](https://github.com/dimk90/pi-context-view)，现由本仓库统一维护和发布。

## 许可证

[MIT](./LICENSE)
