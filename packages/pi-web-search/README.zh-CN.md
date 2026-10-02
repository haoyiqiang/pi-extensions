# @maplezzk/pi-web-search

为 Pi 提供三个轻量且可组合的联网工具：

- `web_search`：LLM 内置搜索或独立 Search API
- `url_context`：Google Gemini Developer API / Vertex Express URL Context，并支持公开 YouTube 视频输入
- `web_fetch`：托管 provider 抓取或直接 HTTP 网页读取

本包刻意不包含完整 web-access 套件中的 PDF、本地视频、curator 和持久搜索缓存等重型管线；保留与 rpiv-web-tools 兼容、默认关闭的 GitHub 仓库提取。

## 安装

```bash
pi install npm:@maplezzk/pi-web-search
```

需要 Node.js 22 或更高版本。

## `web_search`

```ts
web_search({
  query: string,
  mode?: "auto" | "llm" | "api",
  provider?: "brave" | "tavily" | "serper" | "exa" | "youcom" |
    "jina" | "firecrawl" | "perplexity" | "searxng" | "ollama",
  max_results?: number,
  urls?: string[]
})
```

- `llm`：只使用当前或配置模型的内置搜索能力，不回退 API。
- `api`：只使用一个 Search API，不回退 LLM，也不自动换另一家 API。
- `auto`：优先 LLM；仅当错误类型出现在 `fallbackOn` 时回退到一个 API provider。

这里的 `llm` 指 LLM provider 的内置搜索能力，不是把 API 搜索结果再交给模型摘要。

默认回退策略：

```json
{ "fallbackOn": ["unsupported"] }
```

可配置 `unsupported`、`quota`、`rate-limit`、`network`、`timeout` 和 `invalid-response`。鉴权错误、无效请求、取消和未知错误永不自动回退。带 `urls` 的调用也不回退 API，避免悄悄丢失 URL 分析语义。

成功结果通过 `details.modeUsed` 判别：

- `llm`：`content` 是模型生成的带引用回答；详情包含模型、来源、引用、搜索 query 和 LLM 搜索调用。
- `api`：`content` 是 title/URL/snippet 列表；详情包含 `backend`、`results`、`sources`，自动回退时还有 `fallback`。

## `url_context`

```ts
url_context({
  query: string,
  urls: string[]
})
```

仅支持：

- Google Gemini Developer API URL Context；
- 使用 API key 的 Vertex AI Express Mode URL Context。

普通 URL 使用 provider 内置的 `urlContext` 工具。公开 YouTube URL 不属于 URL Context 文档，而是作为 Gemini `fileData` 视频输入发送；每次请求最多包含一个 YouTube URL。

Bilibili、Vimeo、本地视频、任意媒体 URL、Files API 上传、GCS 输入和视频时间偏移不属于本包范围。

Vertex Express 使用裸 HTTP/SSE，实现效果等价于：

```python
genai.Client(vertexai=True, api_key=...)
```

对应请求：

```text
POST https://aiplatform.googleapis.com/v1/
     publishers/google/models/{model}:streamGenerateContent?alt=sse
x-goog-api-key: ...
```

目前不支持标准 Vertex 的 project/location/ADC。Ollama 已从 `url_context` 删除，但作为 API provider 保留原版 rpiv-web-tools 的搜索和 `web_fetch` endpoint。

## `web_fetch`

```ts
web_fetch({
  url: string,
  raw?: boolean
})
```

分发顺序与 rpiv-web-tools 保持一致：

1. 可选的 GitHub interceptor，处理 `github.com` 仓库、目录和文件 URL；
2. 当前 provider 的 fetch endpoint，包括本地或云端 Ollama；
3. 搜索型 provider 使用直接 HTTP + 轻量 HTML 转文本。

GitHub 提取默认关闭。启用后优先使用 `gh`，克隆时回退到 `git`，必要时使用有边界的 GitHub API 视图；克隆会缓存在配置的临时目录中。可选外部命令会在运行时检测。

直接 HTTP 会拒绝非 HTTP(S) 协议、URL 凭证、私网/回环地址、解析到私网的 DNS 和跳转到私网的重定向。图片、音频和视频响应也会拒绝。

直接 HTTP 响应正文有 10 MiB 安全上限。返回输出遵循 Pi 的 2000 行 / 50 KiB 边界；安全上限内的完整正文在内联输出被截断时写入私有临时 `content.txt`，路径位于 `details.fullOutputPath`。

## 配置

优先使用交互式配置面板：

```text
/config:web-search
```

面板可以设置搜索模式、LLM 模型与 transport、Search API provider 和凭证、自托管地址、GitHub 仓库提取以及自动回退条件。修改会立即以 `0600` 权限保存，正常使用不需要手动编辑 JSON。

默认路径是 `~/.pi/agent/web-search.json`。支持 `PI_CODING_AGENT_DIR`，也可用 `PI_WEB_SEARCH_CONFIG` 覆盖完整路径。

```json
{
  "mode": "auto",
  "fallbackOn": ["unsupported"],
  "llm": {
    "provider": "google",
    "model": "gemini-3.8-flash",
    "transport": "vertex-express"
  },
  "api": {
    "provider": "brave",
    "apiKeys": {
      "brave": "..."
    },
    "baseUrls": {
      "searxng": "http://localhost:8080",
      "ollama": "http://localhost:11434"
    }
  },
  "interceptors": {
    "github": false
  }
}
```

`web-search.json` 中旧版顶层 `{ "provider": "...", "model": "..." }` 会被识别为 LLM 模型覆盖配置。如果旧的 XDG-aware `rpiv-web-tools/config.json` 存在，本包会读取其中的 `provider`、`apiKeys`、`baseUrls`、旧版 Brave `apiKey` 和 `interceptors.github`；统一配置中的同名字段优先，旧文件不会被修改或删除。

面板提供 GitHub 提取的普通开关。高级兼容选项仍可写为 `{ "enabled": true, "maxRepoSizeMB": 350, "cloneTimeoutSeconds": 30, "clonePath": "..." }`。

API provider 优先级：本次调用 `provider` → `PI_WEB_SEARCH_API_PROVIDER` → 旧版 `WEB_SEARCH_PROVIDER` → `api.provider` → Brave。密钥优先读取 provider 环境变量，再读取 `api.apiKeys.<provider>`；不会跨 provider 复用密钥。

模型鉴权统一通过 Pi model registry 解析，包括解析出的 base URL。原始搜索请求不再额外补 provider 会话头。

## 开发

```bash
npm install
npm run typecheck -w @maplezzk/pi-web-search
npm test -w @maplezzk/pi-web-search
npm run check
```

测试不依赖真实网络、API key 或本地 daemon。

## 第三方归属

见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 与 [`RPIV-WEB-TOOLS-LICENSE`](./RPIV-WEB-TOOLS-LICENSE)。
