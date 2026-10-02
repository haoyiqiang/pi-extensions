# @maplezzk/pi-web-search

Lightweight web access for Pi with three composable tools:

- `web_search`: LLM built-in web search or an independent Search API
- `url_context`: Google Gemini Developer API or Vertex Express URL Context, including public YouTube video input
- `web_fetch`: hosted-provider or direct HTTP page retrieval

The package deliberately omits PDF, local-video, curator, and persistent search-cache pipelines. It retains rpiv-web-tools-compatible, opt-in GitHub repository extraction.

## Install

```bash
pi install npm:@maplezzk/pi-web-search
```

Node.js 22 or newer is required.

## `web_search`

```ts
web_search({
  query: string,
  mode?: "auto" | "llm" | "api",
  provider?: "brave" | "tavily" | "serper" | "exa" | "youcom" |
    "jina" | "firecrawl" | "perplexity" | "searxng" | "ollama",
  max_results?: number, // 1..10, API mode only
  urls?: string[],      // up to 20, LLM mode only
})
```

### Modes

- `llm`: use the selected/configured model's built-in web-search tool. No API fallback.
- `api`: use one configured search API. No LLM or cross-provider fallback.
- `auto`: try LLM search first, then use one API provider only when the classified error is listed in `fallbackOn`.

`llm` means the LLM provider's built-in search capability, not a model summarizing API results.

The default fallback policy is conservative:

```json
{ "fallbackOn": ["unsupported"] }
```

Optional reasons are `unsupported`, `quota`, `rate-limit`, `network`, `timeout`, and `invalid-response`. Authentication, invalid-request, cancellation, and unknown errors never fall back. Requests containing `urls` never fall back to API search because that would silently discard URL-analysis semantics.

### Result contract

Every successful result is a Pi `AgentToolResult`. Inspect `details.modeUsed` as the discriminator.

LLM search returns a generated grounded answer in `content` and details including:

```ts
{
  query,
  modeRequested: "auto" | "llm",
  modeUsed: "llm",
  model,
  providerKind,
  grounded,
  resultCount,
  sources,
  searchQueries?,
  searchResults?,
  citations?,
  llmSearchCalls?
}
```

API search returns a bounded title/URL/snippet list and:

```ts
{
  query,
  modeRequested: "auto" | "api",
  modeUsed: "api",
  backend,
  resultCount,
  results?,
  sources,
  fallback?
}
```

No API provider chain is attempted: an API failure is returned directly.

## `url_context`

```ts
url_context({
  query: string,
  urls: string[], // 1..20
})
```

This tool is enabled only when its configured/current model can use:

- Google Gemini Developer API URL Context, or
- Vertex AI Express Mode URL Context using an API key.

Ordinary URLs are sent with the provider's built-in `urlContext` tool. Public YouTube URLs are not URL Context documents; they are sent as Gemini video `fileData` inputs, with at most one YouTube URL per request. Bilibili, Vimeo, local video files, arbitrary media URLs, Files API upload, GCS input, and video offset processing are outside this package's scope.

Vertex Express is implemented with raw HTTP/SSE equivalent to `genai.Client(vertexai=True, api_key=...)`:

```text
POST https://aiplatform.googleapis.com/v1/
     publishers/google/models/{model}:streamGenerateContent?alt=sse
x-goog-api-key: ...
```

Standard Vertex project/location/ADC authentication is not yet implemented.

Ollama is intentionally not a `url_context` backend. As an API provider it retains the original rpiv-web-tools search and `web_fetch` endpoints.

## `web_fetch`

```ts
web_fetch({
  url: string,
  raw?: boolean,
})
```

Dispatch order, matching rpiv-web-tools:

1. the optional GitHub interceptor for `github.com` repository, tree, and blob URLs;
2. the selected provider's fetch endpoint when available, including local/cloud Ollama;
3. direct HTTP plus lightweight HTML-to-text extraction for search-only providers.

GitHub extraction is off by default. When enabled, it prefers `gh`, falls back to `git` for cloning, and uses the GitHub API as a bounded fallback. Clones are cached under the configured temporary clone path. Optional external commands are detected at runtime.

Direct HTTP fetches reject non-HTTP protocols, URL credentials, literal private/loopback hosts, DNS resolutions to private addresses, and redirects to private addresses. Image, audio, and video response bodies are rejected.

Direct HTTP response bodies have a 10-MiB safety limit. Returned output is bounded by Pi's standard 2,000-line / 50-KiB limits. Full content within the safety limit is written to a private temporary `content.txt` when the inline output is truncated, and `details.fullOutputPath` points to it.

## Configuration

Run the interactive configuration panel:

```text
/config:web-search
```

The panel configures search mode, LLM model and transport, Search API provider and credential, self-hosted base URLs, the GitHub repository interceptor, and automatic fallback reasons. Changes are saved immediately with file mode `0600`; normal use does not require editing JSON by hand.

The default file is `~/.pi/agent/web-search.json`. `PI_CODING_AGENT_DIR` is respected through Pi's agent directory. Set `PI_WEB_SEARCH_CONFIG` to override the complete path.

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

Legacy top-level `{ "provider": "...", "model": "..." }` in `web-search.json` is treated as the LLM model override. If present, the old XDG-aware `rpiv-web-tools/config.json` is read as a fallback for `provider`, `apiKeys`, `baseUrls`, the legacy Brave `apiKey`, and `interceptors.github`; the unified config wins on matching fields, and neither legacy file is modified or deleted.

The panel exposes the normal GitHub on/off switch. Advanced compatibility options remain available as `{ "enabled": true, "maxRepoSizeMB": 350, "cloneTimeoutSeconds": 30, "clonePath": "..." }`.

API provider resolution is: per-call `provider` → `PI_WEB_SEARCH_API_PROVIDER` → legacy `WEB_SEARCH_PROVIDER` → `api.provider` → Brave. Provider credentials resolve from the provider environment variable before `api.apiKeys.<provider>`. There is no cross-provider credential fallback.

Common environment variables include `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`, `EXA_API_KEY`, `YOUCOM_API_KEY`, `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `PERPLEXITY_API_KEY`, `SEARXNG_URL`, and `OLLAMA_HOST`.

Model authentication is resolved through Pi's model registry, including a resolved base URL. Raw search transports do not add provider session headers.

## Development

```bash
npm install
npm run typecheck -w @maplezzk/pi-web-search
npm test -w @maplezzk/pi-web-search
npm run check
```

Tests are deterministic and do not require network access or credentials.

## Attribution

See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md), [`PI-WEB-SEARCH-LICENSE`](./PI-WEB-SEARCH-LICENSE), and [`RPIV-WEB-TOOLS-LICENSE`](./RPIV-WEB-TOOLS-LICENSE).
