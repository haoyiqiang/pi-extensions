# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own terminal panel with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, or queue follow-ups; the panel sits beside the current terminal, so no attach command is needed.

## Requirements

- Pi
- Node.js 22.18 or newer
- tmux or Orca. Start Pi inside one of them; override detection with `PI_TERMINAL_MUX` or `PI_SUBAGENT_MUX`. Outside both, spawn falls back to a headless background child whose output is read through `subagent status` and `subagent wait`, not a visible panel.

## Install

```sh
pi install npm:@kevinhao/pi-subagent
```

Run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically. Its CLI still has to be reachable as `subagent` on the bash tool's `PATH`.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

Override the model configuration when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools for a read-only investigation:

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

Close a one-shot delegation automatically instead of remembering to stop it:

```sh
subagent spawn --auto-stop --name audit --prompt "Audit the dependency edges"
```

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

Use `subagent status` to see active runs and their current state. Each run prints its panel ID; the panel itself is already open beside the parent. A headless run prints a `headless:` ID and has no panel to look at.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the panel closes, but transcript and metadata are kept. Resuming that parent session reopens them with their full history. `subagent stop` removes a run permanently, and preserves it when panel closure cannot be confirmed. `--auto-stop` runs that same stop at the end of the turn that spawned or last used the run, provided the child is idle with nothing queued; busy, failed, or already exited runs keep their records for inspection.
