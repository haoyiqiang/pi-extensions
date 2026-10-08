# @maplezzk/pi-advisor

A Pi extension that gives the active model a zero-parameter `advisor()` tool backed by a separately selected reviewer model.

## Features

- `advisor()` forwards the current effective branch context, including compaction and branch summaries.
- The in-flight `advisor` tool call is removed before forwarding; the reviewer receives no tools.
- Empty normal responses are retried exactly once with the same snapshotted context, model, and effort.
- Nested calls use `ctx.modelRegistry.streamSimple(...).result()`. OpenAI Codex reviewer calls use an isolated UUIDv7 session and always clean it up.
- Nested request usage is returned on the tool result for Pi session accounting.
- Reviewer selection is owned by each extension/session runtime, so SDK or workflow child sessions cannot overwrite the root selection.
- `disabledForModels` dynamically hides the tool for selected executor models or effort thresholds.
- English and Simplified Chinese UI, notices, tool guidance, and reviewer prompts. Tool/command metadata refreshes after `--locale` startup resolution and language changes; configured guidance is preserved.

## Install

```bash
pi install npm:@maplezzk/pi-advisor
```

Reload Pi, then run either command:

```text
/config:advisor
/advisor
```

Both names open the same selector and update the same runtime/configuration. `/advisor` is retained as the original short alias.

The selector lists models already available through Pi's model registry. In TUI mode it supports fuzzy filtering; RPC clients use Pi's native selection UI.

## Configuration

Canonical path:

```text
~/.pi/agent/extensions/pi-advisor/advisor.json
```

`PI_CODING_AGENT_DIR` is respected. When the canonical file is absent, the old read-only RPIV location under `$XDG_CONFIG_HOME/rpiv-advisor/advisor.json` (or `~/.config/rpiv-advisor/advisor.json`) is accepted. Explicit selections are always written only to the canonical path with owner-only permissions.

```json
{
  "modelKey": "anthropic/claude-opus-4-6",
  "effort": "high",
  "disabledForModels": [
    "anthropic/claude-opus-4-6",
    { "model": "openai/gpt-5.2", "minEffort": "high" }
  ],
  "guidance": {
    "promptSnippet": "Escalate before consequential decisions."
  }
}
```

- `modelKey`: reviewer model as `provider/modelId`; legacy `provider:modelId` is accepted on read.
- `effort`: `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Omit it to send no explicit reasoning level.
- `disabledForModels`: executor-model blocklist. An optional `minEffort` blocks only at or above that level.
- `guidance.promptSnippet`, `guidance.promptGuidelines`, and `guidance.description`: optional model-facing overrides.

The commands preserve unknown keys and hand-edited guidance/blocklist fields.

## Runtime behavior

The advisor is registered but removed from the active tool set when no reviewer is configured or the current executor is blocked. Model and thinking-level changes reconcile the tool immediately. The forwarded request uses Pi's public, credential-aware model registry and never makes an implicit call during extension factory loading. Authentication, headers and cancellation use the native request preparation path without a separate preflight. The reviewer inventory is generated from the calling runtime's current tool definitions, never cached across sessions.

Historical upstream documentation is retained under [`docs/upstream`](./docs/upstream); paths and transport details there describe the original RPIV package. See [UPSTREAM.md](./UPSTREAM.md) for provenance.

## License

MIT. See [LICENSE](./LICENSE).
