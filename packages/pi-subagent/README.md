# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own detached tmux session with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, or queue follow-ups; the extension shows running subagents above the editor, and `/subagent` attaches to one.

## Requirements

- Pi
- Node.js 22.18 or newer
- tmux

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

Spawn prints `spawned <handle> <name>`; the handle is the identifier for every later command. Results go to stdout and hints to stderr, so output stays pipeable: `subagent wait <handle> > report.md` captures only the response. When a run is idle, stderr adds one instruction such as ``Use `subagent stop a1b2c3` to stop this subagent when it is no longer needed.``.

Add `--json` to `spawn`, `status`, or `list` for machine-readable fields.

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent stop a1b2c3
subagent resume a1b2c3
subagent rm a1b2c3
subagent list
```

Use `subagent list` to see every run of this session with its handle, name, state, age, working directory, and model; `subagent status` prints the same facts for one run as `key: value` lines.

Each run owns the tmux session `pi-subagent-<handle>`. While it is running the extension draws a `Subagents` box above the editor; `/subagent` picks one and attaches to it. The session name is always derived from the handle, so `tmux attach -t pi-subagent-a1b2c3` works too.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--extension <path>` / `-e <path>`: load one extra extension (repeatable). Use with `--no-extensions` to keep only the control bridge plus named extensions
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are shut down but their transcript and metadata are kept; resuming that parent session relaunches them with their full history. That shutdown is not `subagent stop`: only an explicit `stop` or `rm` ends a run, so a child that quits or is killed on its own is relaunched as well.
