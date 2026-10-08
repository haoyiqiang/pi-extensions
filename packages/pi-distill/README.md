# pi-distill

> **Keep the source. Spend context on decisions.**

One post-tool processing extension with two mutually exclusive strategies: **ordinary summaries** guided by `outputRequest`, and opt-in **diagnostic evidence extraction** adapted from NVIDIA's [SoL-Pi](https://github.com/NVlabs/SoL-Pi). Every accepted lossy replacement has an archived source. Read that source with Pi's existing `read` tool; no extra reduction or readback tool is registered.

> 中文：[README.zh-CN.md](./README.zh-CN.md)

## Install and enable

```bash
pi install npm:pi-distill
```

The package also loads its shared i18n extension. Run `/reload`, then `/config:distill` to select a model and configure processing. `/pi-distill` remains a compatibility alias. `/distill:stats` reports per-session results, attempts, usage, estimated context savings and cost. UI commands require a UI-capable session; result processing also works headlessly.

Configuration is read from `<Pi agent directory>/extensions/pi-distill/config.json`, normally under `~/.pi/agent`; `PI_CODING_AGENT_DIR` is supported. Loading does not write or migrate global settings. See [config.example.json](./config.example.json).

**Evidence and Fusion processing are disabled by default.** To enable diagnostic evidence, explicitly set:

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

`fusion: true` additionally allows the command log appended by Action Fusion's `edit`/`write`; it does not enable Action Fusion itself. An explicit `tools.edit.enabled: false` or `tools.write.enabled: false` takes precedence. The interactive settings expose both evidence switches. Size quotas and additional command prefixes are configured in JSON.

## Processing chain

```text
Tool returns actual output
  ├─ disabled / RAW / non-text / excluded → keep the original result
  └─ select one scope and one strategy
       ├─ recognized diagnostic command → evidence (when enabled)
       └─ other enabled text + outputRequest → ordinary summary
            ↓ source size / completeness / sensitive-content checks
            ↓ archive source before model work
            ↓ model processing and local validation
            ├─ valid, within budget and useful → receipt + source reference
            └─ failure / cancelled / ineffective → keep original result
```

There is no evidence-to-summary fallback and no processing of an already processed receipt. Processing does not change tool execution, file edits or the tool's error state. It uses native `tool_call`/`tool_result` events and registers no replacement tools. Handlers see results in extension order: the source is what Distill receives, not bytes another extension has already discarded.

## Tool schema and RAW

Ordinary enabled object-schema tools retain the required, nonempty `outputRequest` contract. Unconfigured non-mutation tools retain their previous default of enabled; use `tools.<name>.enabled: false` to opt out. Evidence does not silently change that allowlist.

```json
{
  "command": "npm run test",
  "outputRequest": "Keep failed cases, assertion differences and final totals"
}
```

Exactly `RAW`, case-insensitive after trimming, bypasses both strategies. It **preserves the received tool content**, not an unlimited process transcript: the underlying tool's own limits still apply. RAW, disabled paths and failures are no longer truncated or replaced with a file pointer by Distill. Even a tiny `maxOutputChars` cannot truncate them. Custom tools remain responsible for bounding their own output; preserving an oversized fallback can still exceed the primary model's context.

When evidence and Fusion processing are enabled, compatible `edit`/`write` definitions exposing `then_run` receive an **optional** `outputRequest`. Omission uses default evidence rules; RAW bypasses processing; any other value provides a focus. The field applies only to command logs. Plain mutation results are never summarized, even if an older `tools.edit/write.enabled: true` setting exists. Distill removes only successfully injected, extension-owned handling fields before execution. A tool's native `outputRequest` collision is warned about and left untouched.

Non-text or mixed-media results bypass processing. A disabled extension does not add the handling contract to the system prompt.

## Evidence versus summaries

### Diagnostic evidence

A conservative command detector recognizes common test/build/check commands, including `npm run test`, `npm run build`, script variants such as `test:unit`, pnpm/yarn/bun, pytest/unittest, Go/Cargo and native build tools. It recognizes simple unquoted command boundaries and common wrappers, not arbitrary shell programs. Compound commands are eligible only when every segment is diagnostic or a narrow silent setup (`cd`, environment assignment, `true`, `:`); `npm test; cat confidential.txt` is not automatic evidence. Quoted examples such as `echo 'npm test'`, command substitutions and heredocs are not automatically treated as diagnostics. `evidence.commands` adds literal token prefixes, **not executable regexes**; use the normalized executable basename, for example `"verify --ci"` for `./verify --ci`.

The fixed bilingual extraction prompt requires contiguous exact source quotes. `outputRequest` may prioritize evidence but cannot remove the fixed constraints. No diagnosis or repair suggestion is generated. One model attempt, no JSON repair and no configured summary retries are used for this strategy. The validator checks schema, item/quote bounds, exact source membership and required recognizable failure evidence; benign zero-failure counts cannot fulfill that guard. Strong failure signals also require failure evidence when a successful shell status masks them. Lines are computed locally; source hashes, paths and the observed tool error state are generated by the host, not invented by the model.

A result is headed `[distill:evidence]`. **Verified quotes do not prove complete coverage, correct classification, causality, or a passing test suite.** A successful shell invocation can hide test failure with `|| true`. Uncertainty is model advice, never a completeness certificate.

### Ordinary summaries

Other enabled text remains guided by `outputRequest`. The existing structured RAW/SUMMARY model protocol, retry budgets and one JSON-only repair attempt remain available. A result is headed `[distill:summary]` and explicitly states that individual claims are **not locally fact-verified**. Source archival improves traceability, not semantic correctness.

Both paths measure the complete projected result, including citations and protected mutation confirmation. At least **1.4× character reduction** and both output budgets are required. Character savings are not exact tokenizer savings. An older real-session screenshot below shows suitable verbose output savings; its historical 213.40× figure predates source receipts and is not a guarantee for this version.

![Historical context-savings example](./assets/context-savings-example.png)

## Sources and native readback

Every accepted summary or evidence receipt includes model-visible metadata:

```text
source_artifact="/…/extensions/pi-distill/artifacts/<session-hash>/objects/<source-hash>.txt"
source_sha256=…
source_bytes=…
source_lines=4200
source_kind=tool-output
```

Use the actual path string without the JSON quotes:

```json
{
  "path": "/…/objects/<source-hash>.txt",
  "offset": 200,
  "limit": 60,
  "outputRequest": "RAW"
}
```

Only include `outputRequest` if the current `read` schema exposes it. Lines are 1-based. To inspect the last N lines once, use `offset = max(1, source_lines - N + 1)` and `limit = N`. Line counts use native `read`'s newline splitting, including an empty trailing line. Native read's line/byte limits still apply.

A bounded, regular, single-link, non-symlink temp file provided by a tool may supply fuller source text. Bash/Fusion accepts only native `pi-bash-*.log` spool files directly under the OS temp directory, or a native-shaped final truncation footer after error normalization. Invalid, missing, oversized or changing files fail open. Evidence skips known truncated previews without a usable full log. Other tool output can be summarized as `source_kind=preview`, which is not a full-source claim. The source is UTF-8 text supplied by Pi; malformed full-file UTF-8 is rejected rather than silently changed.

For Fusion, only `[then_run:succeeded]` or `[then_run:failed]` command log suffixes are eligible. Confirmation, successful diff/patch metadata, machine marker and outer error state remain intact. Skipped, running, missing or ambiguous boundaries are left alone. Failed calls may not retain native diff details because Pi normalizes thrown errors; Distill cannot reconstruct them. Nested `details.actionFusion.bashDetails` is recognized without importing Fusion's private source.

## Storage, privacy and failure behavior

Archives live under the agent directory, not the project. Session IDs and source content are hashed for filenames. Objects are atomically published, deduplicated with integrity checks, and use private permissions where supported. Source quotas and restored session object sizes are checked. Archive failure or quota exhaustion prevents the remote request and retains the original result. Files are not deleted on reload, session restore or normal shutdown; cleanup is an explicit user filesystem operation after references are no longer needed.

The default source cap is 1 MiB and per-session cap is 64 MiB. Quota writes use both in-process serialization and an exclusive per-session filesystem lock. Cancellation interrupts in-process queue waiting without letting later writers overtake an active writer. Lock contention fails open to original output instead of waiting or starting remote processing. A lock left after process crash is not automatically stolen; explicitly remove a stale lock only after confirming no writer is active. Stale staging and other regular object-directory files count toward quota and are not silently deleted. Session storage quotas do not provide an agent-directory-wide retention policy. Optional filesystems without required atomic-link support cause fail-open behavior rather than weakening integrity.

Processing can send source text to the current/configured model. A heuristic secret detector skips likely credentials in either strategy, but **is not a complete privacy guarantee**. Disable processing or select a suitable local processing model to avoid an additional remote recipient. This does not redact the original tool result or stop the primary Agent from sending it to its own model; keeping all output local also requires a local primary model and appropriate tool settings. Archives themselves can contain sensitive local text. Do not co-load the standalone SoL-Pi Reducer or another overlapping result summarizer.

Cancellation propagates to model requests. Deadlines bound Distill's wait, not remote execution or billing when a provider ignores cancellation; no timeout retry starts while termination of the prior request remains unconfirmed. Reported usage is included in Pi tool-result accounting, including rejected evidence and failed JSON repair. An initial response's reported usage is retained even if its repair request hangs; usage never reported by the hung request cannot be reconstructed. A conservative heuristic prompt/context-window preflight also skips predictably oversized requests. Evidence never falls back to an unverified summary. The current model registry handles authentication and resolved endpoints once per request, without a separate authentication precheck; Codex side requests use isolated sessions cleaned up after completion.

## Configuration reference

| Field | Meaning |
| --- | --- |
| `enabled` | Enable the processing extension. Invalid critical configuration, including malformed tool opt-outs, disables processing and requires manual repair. |
| `model` | Optional `provider/modelId`; empty uses the current session model. |
| `minChars` | Ordinary-summary input threshold; default 200 characters. |
| `maxChars` | Accepted summary/evidence body budget; default 100,000 characters. Exceeding it retains original output. |
| `maxOutputChars` | Accepted complete projected result budget, including citations; default 10,000. Not a RAW/fallback limit. |
| `timeoutSeconds` | Deadline for each model attempt; default 10 seconds. |
| `timeoutRetryCount` / `errorRetryCount` | Ordinary-summary retries, default 1 each; evidence always uses one attempt. |
| `missedCompressionRatio` | Legacy configuration field retained for compatibility. |
| `summarizeErrors` | False skips error results in both strategies, including explicit requests. |
| `evidence.enabled` | Opt-in diagnostic strategy, default false. |
| `evidence.fusion` | Opt-in fused-command scope, default false; requires evidence enabled. |
| `evidence.minBytes` | Evidence input threshold, default 8,192 UTF-8 bytes. |
| `evidence.commands` | Up to 32 additional literal normalized command prefixes, at most 256 chars each. |
| `archive.maxSourceBytes` | Default 1 MiB; configurable up to 16 MiB. Over-budget sources are not sent. |
| `archive.maxSessionBytes` | Default 64 MiB; configurable up to 1 GiB. No silent eviction. |
| `tools.<name>.enabled` | Existing per-tool opt-out/enable settings; mutation scopes require the explicit evidence/Fusion switches. |
| `render.*` | UI-only audit card visibility, request and result preview. |

File fields take precedence over existing `PI_DISTILL_*` and legacy `PI_BASH_SUMMARY_*` variables. Evidence/archive fields are JSON-only. No automatic rewrite or migration of user-global configuration is performed. Enabling Fusion changes only its handling schema and requires a compatible loaded Fusion tool; it is not a Bash permission sandbox.

## Development and provenance

Node.js 22+ and Pi 0.87.1+ are required. The Pi peer minimum is aligned with the tested model-registry, session-resource and tool-usage APIs; versions 0.80–0.86 are no longer declared compatible. Development and offline SDK regressions target Pi 0.87.1. Deterministic tests use injected providers, temporary storage and native read; no API keys are required.

```bash
npm run typecheck --workspace pi-distill
npm test --workspace pi-distill
```

Prompts and notices follow the shared locale. UI audit entries do not enter model context. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and [LICENSE](./LICENSE) for the adapted MIT-licensed SoL-Pi mechanisms.
