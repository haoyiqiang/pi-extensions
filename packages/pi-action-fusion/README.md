# pi-action-fusion

Fuse a single-file `edit` or `write` with an optional follow-up command. Adapted from NVIDIA's [SoL-Pi Action Fusion](https://github.com/NVlabs/SoL-Pi). No extra model calls and no context compaction or output summarization.

> 中文：[README.zh-CN.md](./README.zh-CN.md)

## Load and enable

Requirements: Node.js 22+ and Pi 0.87.1 or a tested compatible runtime.

This package is included explicitly in the repository's Git/local profile, **disabled by default**. For standalone local use:

```bash
pi -e ./packages/pi-action-fusion/index.ts
```

Install the package directory the same way:

```bash
pi install ./packages/pi-action-fusion
```

Then explicitly enable and reload:

```text
/config:action-fusion enable
/reload
```

`/config:action-fusion status` reports loaded and configured state; `disable` also requires `/reload`. No configuration is written merely by loading the extension.

Alternatively create `<Pi agent directory>/extensions/pi-action-fusion/config.json`:

```json
{ "enabled": true }
```

The usual agent directory is `~/.pi/agent`; `PI_CODING_AGENT_DIR` is supported. There is no project-local config or automatic migration from `sol-pi.json`. Missing configuration means disabled; invalid configuration warns and stays disabled until manually repaired (configuration commands do not overwrite it). [config.example.json](./config.example.json) lists the default. Do not co-load the original SoL-Pi Action Fusion or another extension replacing `edit`/`write`.

## Tool contract

The enabled package replaces native `edit` and `write` with their original definitions plus optional `then_run`:

```json
{
  "path": "src/parser.ts",
  "edits": [{ "oldText": "return input", "newText": "return parse(input)" }],
  "then_run": { "command": "npm test", "timeout": 120 }
}
```

For `write`, use native `path` and `content`, with the same optional `then_run`. Omitted timeout uses the native Bash tool's no-default-timeout behavior.

1. Perform the native single-file mutation.
2. If requested, check for observed file interference and execute the command in `ctx.cwd`.
3. Return mutation confirmation and shell output together:

```text
Successfully replaced 1 block(s) in src/parser.ts.
[then_run:succeeded]
...test output...
```

No `then_run` means the native mutation result is unchanged. Native edit compatibility shims and multi-replacement semantics remain intact. Command failure, timeout, or cancellation is reported as a failed tool result with `[then_run:failed]`; successful file changes are **not rolled back**. Mutation failure or detected pre-command interference includes `[then_run:skipped]`. A failed combined call reports mutation confirmation but, like upstream, does not preserve native diff/patch details through Pi's thrown-error result normalization.

Successful/streaming results preserve native edit details and add `details.actionFusion` with command, status, and nested `bashDetails` (including the native truncation/full-output path when applicable). Commands use Pi's native bounded Bash output, not an unbounded log. Machine markers remain stable; descriptions, errors, commands and UI labels are bilingual.

## Two-stage tool card

A fused call stays one tool card, with the native file header and a small Fusion badge. Its mutation and command states are independent:

```text
write target.txt · Fusion
✓ Changes saved; not rolled back
✕ Follow-up command · exit 7  $ npm test
```

The collapsed view shows only the two stages and a bounded command preview. Expand the card using Pi's native tool expansion to see the native mutation diff/write preview and native expandable Bash log. Machine markers are interpreted for display instead of shown as status labels; the model-visible content is unchanged. The avoided-round-trip note appears only as secondary information in an expanded successful result. Exit 0 means normal command termination, not a claim that every test passed.

Mutation failure shows a failed mutation with a command that was not run. Pre-command interference shows saved changes with a skipped command. Command failure, timeout and cancellation keep the saved-mutation row explicit. Quiet commands publish a running update before any stdout arrives. The renderer also handles Pi-normalized failure text after session reload, including errors recorded in the other supported locale. Unknown or ambiguous boundaries fall back to native rendering rather than inventing a state.

Calls without `then_run` retain native presentation exactly. Successful/streaming diffs are reused unchanged; thrown-error normalization can still discard failed-call diff metadata, so the UI shows the retained mutation confirmation without reconstructing a diff. Distill's independent audit/source presentation remains its own responsibility.

## Concurrency and safety

The queue covers both mutation and command for one canonical file path, including ordinary symlink aliases. Different files can proceed independently. SHA-256 checks before the command are best-effort interference detection, **not** an external-process lock, a transaction, or a guarantee against all races.

**The follow-up command is internal execution, not a second `bash` tool call.** Only the outer `edit`/`write` emits native tool-call/result events. Bash-only permission guards, tool wrappers, distillation, and command routers do not automatically see it. Do not enable this feature if your safety policy depends exclusively on a separate Bash tool hook. It is not a sandbox.

The default entry uses the built-in local Bash backend's defaults. It does not borrow another extension's Bash override or automatically inherit SDK/custom shell options. Embedded callers can supply explicit `bashOptions`, `editOptions`, and `writeOptions` using `createActionFusionExtension(options)`. File interference checks read the local filesystem, so remote mutation operations need a corresponding local target; unsupported remote-only targets skip the command.

`pi-distill` owns the optional source-archived evidence processing of eligible `then_run` logs. Its Fusion integration is disabled by default and must be enabled explicitly in Distill; it preserves mutation confirmation, diff/patch details and tool error state. Action Fusion itself does not archive or summarize logs and does not depend on Distill.

## Development and provenance

```bash
npm run typecheck --workspace pi-action-fusion
npm test --workspace pi-action-fusion
```

Regression tests cover the upstream fusion semantics, cancellation, queues, paths and native tool compatibility. Offline SDK tests verify actual tool hooks and failure state without API keys. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and [LICENSE](./LICENSE) for upstream attribution.
