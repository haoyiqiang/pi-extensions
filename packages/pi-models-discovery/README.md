# @kevinhao/pi-models-discovery

Generic model discovery extension: reads providers marked with `"discoverModels": true` in `~/.pi/agent/models.json`, requests `GET {baseUrl}/models`, and registers the discovered models automatically — no handwritten `models` array required.

It registers a complete Pi `Provider` (not a legacy provider config) and delegates all catalog state to Pi: `refreshModels` restores the last catalog through `context.stored`, fetches with `context.credential` and `context.signal`, and publishes through `context.publish({ persist })`, which Pi writes to its own `models-store.json`. There is no extension-private cache file and no manual refresh command — Pi refreshes catalogs after interactive startup and whenever `/model` opens.

Suitable for local/self-hosted LLM proxies (one gateway exposing many models), Ollama, vLLM, and other OpenAI-compatible services.

## Install

```bash
pi install npm:@kevinhao/pi-models-discovery
```

## Configuration

### Option 1: interactive configuration inside pi (recommended)

```
/config:model-discovery
```

Interactively add / remove / rediscover providers: enter id, baseUrl, api type, apiKey (optional), display name (optional). Changes are written to models.json and take effect **immediately** (no /reload required). A backup is written to `models.json.discovery-bak` before each write.

Note: comments and custom formatting in models.json are not preserved on write (the file is reformatted with 4-space indentation).

### Option 2: edit models.json by hand

Add `"discoverModels": true` to a provider in `~/.pi/agent/models.json`:

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

`baseUrl` and `api` are required; `api` can be any api Pi implements — `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai` (the four the interactive picker offers), but also `azure-openai-responses`, `google-vertex`, `mistral-conversations`, `bedrock-converse-stream`, `openai-codex-responses`, or `pi-messages`. `apiKey` is optional (omit for unauthenticated services) and accepts a literal or `$ENV_VAR` / `${ENV_VAR}` interpolation. `!command` values are executed by Pi, and the resolved key reaches discovery on every refresh through `context.credential`; only the loading-time cold-start fetch cannot run commands — it warns and leaves the catalog to the next refresh.

Hand edits require `/reload` to take effect; changes made through `/config:model-discovery` apply immediately.

### Discovery filters and shared defaults

When `/models` mixes image models, different wire protocols, or gateway-private entries, use `modelDiscovery.include` / `exclude` to filter model IDs with globs and `defaults` to supply shared capability metadata that `/models` does not return:

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

`include` / `exclude` are whole-ID globs supporting `*` and `?`; include runs first, then exclude. `defaults` accepts `reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, `maxTokens`, and `compat`. Per-model `context_window` / `max_tokens` values returned by `/models` take precedence over defaults; standard models.json `modelOverrides` can still refine individual models.

## Refreshing the catalog

Pi drives refreshes; there is nothing to run by hand:

- **Interactive startup** refreshes every dynamic provider (restore from `models-store.json`, then `GET /models`) and persists the result.
- **Opening `/model`** refreshes again and re-renders the picker with the result, so a model added on the gateway shows up on the next picker open.
- **`pi -p` and subagents** do not start a network refresh; they read the catalog Pi persisted in `models-store.json`. The extension only fetches while loading when no usable persisted catalog exists for that provider (skipped when `PI_OFFLINE` is set), and hands that cold-start seed to Pi on the first refresh so Pi persists it instead of refetching every run.

`/config:model-discovery` → *Add provider* / *Rediscover models* go through the same `modelRegistry.refresh({ providers, allowNetwork: true, force: true })` path, so the command reuses Pi's credential resolution and persistence instead of fetching on its own.

## Behavior

- **Catalog ownership**: the extension holds the discovered list in memory and mirrors Pi's `stored` catalog on restore; persistence is Pi's `models-store.json` and the extension never writes it. Restored models are kept only when their `baseUrl`, `api`, and current include/exclude rules still match, so a config change drops stale entries instead of showing them.
- **Config changes**: editing models.json takes effect after `/reload`; Pi's next refresh re-discovers. `/config:model-discovery` writes the file, registers the provider, and forces a provider-scoped refresh.
- **Restored metadata**: a catalog restored from `models-store.json` keeps the metadata it was discovered with. Endpoint, `api`, and dropping/narrowing filters invalidate entries immediately; changes to `defaults` or `compat` only show up after the next network refresh (interactive startup or `/model`). Model `headers` apply immediately; a `!command` header value is resolved by Pi for requests but skipped for the discovery request.
- **Offline / fetch failure**: a failed fetch keeps the previous catalog (Pi reports the provider error in the model picker) and handwritten `models` in models.json still apply. One provider failing does not affect the others.
- **Authentication**: the provider's `ProviderAuth` consumes the credential Pi already composed (`context.credential`, covering `auth.json`, the models.json `apiKey`, and `!command` values) and never re-resolves it; with no credential at all it reports a configured keyless provider, so unauthenticated local endpoints still refresh. The loading-time cold-start fetch is the only place that resolves a key itself (models.json `apiKey`, then `auth.json`).
- **Any api**: streaming is delegated to Pi's api registry, so every api Pi implements works (`openai-*`, `anthropic-messages`, `google-*`, `azure-openai-responses`, `mistral-conversations`, `bedrock-converse-stream`, …). An api Pi does not implement still registers and fails at request time, as it did with the legacy form.
- Default parameters for discovered models: `reasoning: true`, `input: ["text", "image"]`, zero cost, `contextWindow` 1M, `maxTokens` 64K, `compat.supportsDeveloperRole: false`. Provider-level `compat` and `modelDiscovery.defaults` are merged into every discovered model.
- Discovered models declare `thinkingLevelMap: { xhigh: "xhigh", max: "max" }`, so `xhigh` and `max` appear in `/thinking`; the standard levels stay omitted and keep pi's provider default mapping. `/models` cannot report per-model thinking capability, so this is a blanket default for every discovered model: when a provider rejects those levels, override it per model through `modelOverrides` in models.json (set `xhigh` / `max` to `null` to hide them), or declare the model yourself in a handwritten `models` entry.

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
- Model metadata may carry `name` / `context_window` (or `contextWindow`) / `max_tokens` (or `maxTokens`); defaults are used when absent.

The old `/model-discovery` and `/pi-model-discovery` names remain available as compatibility aliases. The former `/model-discovery-refresh` and `/pi-model-discovery-refresh` commands are gone: Pi refreshes catalogs on its own.

## Uninstall

```bash
pi remove pi-models-discovery
```

After removal, providers fall back to the static configuration in models.json (handwritten `models`, or none).
