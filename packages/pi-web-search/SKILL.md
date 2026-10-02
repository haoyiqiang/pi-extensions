---
name: configure-pi-web-search
description: 配置与排查 @maplezzk/pi-web-search 的 LLM/API 双路搜索、回退、URL Context、Vertex Express 和 web_fetch。Use when configuring or diagnosing pi-web-search.
---

# Configure pi-web-search

优先运行 `/config:web-search` 打开配置面板；配置文件默认位于 `~/.pi/agent/web-search.json`，`PI_WEB_SEARCH_CONFIG` 可覆盖完整路径。

## 搜索模式

- `auto`：先走 LLM 内置搜索，仅按 `fallbackOn` 回退到一个 API provider。
- `llm`：只走模型内置搜索。
- `api`：只走独立 Search API。

默认 `fallbackOn` 只有 `unsupported`。若要在配额或网络错误时回退，可加入 `quota`、`rate-limit`、`network`、`timeout`、`invalid-response`。鉴权、无效请求、取消和未知错误永不回退。

## Vertex Express URL Context

```json
{
  "llm": {
    "provider": "google",
    "model": "gemini-3.8-flash",
    "transport": "vertex-express"
  }
}
```

该模式使用 Pi Google provider 中的 Vertex Express API key。它不等于标准 Vertex project/location/ADC。

## API 搜索

```json
{
  "api": {
    "provider": "brave",
    "apiKeys": { "brave": "..." }
  }
}
```

环境变量优先于配置文件。常见变量包括 `BRAVE_SEARCH_API_KEY`、`TAVILY_API_KEY`、`EXA_API_KEY`、`JINA_API_KEY`、`SEARXNG_URL` 和 `OLLAMA_HOST`。

## 网页读取

`web_fetch` 按 GitHub interceptor（默认关闭）→ provider fetch endpoint → DNS-pinned 直接 HTTP 的顺序分发。Tavily、Exa、You.com、Jina、Firecrawl 和 Ollama 使用 provider endpoint；Brave、Serper、Perplexity 和 SearXNG 使用直接 HTTP。GitHub 提取可在配置面板中切换。

## 诊断

1. 检查 `details.modeRequested` 与 `details.modeUsed`。
2. 自动回退时检查 `details.fallback.reason`。
3. LLM 搜索失败但未回退时检查 `fallbackOn`，以及请求是否带 `urls`。
4. `url_context` 不可用时确认当前/配置模型是 Google Developer API，或 `transport` 为 `vertex-express`。
5. 检查 `web_fetch` 的 `details.backend`：`github`、provider 名称或 `http`。
6. `web_fetch` 的超长正文从 `details.fullOutputPath` 读取。

详细契约见包内 `README.md` 或 `README.zh-CN.md`。
