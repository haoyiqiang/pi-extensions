# Changelog

## 1.6.0

- Introduced the publishable package as `@maplezzk/pi-web-search` while preserving the `pi-web-search` feature and config names.
- Migrated the upstream `pi-web-search` implementation into the pi-extensions workspace.
- Added unified `auto | llm | api` routing and independent API search providers from `@juicesharp/rpiv-web-tools`.
- Added `/config:web-search` for interactive mode, LLM model/transport, API provider/credential/base URL, and fallback configuration.
- Standardized public configuration and result terminology on `llm`/`api`; older model-selection fields remain read-only compatibility inputs.
- Added `web_fetch` with rpiv-web-tools-compatible GitHub interceptor/provider/direct-HTTP dispatch, including Ollama fetch endpoints, plus DNS-pinned direct extraction, redirect validation, and a 10-MiB response limit.
- Added explicit response-body disposal on redirect, HTTP-error, unsupported-content, and declared-oversize exits so the shared Undici agent can promptly reuse connections.
- Confined GitHub clone destinations to the configured clone root and rejected decoded path separators before any recursive cleanup.
- Removed Ollama from `url_context` and added raw-HTTP Vertex Express URL Context.
- Added shared Pi authentication, bilingual UI localization, fixed-English agent prompts/tool descriptions, deterministic tests, legacy `rpiv-web-tools` API-config fallback, and third-party attribution.
