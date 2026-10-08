# pi-distill

> **保留原文，把上下文留给决策。**

一个工具结果处理入口，两种互斥策略：按 `outputRequest` 生成**普通摘要**，或通过显式启用的**诊断证据提取**保留原文引文。证据机制改编自 NVIDIA [SoL-Pi](https://github.com/NVlabs/SoL-Pi)。任何被接受的有损替换都先归档来源；需要核实时使用 Pi 原生 `read`，不新增摘要或回读工具。

> English: [README.md](./README.md)

## 安装与启用

```bash
pi install npm:pi-distill
```

包会同时加载共享 i18n 扩展。运行 `/reload`，再通过 `/config:distill` 选择模型和配置处理。`/pi-distill` 是兼容别名；`/distill:stats` 显示本会话结果、尝试次数、用量、预计上下文节省和成本。交互式命令需要带 UI 的会话，工具结果处理也支持无界面运行。

配置位于 `<Pi agent 目录>/extensions/pi-distill/config.json`，通常在 `~/.pi/agent` 下，支持 `PI_CODING_AGENT_DIR`。加载时不写配置，不迁移或修改用户全局设置。默认配置见 [config.example.json](./config.example.json)。

**证据模式与 Fusion 日志处理默认关闭。**明确开启诊断证据时配置：

```json
{
  "evidence": {
    "enabled": true,
    "fusion": true,
    "minBytes": 8192,
    "commands": []
  }
}
```

`fusion: true` 额外允许处理 Action Fusion `edit/write` 追加的命令日志，不负责启用 Action Fusion。明确的 `tools.edit.enabled: false` 或 `tools.write.enabled: false` 优先。交互式设置提供这两个证据开关；字节配额和附加命令前缀在 JSON 中配置。

## 处理链路

```text
工具返回真实结果
  ├─ 关闭 / RAW / 非文本 / 排除范围 → 保留原结果
  └─ 确定一个处理范围和一种策略
       ├─ 识别出的诊断命令 → 证据提取（已开启时）
       └─ 其他已启用文本＋outputRequest → 普通摘要
            ↓ 检查大小、完整性、疑似敏感内容
            ↓ 模型调用前先归档原文
            ↓ 模型处理和本地校验
            ├─ 合法、未超预算且有收益 → 处理结果＋来源引用
            └─ 失败 / 取消 / 收益不足 → 保留原结果
```

证据失败不会降级为普通摘要，已处理的收据不再处理。Distill 不改变命令执行、文件修改或工具错误状态；通过原生 `tool_call/tool_result` 接入，不注册替代工具。事件按扩展顺序执行，因此来源是 Distill 实际收到的结果，不能恢复其他扩展已经丢掉的内容。

## 工具 schema 与 RAW

普通已启用 object-schema 工具保留必填、非空的 `outputRequest`。未配置的非修改工具仍按旧版默认开启，通过 `tools.<name>.enabled: false` 排除；启用证据不会暗中重置这份工具范围。

```json
{
  "command": "npm run test",
  "outputRequest": "保留失败用例、断言差异和最终统计"
}
```

去除首尾空白后严格为 `RAW`（不区分大小写）时跳过两种策略，**保留收到的工具 content**，不是无限制的进程全文；底层工具自己的限制仍然存在。RAW、禁用和失败回退不再被 Distill 截断或改成文件指针，即使 `maxOutputChars` 配得很小也不会截断它们。自定义工具仍需自行限制输出；保留超大回退结果仍可能超过主模型上下文。

明确启用证据和 Fusion 时，暴露 `then_run` 的兼容 `edit/write` 获得**可选** `outputRequest`：省略则用默认证据规则，RAW 跳过，其他文本指定关注重点。它只作用于命令日志；普通修改结果永不摘要，即使存在旧版 `tools.edit/write.enabled: true` 设置。Distill 仅捕获并移除已成功注入且仍由自己拥有的处理字段；原工具已有同名 `outputRequest` 时警告并保持原状，不删除禁用工具的同名业务字段。

非文本或混合媒体结果不处理。扩展禁用时不向系统提示词添加处理契约。

## 两种策略的区别

### 诊断证据

保守命令识别覆盖常见测试、构建、检查命令，包括 `npm run test/build`、`test:unit` 脚本、pnpm/yarn/bun、pytest/unittest、Go/Cargo 和原生构建工具。支持简单的非引号命令边界及常见包装，不解释任意 shell 程序。复合命令必须每段均为诊断或有限的无输出准备（`cd`、环境变量赋值、`true`、`:`）；`npm test; cat confidential.txt` 不进入自动证据策略。`echo 'npm test'` 等引号示例、命令替换和 heredoc 不自动认定为诊断。`evidence.commands` 添加字面 token 前缀，**不是可执行正则**；使用规范化后的可执行文件名，例如 `./verify --ci` 对应 `"verify --ci"`。

固定双语提示词要求连续原文引文。`outputRequest` 只能选择关注重点，不能取消固定约束；处理模型不生成诊断或修复建议。证据策略只请求一次，不做 JSON 修复，不使用普通摘要的重试预算。校验 schema、数量/长度、引文原文匹配和必要的可识别失败证据；零失败统计不能冒充失败证据。工具状态成功但日志包含强失败信号时也要求保留失败证据。行号在本地计算，哈希、路径和观察到的工具错误状态由代码生成，不让模型编造。

结果带 `[distill:evidence]`。**引文真实不证明覆盖完整、分类正确、因果关系正确或测试全部通过。**`|| true` 等命令可以掩盖测试失败；模型的不确定性只是建议，不是完整性证明。

### 普通摘要

其他启用文本仍按 `outputRequest` 处理，保留现有 RAW/SUMMARY 协议、重试预算和一次 JSON-only 格式修复。结果带 `[distill:summary]`，明确声明**未在本地逐项核验事实**。归档增强的是追溯能力，不是摘要正确性。

两种策略按完整投影结果（含来源及受保护修改确认）计算收益，要求至少 **1.4 倍字符压缩**，并满足正文及完整结果预算。字符节省不是精确 tokenizer 节省。下面旧版真实会话截图中的 213.40 倍压缩发生在来源收据引入之前，仅说明合适冗长输出的潜力，不是此版本的保证。

![历史上下文节省示例](./assets/context-savings-example.png)

## 原文与原生 read 回读

每次被接受的摘要或证据都提供模型可见来源：

```text
source_artifact="/…/extensions/pi-distill/artifacts/<会话哈希>/objects/<原文哈希>.txt"
source_sha256=…
source_bytes=…
source_lines=4200
source_kind=tool-output
```

调用时使用不含 JSON 引号的真实路径：

```json
{
  "path": "/…/objects/<原文哈希>.txt",
  "offset": 200,
  "limit": 60,
  "outputRequest": "RAW"
}
```

仅在当前 `read` schema 暴露该字段时提供 `outputRequest`。行号从 1 开始；最后 N 行可一次定位：`offset = max(1, source_lines - N + 1)`，`limit = N`。行数沿用原生 read 的换行切分语义，包括末尾空行；read 自身行数/字节限制仍有效。

工具提供的有界、普通、单链接且非符号链接临时文件可以作为更完整来源。Bash/Fusion 仅接受操作系统临时目录直属的原生 `pi-bash-*.log`，或错误标准化后原生格式的最终截断提示。不合法、不存在、过大或变化中的文件会回退原结果。已知截断且无法取得完整日志时不做证据替换；其他文本可作为 `source_kind=preview` 摘要，但不能冒称全文。来源是 Pi 提供的 UTF-8 文本；完整文件含非法 UTF-8 时拒绝，不默默改写。

Fusion 仅处理 `[then_run:succeeded]` 或 `[then_run:failed]` 后的命令日志。修改确认、成功结果的 diff/patch metadata、机器标记和外层错误状态不变；跳过、执行中、缺失或边界歧义则不处理。Pi 对失败调用抛出的错误进行标准化后，可能本就没有 diff details，Distill 无法恢复。支持 `details.actionFusion.bashDetails`，不导入 Fusion 私有源码。

## 存储、隐私与回退

原文存于 agent 目录，不写项目。会话 ID 和内容经哈希成为路径；原子发布、内容去重并核验完整性，支持的平台使用私有权限。限制单条来源字节数和恢复后会话对象累计大小。归档失败或配额用尽时不发送模型请求，保留原结果。重新加载、恢复会话和正常退出不会删除归档；确认引用不再需要后，由用户明确执行文件清理。

默认单条 1 MiB、单会话 64 MiB。写入同时使用进程内序列化和会话文件系统独占锁。取消可立即中断进程内队列等待，但不会让后续写入越过尚未完成的写入。锁被占用时不等待、不发送模型请求，保留原结果；进程崩溃遗留的锁不会自动夺取，确认没有活跃写入后再明确清理。遗留 staging 和对象目录内其他普通文件也计入配额，不静默删除。会话配额不是全局保留策略；文件系统不支持所需原子链接时保留原结果，不弱化完整性保证。

处理可能把来源发送给当前或配置模型；两种策略都会跳过疑似凭据，但启发式检测**不是完整的隐私保证**。关闭处理或选择本地处理模型可避免额外的远程接收方，但不会脱敏原工具结果，也不会阻止主 Agent 将它发送给自己的模型；要求所有日志留在本机，还需使用本地主模型并合理配置工具。归档也可能含敏感文本。不要与独立 SoL-Pi Reducer 或重叠的结果摘要扩展同时运行。

父请求取消会传播到模型请求。超时限制的是 Distill 等待时间，不保证忽略取消信号的 provider 停止远程执行或计费；前一个请求是否终止尚未确认时，不启动超时重试。已报告的用量计入 Pi 工具结果成本，包括被拒绝的证据和失败的 JSON 修复。即使修复请求挂起，首次响应已报告的用量也会保留；挂起请求从未报告的用量无法恢复。请求前通过启发式 token／模型上下文窗口检查跳过明显超预算输入。证据失败永不降级为未核验摘要。每次请求由模型注册表统一解析认证和地址，不额外执行鉴权预检查；Codex 后台请求使用独立会话并在请求完成后清理。

## 配置项

| 配置项 | 含义 |
| --- | --- |
| `enabled` | 是否启用；关键配置（包括格式错误的工具关闭设置）无效时停止处理，需手动修复。 |
| `model` | 可选 `provider/modelId`，空值使用当前会话模型。 |
| `minChars` | 普通摘要输入阈值，默认 200 字符。 |
| `maxChars` | 被接受的摘要/证据正文预算，默认 100,000 字符；超出保留原结果。 |
| `maxOutputChars` | 完整替换结果预算（含来源），默认 10,000；不是 RAW/回退限制。 |
| `timeoutSeconds` | 每次模型尝试截止时间，默认 10 秒。 |
| `timeoutRetryCount/errorRetryCount` | 普通摘要的超时/其他异常重试，默认各 1 次；证据始终只尝试一次。 |
| `missedCompressionRatio` | 保留的兼容配置字段。 |
| `summarizeErrors` | false 时两种策略都不处理错误，包括明确请求的长错误。 |
| `evidence.enabled` | 诊断证据策略，默认 false。 |
| `evidence.fusion` | 融合命令范围，默认 false；依赖证据已开启。 |
| `evidence.minBytes` | 证据输入阈值，默认 8,192 个 UTF-8 字节。 |
| `evidence.commands` | 最多 32 个附加字面命令前缀，每项不超过 256 字符。 |
| `archive.maxSourceBytes` | 默认 1 MiB，最多 16 MiB；过大来源不发送模型。 |
| `archive.maxSessionBytes` | 默认 64 MiB，最多 1 GiB；不静默驱逐归档。 |
| `tools.<name>.enabled` | 现有工具开关；修改工具仍需明确开启证据/Fusion。 |
| `render.*` | UI-only 审计卡片、请求和结果预览。 |

文件字段优先于现有 `PI_DISTILL_*` 和旧版 `PI_BASH_SUMMARY_*`；证据与归档配置仅支持 JSON。不自动改写或迁移全局配置。Fusion 开关仅控制兼容 Fusion 工具的日志处理及 schema，不是 Bash 权限沙箱。

## 开发与来源

要求 Node.js 22+ 和 Pi 0.87.1+。Pi peer 最低版本与已测试的模型注册表、会话资源及工具用量 API 对齐，不再声明兼容 0.80–0.86。开发和离线 SDK 回归针对 Pi 0.87.1。确定性测试使用注入 provider、临时存储及原生 read，无需 API Key。

```bash
npm run typecheck --workspace pi-distill
npm test --workspace pi-distill
```

提示词和通知跟随共享语言设置；UI 审计不进入模型上下文。SoL-Pi 改编代码的 MIT 授权及归属见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 和 [LICENSE](./LICENSE)。
