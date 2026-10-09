# @maplezzk/pi-todo

A branch-aware todo extension for Pi. It registers the model-facing `todo` tool, the `/todos` command, and a compact `rpiv-todos` widget above the editor in TUI mode.

## Features

- Full task snapshots are stored in every `todo` tool result, so state follows the current session branch and survives `/reload`, tree navigation, and compaction.
- Session-keyed in-memory state keeps root and child sessions separate.
- `blockedBy` dependencies reject unknown, deleted, self-referential, and cyclic edges.
- The widget shows pending, in-progress, and completed work, hides completed rows after the next turn, supports a configurable row budget, and can be collapsed.
- Headless, print, JSON, RPC, and nested SDK sessions retain the tool and replay behavior without taking ownership of the root TUI widget.
- All active UI, guidance, schema, and model-facing messages use the repository `en-US` / `zh-CN` catalog. Tool/schema/command metadata refreshes on startup locale resolution and language changes without resetting task state or configured guidance.

## Install

```sh
pi install npm:@maplezzk/pi-todo
```

Reload Pi after installation. The package also loads `pi-utils`, which provides `/config:language` and `/languages`.

## Tool

The `todo` tool supports:

- `create`: create a pending task; `subject` is required.
- `update`: change fields, status, metadata, or dependencies.
- `list`: list tasks, optionally filtered by status; deleted tombstones are hidden unless `includeDeleted` is true.
- `get`: show one task plus forward and reverse dependency edges.
- `delete`: mark a task deleted without removing its historical identity.
- `clear`: clear the list and reset the next id to 1.

Statuses are `pending`, `in_progress`, `completed`, and `deleted`. See [docs/tool-schema.md](docs/tool-schema.md).

## UI

- `/todos` prints the current session's visible tasks grouped by status.
- The TUI widget uses the historical key `rpiv-todos` so existing session/UI behavior remains compatible.
- The default collapse shortcut is `ctrl+shift+t`; set `collapseKey` to `"off"` to disable it.
- Failed operations render as errors even when the requested status was `completed`; failed mutations do not change the task snapshot.
- The extension does not replace Pi's editor, footer, or header.

## Configuration

Create:

```text
~/.pi/agent/extensions/pi-todo/config.json
```

If `PI_CODING_AGENT_DIR` is set, that directory replaces `~/.pi/agent`.

```json
{
  "maxWidgetLines": 12,
  "collapseKey": "ctrl+shift+t",
  "guidance": {
    "promptSnippet": "Manage a task list to track multi-step progress",
    "promptGuidelines": ["Create and update tasks as work progresses."]
  }
}
```

The old XDG path `rpiv-todo/config.json` is read only when the canonical file is absent. This package never writes the legacy path. See [docs/configuration.md](docs/configuration.md).

## Development

```sh
npm test
npm run typecheck
```

Tests use a temporary HOME and agent directory and require no network, credentials, live model, or terminal multiplexer.

## Provenance and license

This is a Pi `0.87.1` port of the MIT-licensed `rpiv-todo` implementation. See [UPSTREAM.md](UPSTREAM.md) and [LICENSE](LICENSE).
