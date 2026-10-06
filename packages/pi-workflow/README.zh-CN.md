# @maplezzk/pi-workflow — 独立工作流引擎

> English documentation: [README.md](./README.md)

从 [`@juicesharp/rpiv-workflow` 2.12.0](./UPSTREAM.md) 导入，保留阶段/循环 DSL、
路由、输出校验、重试、审计日志、恢复和 `/wf`。执行与子代理生命周期属于 `pi-subagents`。

Git／本地根 profile 已**默认加载本产品和统一 `pi-subagents`**。npm 包仍为私有，
不进入发布配置；启用运行入口不代表已经发布。它不安装完整 RPIV 套件、默认工作流包、
技能、工具扩展或 lane UI。切换既有环境前请阅读[迁移指南](../pi-subagents/docs/migration.zh-CN.md)。

## 架构

```text
pi-workflow：DSL / runner / 日志 / /wf
    │  pi-workflow:executor:discover:v1
    ▼
pi-subagents：标准 SDK WorkflowHost
    └─ 阶段 AgentSession，使用正常且已授权的 Pi 资源
        └─ Agent → 统一子代理运行时 → embedded 或 terminal
```

默认 `standard` 配置沿用原 RPIV host 的结构：阶段会话仍由 SDK 创建，阶段内的 Agent
通过 `subagents.json` 选择后端，工作流不再是唯一能切换子代理后端的入口。宿主保留正常
技能/模板/扩展行为、首次提示、原始 Pi 会话恢复、continuation 分叉、模型/思考等级覆盖、
嵌套作用域和 bash 超时恢复。

两包没有跨产品运行时导入。执行器发现保持版本化，缺少或重复的执行器明确失败。
统一产品入口不加载旧 `SubagentWorkflow` 引擎或旧交互式子代理工具别名。

## 默认与选择性启用

将本仓库安装为 Pi package 会默认加载两个统一产品。只需选择性启动时，在仓库根目录
执行 `npm install` 后运行：

```sh
pi --no-extensions \
  -e ./packages/pi-extensions-i18n/index.ts \
  -e ./packages/pi-subagents/index.ts \
  -e ./packages/pi-workflow/extension.ts
```

不要再加载旧 interactive-subagents 产品。只需要工作流的启动器可以把
`pi-subagents/index.ts` 换成 `pi-subagents/workflow-executor.ts`；不要同时加载这两个
执行入口。后者提供子会话内的 Agent 工具，不加载根管理界面。主会话所需的其他工具扩展
可以另外添加。

本包不附带默认工作流包。项目 `.rpiv/workflows/config.ts` 示例：

```ts
import { acts, defineWorkflow } from "@maplezzk/pi-workflow";

export default defineWorkflow({
  name: "inspect",
  start: "review",
  stages: {
    review: acts.prompt({ prompt: "检查当前改动并总结风险。" }),
    check: acts.prompt({
      prompt: "复核这些发现，指出缺少的验证。",
      sessionPolicy: "continue",
    }),
  },
  edges: { review: "check", check: "stop" },
});
```

使用 `/wf inspect 检查当前改动` 运行，或 `/wf @<run-id-or-name>` 恢复。
continue 阶段分叉前一阶段，不替换主会话自身的对话。另见[基础文档](./docs/workflow-basics.md)
和[编写参考](./docs/workflow-authoring.md)。

## 配置

每次运行读取：

- `<agentDir>/extensions/pi-workflow/config.json`；
- `<cwd>/.pi/pi-workflow.json`，项目层覆盖全局层。

agent 目录支持 `PI_CODING_AGENT_DIR`。[配置示例](./config.example.json) 展示正常模式和
模型级联；其中模型键占位符需替换为 Pi 实际可用的模型：

```json
{
  "execution": {
    "executor": "pi-subagents",
    "profile": "standard",
    "maxConcurrency": 4
  }
}
```

可选 `models` 配置阶段的模型与思考等级覆盖：

```json
{
  "models": {
    "defaults": { "model": "provider/default-model", "thinking": "medium" },
    "stages": { "review": { "thinking": "high" } },
    "skills": { "quick-check": "provider/fast-model" },
    "presets": {
      "inspect": {
        "stages": { "review": { "model": "provider/review-model", "thinking": "off" } }
      }
    }
  }
}
```

每个叶子可以是模型字符串，也可以是 `{ "model"?, "thinking"? }`；`thinking` 支持
`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。解析按首个匹配层级：
`presets.<workflow>.stages.<stage>`、`stages.<stage>`、`skills.<skill>`、`defaults`。
选中的一个叶子会与 `defaults` 组合；互相竞争的 preset/stage/skill 叶子不会跨层按字段合并。

项目层按键覆盖全局模型配置：项目 `defaults` 存在时整体替换全局 `defaults`；`stages`、
`skills` 按条目名合并；`presets` 按 workflow 和 stage 合并，同名项目叶子替换全局叶子。
如果没有解析到任何模型配置，新的 standard 子会话使用 SDK 原生 settings 基线，而不会
强制继承启动会话当前选择的模型或思考等级。

要让委派的代理使用终端，请配置**子代理**，而不是阶段放置位置：

```json
{ "backend": "terminal" }
```

把它写入 `.pi/subagents.json`，或使用 `/config:subagents terminal`。
标准运行会记录所选委派后端，恢复时继续使用它，不转换已有会话的后端。

`requiredTools` 表示最低工具需求，不授予权限。标准子会话检查实际激活的工具。
资源必须已安装，并遵守启动器确认的项目授权；根编排/UI 产品从阶段会话中排除，普通工具
扩展仍可发现。RPIV 专有参数替换需要对应资源扩展，本引擎不模拟它，也不附带全部辅助文件。

可选 `execution.maxTurns` 限制阶段轮次。bash 看门狗保留 `RPIV_BASH_TIMEOUT_MS`：
默认每条命令 180 秒，限制在 5 秒至 30 分钟之间。它提供原有
`toolTimeout/resetToolTimeout` 恢复接口，不把命令超时伪装成普通用户取消。

### 显式使用 managed

已有的受限隔离模式需要显式选择：

```json
{
  "execution": {
    "profile": "managed",
    "backend": "terminal",
    "agentType": "general-purpose",
    "maxConcurrency": 4
  },
  "skills": [],
  "requiredTools": ["read", "bash"]
}
```

在此模式中，`execution.backend` 决定阶段自身放置位置，`agentType` 选择代理定义。
`skills` 保存批准的指令快照：`name`、`filePath`、`baseDir`、`format`（`pi` 或
`positional-v1`），以及可选 `requiredTools`、`expectedSha256`。相对路径以配置文件所在
目录解析；项目技能/工具需求数组整体替换全局数组。

managed 仍只接入内置工具，不自动激活环境资源；保留已存策略、资源绑定、租约和检查点
恢复。裸旧 JSONL 不是受管会话。这些限制**不施加到 standard SDK 模式**。
详见[受管资源](../pi-subagents/docs/workflow-resources.md)。

## 取消与生命周期

- `/wf-cancel` 取消唯一活动运行，存在多个时列出 ID。
- `/wf-cancel <id>` 选择一个，`/wf-cancel all` 取消当前全部运行。
- 冷启动命令加载和等待获取执行器的阶段也可取消。
- 浏览树或被取消的导航尝试不终止后台运行。standard 运行可跨主会话
  new/resume/fork 继续，新的根会话接管取消入口；managed 在实际替换时退役。
  quit/reload 关闭全部所属执行。

取消被观察到后，runner 立即封锁普通日志写入，迟到的脚本或生命周期回调不能再在终态后
追加成功/路由记录。异步 script/prompt 作者可通过新增的 `ScriptContext.signal`
协作取消 I/O。JavaScript 无法强制终止任意不合作的作者代码；runner 会停止等待并封锁其
后续推进。

报告成功前会等待执行器退役。退役失败时，持久化的 `run-terminal/cleanup-failed` 记录
覆盖仅从阶段推导出的成功；自动恢复会拒绝该运行，而不是重放已经成功的副作用。
请先检查失败和剩余资源，再决定下一步操作。

## 存储与迁移

保留原有布局：

- 项目定义/包：`.rpiv/workflows/config.ts` 和 `packs/*.ts`；
- 用户定义/包：`$XDG_CONFIG_HOME/rpiv-workflow/`，默认 `~/.config/rpiv-workflow/`；
- 日志：`.rpiv/workflows/runs/`，schema v3，包含可选执行身份及增量清理失败记录。

标准阶段使用原生 Pi JSONL，可以打开已有原始阶段会话。受管子会话继续位于各运行的
`sessions/managed`，不会把 orphan 清理扩展成递归删除租约和 sidecar。

配置/包求值期间，jiti 把 `@maplezzk/pi-workflow` 和旧
`@juicesharp/rpiv-workflow` 公开子路径解析到本引擎，而不是安装第二套上游运行时。
定义以宿主权限执行，加载不可信仓库前应先审查。不要在同一进程同时加载另一个工作流引擎。

## 入口与检查

包根是程序化引擎 API，`/registration`、`/startup`、`/runner`、`/internal` 保持原有职责，
`./extension.ts` 是 Pi 前端。程序化调用者仍可提供自己的 host/provider。

```sh
npm run typecheck -w @maplezzk/pi-workflow
npm test -w @maplezzk/pi-workflow
npm run check
```

要求 Node.js 22+，开发时使用 Pi 0.87.1。确定性检查使用临时配置和脚本化模型，不依赖凭据或
在线服务。真实 provider 与可见终端行为另需冒烟验证。

[MIT](./LICENSE)。来源和本地变更记录见 [UPSTREAM.md](./UPSTREAM.md)。
