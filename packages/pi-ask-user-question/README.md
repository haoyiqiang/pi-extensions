# @maplezzk/pi-ask-user-question

A Pi extension that registers the `ask_user_question` tool. Agents can present up to four structured questions without guessing through ambiguous requirements.

## Features

- One to four questions per invocation.
- Two to four options per question.
- Single-select and multi-select answers.
- A built-in free-text answer row on every question.
- Per-question notes and an optional global review note.
- Markdown previews for single-select options.
- Tabbed review and partial submission for multi-question dialogs.
- An owned Pi multiline editor for custom answers: inline `Ctrl+G` opens the editor view, its configured confirm key applies the draft, `Esc` discards it, and `Ctrl+G` inside that view launches the configured external editor.
- Native RPC dialog fallback using `select` and `input`.
- Structured tool details for replay and renderers.
- Compatibility events: `rpiv:ask-user:prompt` and `rpiv:ask-user:blocked`.
- English and Simplified Chinese UI, prompts, schema descriptions, errors, and notices.

## Host behavior

- **TUI:** renders an owned `ctx.ui.custom()` overlay only when `ctx.mode === "tui"`.
- **RPC:** walks questions through native `ctx.ui.select()` and `ctx.ui.input()` dialogs.
- **Print/JSON/headless:** removes the tool from the active tool set; a direct call returns a structured `no_ui` or `no_custom_ui` result. A UI load failure is never reported as a user refusal.

The extension does not replace Pi's root editor, footer, header, widgets, status area, or terminal title. Its multiline editor exists only inside the active questionnaire overlay.

## Configuration

Create:

```text
$PI_CODING_AGENT_DIR/extensions/pi-ask-user-question/config.json
```

`PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`.

```json
{
  "collapseKey": "ctrl+]",
  "guidance": {
    "description": "Optional replacement tool description",
    "promptSnippet": "Optional replacement prompt snippet",
    "promptGuidelines": ["Optional replacement guidance"]
  }
}
```

`collapseKey` accepts Pi key specifications such as `alt+o` or `ctrl+shift+h`; use `off` to disable collapsing. Invalid fields fall back safely and produce a sourced `ask` notice. If the canonical file is absent, the legacy RPIV config path is read only for compatibility; it is never written.

The external-editor command follows Pi's `externalEditor` setting, then `$VISUAL`, `$EDITOR`, and the platform default. The extension always reads global settings. It reads `.pi/settings.json` only when the persistent trust store marks the working directory trusted, or when it has not been explicitly denied and global `defaultProjectTrust` is `always`. Session-only trust is intentionally not inferred from private host state. Cancelling waits for the launcher process started by this extension to actually close before restoring the TUI; an editor that delegates to an already-running shared GUI may outlive that launcher.

## Tool result

The tool returns normal Pi tool content plus structured details:

```ts
{
  answers: Array<{
    questionIndex: number;
    question: string;
    kind: "option" | "custom" | "multi";
    answer: string | null;
    selected?: string[];
    notes?: string;
    preview?: string;
  }>;
  cancelled: boolean;
  globalNote?: string;
  error?: string;
}
```

## Events

- `rpiv:ask-user:prompt`: emitted immediately before a usable TUI or RPC prompt starts.
- `rpiv:ask-user:blocked`: emitted with `{ active: true }` while waiting for the user and always paired with `{ active: false }` in cleanup.

## Development

```bash
npm test --workspace @maplezzk/pi-ask-user-question
npm run typecheck --workspace @maplezzk/pi-ask-user-question
```

See `UPSTREAM.md` for provenance.
