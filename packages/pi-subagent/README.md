# pi-subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own terminal panel, opened through [`pi-terminal-mux`](../pi-terminal-mux), with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, or queue follow-ups. The panel stays visible beside the current terminal; there is no `/subagent` attach command.

## Requirements

- Pi
- Node.js 22 or newer
- A supported terminal multiplexer (muxy, cmux, tmux, zellij, wezterm, herdr, otty, or orca). Start Pi inside it. `PI_TERMINAL_MUX` or `PI_SUBAGENT_MUX` can force a backend.

## Install

```bash
pi install npm:pi-subagent
# or, for one run:
pi -e npm:pi-subagent
```

No manual symlink is required. When a parent session starts, including `pi -e`, the extension links its own `subagent.ts` into Pi's bin directory (`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin`). Pi prepends that directory to the bash tool `PATH`. An existing non-symlink `subagent` command is left unchanged.

An npm `postinstall` hook is not used. `pi -e <path>` never runs package scripts, and `pi -e npm:...` installs into a temporary directory. Linking at session start covers both.

The linked file is TypeScript on purpose. The shell looks up the name `subagent`, not the `.ts` suffix. `subagent.ts` starts with `#!/usr/bin/env node`, so the kernel runs it with Node. Node 22.18 or newer strips the types and loads the real file; imports such as `./shared.ts` resolve next to that file, not inside `bin`.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands. Spawn prints the panel id.

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

The status widget shows active names (or handles for unnamed runs) and their current state.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the panel closes, but transcript and metadata are kept. Resuming that parent session opens a new panel with their full history. `subagent stop` removes a run permanently.
