# Changelog

## Unreleased

- Fixed legacy `modelId` selection and rejected incomplete or missing configured model overrides instead of silently switching backends.
- Made API key/base URL clears persist across legacy-config merging without modifying legacy files.
- Restored failed tool execution status and error rendering while preserving provider/direct-HTTP fetch dispatch.
- Confined GitHub README reads to the clone root, removed unhandled clone-path promise rejections, and supported encoded slash refs and special-character API paths safely.
- Rejected empty/malformed LLM streams, surfaced native Anthropic search errors, collected streamed search queries, and corrected quota fallback classification.
- Aligned Gemini source numbering with grounding citations and preserved cancellation during grounding redirect resolution.
- Restored OpenCode session headers, Copilot Anthropic Bearer auth, Azure endpoint/key/deployment handling, and explicit API-key Vertex Express support for native Vertex models.
- Added deterministic regression tests for the repaired paths.

## [1.7.0](https://github.com/haoyiqiang/pi-extensions/compare/pi-web-search-v1.6.0...pi-web-search-v1.7.0) (2026-10-29)


### Features

* add lightweight LLM and API web search ([832ec4e](https://github.com/haoyiqiang/pi-extensions/commit/832ec4e363d5612c2c6b71ad64671dfb30302df5))


### Bug Fixes

* **web-search:** repair integration regressions and provider compatibility ([2bf42f0](https://github.com/haoyiqiang/pi-extensions/commit/2bf42f0c82c4449f550e20d2bce21fbc842efb24))

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
