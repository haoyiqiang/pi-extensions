# @kevinhao/pi-models-discovery

通用模型发现插件：读取 `~/.pi/agent/models.json` 中带 `"discoverModels": true` 的 provider，请求 `GET {baseUrl}/models` 自动发现模型并注册，无需手写 `models` 数组。

实现上注册一个完整的 pi `Provider`（不是 legacy provider 配置），目录状态全部交给 pi：`refreshModels` 用 `context.stored` 恢复上次目录、用 `context.credential` 与 `context.signal` 发请求，并通过 `context.publish({ persist })` 写回 pi 自己的 `models-store.json`。没有扩展私有缓存文件，也不需要手动刷新命令——pi 在交互启动后与每次打开 `/model` 时会自行刷新。

适合本地/自建 LLM 代理（一个网关暴露多个模型）、Ollama、vLLM 等 OpenAI 兼容服务。

## 安装

```bash
pi install npm:@kevinhao/pi-models-discovery
```

## 配置

### 方式一：pi 终端内交互配置（推荐）

```
/config:model-discovery
```

交互式添加 / 删除 / 重新发现 provider：输入 id、baseUrl、api 类型、apiKey（可留空）、显示名（可留空），确认后写入 models.json 并**立即生效**（无需 /reload）。写入前自动备份到 `models.json.discovery-bak`。

注意：写回时 models.json 中的注释与自定义排版不被保留（会格式化为 4 空格缩进）。

### 方式二：手编 models.json

在 `~/.pi/agent/models.json` 的 provider 上加 `"discoverModels": true` 标记：

```json
{
  "providers": {
    "llm-proxy": {
      "name": "LLM Proxy",
      "baseUrl": "http://127.0.0.1:9000/pi/v1",
      "apiKey": "sk-1234",
      "api": "openai-completions",
      "discoverModels": true
    }
  }
}
```

`baseUrl` 和 `api` 必填；`api` 可以是 pi 实现的任意 api——常见的是 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`（交互式配置提供的四个选项），也支持 `azure-openai-responses`、`google-vertex`、`mistral-conversations`、`bedrock-converse-stream`、`openai-codex-responses`、`pi-messages`。`apiKey` 可选（无鉴权服务可省略），支持字面量与 `$ENV_VAR` / `${ENV_VAR}` 插值。`!command` 由 pi 执行，解析后的 key 会通过 `context.credential` 进入每次刷新；只有加载期的冷启动请求无法执行命令——它会告警，把目录留给下一次刷新。

手编方式修改配置后需 `/reload` 生效；`/config:model-discovery` 命令的修改立即生效。

### 发现过滤与统一默认值

当 `/models` 同时返回图片模型、不同协议模型或网关私有条目时，可用 `modelDiscovery.include` / `exclude` 按模型 ID glob 过滤，并用 `defaults` 补充 `/models` 不提供的统一能力元数据：

```json
{
  "providers": {
    "llm-proxy": {
      "name": "LLM Proxy Responses",
      "baseUrl": "https://proxy.example.com/v1",
      "api": "openai-responses",
      "authHeader": true,
      "discoverModels": true,
      "modelDiscovery": {
        "include": ["gpt-5.6-*", "gpt-6-*"],
        "exclude": ["gpt-image-*"],
        "defaults": {
          "reasoning": true,
          "thinkingLevelMap": {
            "off": null,
            "minimal": "low",
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh",
            "max": "max"
          },
          "input": ["text", "image"],
          "contextWindow": 1050000,
          "maxTokens": 128000,
          "compat": {
            "supportsDeveloperRole": false,
            "supportsStrictMode": false
          }
        }
      }
    }
  }
}
```

`include` / `exclude` 是整串 glob，支持 `*` 和 `?`；先应用 include，再应用 exclude。`defaults` 支持 `reasoning`、`thinkingLevelMap`、`input`、`contextWindow`、`maxTokens` 和 `compat`。`/models` 对单个模型返回的 `context_window` / `max_tokens` 优先于 defaults；models.json 的标准 `modelOverrides` 仍可覆盖具体模型。

## 刷新目录

刷新由 pi 驱动，无需手工命令：

- **交互启动**：恢复 `models-store.json` 中的目录，然后拉一次 `GET /models`，并把结果持久化。
- **打开 `/model`**：再刷新一次并用新结果重绘选择器，所以网关上新增的模型在下次打开选择器时就会出现。
- **`pi -p`、subagent 等无刷新路径**：读取 pi 已持久化的 `models-store.json`。只有该 provider 还没有可用目录时，扩展才在加载期发一次请求（`PI_OFFLINE` 时跳过），并把这份冷启动结果交给 pi 在第一次刷新时持久化，避免每次运行都重拉。

`/config:model-discovery` → *Add provider* / *Rediscover models* 走同一条 `modelRegistry.refresh({ providers, allowNetwork: true, force: true })` 路径，复用 pi 的凭据解析与持久化，不再自己拉取。

## 行为

- **目录归属**：扩展在内存里持有发现的列表，并按 pi 的 `stored` 目录恢复；持久化由 pi 的 `models-store.json` 负责，扩展从不写它。恢复时只保留 `baseUrl`、`api` 与当前 include/exclude 仍匹配的模型，配置变更后不会继续显示过期条目。
- **配置变更**：手编 models.json 需 `/reload` 生效，pi 下一次刷新会重新发现；`/config:model-discovery` 写文件、注册 provider，并强制一次 provider 级刷新。
- **恢复的元数据**：从 `models-store.json` 恢复的目录保留发现时的元数据。端点、`api`、收窄/删除过滤规则会立即作废旧条目；修改 `defaults`、`compat` 需要等下一次网络刷新（交互启动或打开 `/model`）才体现；模型 `headers` 立即生效，`!command` 形式的 header 由 pi 在请求时解析，发现请求会跳过它。
- **离线 / 拉取失败**：拉取失败保留上一份目录（pi 会在模型选择器里显示该 provider 的错误），models.json 里手写的 `models` 仍然生效；单个 provider 失败不影响其他 provider。
- **鉴权**：provider 的 `ProviderAuth` 只消费 pi 组合好的凭据（`context.credential`，覆盖 `auth.json`、models.json 的 `apiKey` 与 `!command`），不重复解析；完全没有凭据时按“无鉴权服务”上报为可用，所以本地无 key 端点也能被 pi 刷新。只有加载期的冷启动请求会自己解析（models.json 的 `apiKey`，其次 `auth.json`）。
- **任意 api**：流式实现全部委托 pi 的 api registry，因此 pi 支持的 api 都能用（`openai-*`、`anthropic-messages`、`google-*`、`azure-openai-responses`、`mistral-conversations`、`bedrock-converse-stream` 等）；pi 不支持的 api 仍会注册，等请求时报错，与 legacy 形态一致。
- 发现的模型默认参数：`reasoning: true`、`input: ["text", "image"]`、cost 全 0、`contextWindow` 1M、`maxTokens` 64K、`compat.supportsDeveloperRole: false`；provider 级 `compat` 与 `modelDiscovery.defaults` 会合并进每个发现的模型。
- 发现的模型声明 `thinkingLevelMap: { xhigh: "xhigh", max: "max" }`，让 `xhigh` / `max` 出现在 `/thinking`；标准档位保持缺省，仍由 pi 的 provider 默认映射决定。`/models` 无法逐个模型返回思考能力，所以这是对所有发现模型一刀切的默认值：某个 provider 拒绝这些档位时，在 models.json 的 `modelOverrides` 里按 model.id 覆盖（把 `xhigh` / `max` 置 `null` 可隐藏），或改用手写 `models` 条目自行声明。

```json
{
  "providers": {
    "llm-proxy": {
      "discoverModels": true,
      "modelOverrides": {
        "some-model": { "thinkingLevelMap": { "xhigh": null, "max": null } }
      }
    }
  }
}
```
- 模型元数据可携带 `name` / `context_window`（或 `contextWindow`）/ `max_tokens`（或 `maxTokens`），缺失时用默认值。

旧的 `/model-discovery` 与 `/pi-model-discovery` 名称仍作为兼容别名保留；`/model-discovery-refresh` 与 `/pi-model-discovery-refresh` 已移除——目录刷新由 pi 自己驱动。

## 卸载

```bash
pi remove pi-models-discovery
```

卸载后 provider 回退为 models.json 中的静态配置（手写 `models` 或空）。
