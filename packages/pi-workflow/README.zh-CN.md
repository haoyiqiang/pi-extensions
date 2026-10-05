# @maplezzk/pi-workflow — 私有工作流集成

> English documentation: [README.md](./README.md)

这是从 [`@juicesharp/rpiv-workflow` 2.12.0](./UPSTREAM.md) 导入的**独立工作流引擎**，
负责阶段/循环 DSL、谓词路由、产物收集与校验、重试、JSONL 审计日志、恢复及 `/wf`。
子代理生命周期与执行后端属于 `pi-subagents`，不会合并进本包。

**私有、显式启用**：本包与新的子代理执行入口都不加入根 Pi profile 或发布配置，现有
interactive-subagents 产品保持不变。这不是完整 RPIV 套件、默认工作流、技能、扩展工具
或 lane UI 的即插即用替代品。

## 架构

```text
pi-workflow：DSL / 编排引擎 / 日志 / /wf / 执行配置
    │  pi-workflow:executor:discover:v1（Pi 事件总线）
    ▼
pi-subagents/workflow-executor：受管生命周期与已存策略
    ├─ embedded：隔离的进程内 Pi SDK 会话
    └─ terminal：隔离的 Pi CLI 子进程 → pi-terminal-mux
```

两包没有跨产品运行时依赖，不导入彼此的私有源码。执行器通过同步、版本化协议发现；缺少
执行器或存在多个匹配项时明确失败，不回退到主会话执行。executor-only 入口不会加载保留的
上游 `SubagentWorkflow` 引擎或 Agent UI。

程序化调用者仍可提供自己的 host。startup 注册接口通过独立 token 保证注销所有权；真正
执行的 runner 每次传入自己的取消错误工厂，并等待执行资源退役。运行头记录执行器身份，
它与子会话策略、模型凭据相互独立。

## 开发时显式启用

在仓库根目录执行 `npm install` 后，于可信的开发会话中**显式加载以下文件**：

```sh
pi -e ./packages/pi-extensions-i18n/index.ts \
   -e ./packages/pi-subagents/workflow-executor.ts \
   -e ./packages/pi-workflow/extension.ts
```

不要为了运行工作流而加载 `pi-subagents/index.ts`：它是保留的旧产品工厂，会注册另一套
工具/UI。上面的 i18n 入口用于带来源标签的通知；此操作不改写 settings 或根 profile。

本包**不附带默认工作流**。可在项目 `.rpiv/workflows/config.ts` 中定义：

```ts
import { acts, defineWorkflow } from "@maplezzk/pi-workflow";

export default defineWorkflow({
  name: "inspect",
  start: "review",
  stages: {
    review: acts.prompt({ prompt: "检查当前改动并总结风险。" }),
    check: acts.prompt({
      prompt: "复核这些发现，指出还缺少哪些验证。",
      sessionPolicy: "continue",
    }),
  },
  edges: { review: "check", check: "stop" },
});
```

使用 `/wf inspect 检查当前改动` 运行。continue 阶段分叉前一阶段的已存历史，不在主会话
中执行。保留的命令语法也支持 `/wf @<run-id-or-name>` 恢复。继承的 DSL 与完整语法见
[基础文档](./docs/workflow-basics.md) 和[编写参考](./docs/workflow-authoring.md)；
其中提及的上游宿主/UI 并不代表受管执行配置已提供相同功能。

### 取消运行

`/wf-cancel` 在只有一个活动运行时取消它；存在多个运行时则列出运行 ID。
用 `/wf-cancel <run-id>` 选择一个，或 `/wf-cancel all` 取消当前全部运行。
尚在获取执行器的运行也可取消。命令会等待已知资源退役；清理失败时明确报告，而不声称
已正常停止。这不改变 `/wf` 的解析规则，也不占用 lane/widget 界面。切换或关闭所属
Pi 会话也会取消其受管执行。

## 执行配置

配置示例见 [`config.example.json`](./config.example.json)，每次运行时重新读取：

- 全局：`<agentDir>/extensions/pi-workflow/config.json`。
- 项目：`<cwd>/.pi/pi-workflow.json`。
- agent 目录通过 `pi-extensions-config` 解析，支持 `PI_CODING_AGENT_DIR`。

```json
{
  "execution": {
    "executor": "pi-subagents",
    "backend": "embedded",
    "agentType": "general-purpose",
    "maxConcurrency": 4
  },
  "skills": [],
  "requiredTools": []
}
```

项目 execution 按字段覆盖全局值；项目 `skills`、`requiredTools` 各自整体替换全局数组。
未知字段、损坏文件、错误类型/后端以及无效正整数限额均明确拒绝。可选
`execution.maxTurns` 设置子会话轮次预算。`backend: "terminal"` 选择独立自主完成型
CLI 子进程，不是长期等待人工交互的终端会话。terminal 暂不支持原生 Windows；子进程
可见的 provider/model 配置和凭据必须与所请求模型匹配。

恢复使用日志中保存的后端，即使配置已改变新运行的默认后端，也不会转换既有会话。
已有子会话继续遵守保存的模型、思考等级、工具、提示词及轮次策略。

### 显式批准技能

每条批准记录包含 `name`、`filePath`、`baseDir` 和 `format`（`pi` 或
`positional-v1`），可选 `requiredTools`、`expectedSha256`。相对文件/基础目录路径
以**定义该记录的配置文件所在目录**解析，不以进程工作目录解析。只读取明确批准的指令，
不自动发现环境中的技能、提示模板或扩展。

指令快照、规范资源元数据与解析器身份绑定到受管会话策略。批准集合、指令或工具需求
发生变化时，恢复会在模型请求或获取写租约之前拒绝。配套脚本和素材仍是**实时文件**；
这不是完整不可变资源包，也不是操作系统沙箱。`requiredTools` 只是最低需求，不授予权限。
目前受管执行只使用内置工具，不自动启用嵌套 Agent、问答、顾问或网页扩展工具。
完整语义与限制见 [workflow 资源](../pi-subagents/docs/workflow-resources.md)。

## 存储与上游兼容性

不自动迁移现有存储：

- 项目定义/配置包：`.rpiv/workflows/config.ts` 和 `packs/*.ts`。
- 用户定义/配置包：`$XDG_CONFIG_HOME/rpiv-workflow/`，默认
  `~/.config/rpiv-workflow/`。
- 运行日志：`.rpiv/workflows/runs/`，保留 schema 版本 3，增加可选执行身份。
- 受管子会话位于各运行的 `sessions/managed` 目录，日志保存准确文件路径；
  不将原有顶层裸 JSONL 清理改为递归清理。

jiti 加载器**仅在配置/配置包求值时**，把 `@maplezzk/pi-workflow` 与旧名
`@juicesharp/rpiv-workflow` 的公开子路径解析到本地引擎，并非额外安装旧产品。
定义是具有宿主权限的可执行 TypeScript，加载不可信仓库前务必审查。保留的旧全局注册表
用于导入兼容；不要在同一进程中再加载另一份上游工作流实现。

支持干净受管会话的 reattach/fork；不会静默接管裸旧 JSONL、崩溃/隔离中的写入者、
不兼容的模型策略，也不会模拟 RPIV shell/runtime 替换或任意扩展工具。

## 入口与验证

| 入口 | 用途 |
| --- | --- |
| 包根入口 | 引擎 API，不导出默认扩展工厂 |
| `/registration` | DSL、加载器、校验器和 host 契约 |
| `/startup` | 轻量生命周期/执行注册 |
| `/runner` | 运行与恢复 API |
| `/internal` | 私有测试/重置工具 |
| `./extension.ts` | 显式加载的 Pi `/wf` 前端 |

```sh
npm run typecheck --workspace @maplezzk/pi-workflow
npm test --workspace @maplezzk/pi-workflow
npm run check
```

要求 Node.js 22+，Pi 开发版本为 0.87.1。测试隔离 HOME/agent 目录，使用脚本化 host/model；
真实 SDK/CLI 后端一致性测试位于 subagents 工作区，不需要 API 凭据、在线模型、mux 守护
进程或外部源码目录。真实 provider 与可见终端复用器仍需人工冒烟验证。继承的内部引擎诊断
仍在单独迁移；私有状态不代表产品本地化已全部完成或已可发布。

## 许可证

[MIT](./LICENSE)。准确上游提交、归属、保留的测试/文档与本地差异见
[UPSTREAM.md](./UPSTREAM.md)。
