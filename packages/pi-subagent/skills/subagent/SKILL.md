---
name: subagent
description: Spawn and communicate with observable Pi subagents for second opinions, independent investigations, and delegated implementation work.
---

# Subagent

Use the `subagent` CLI to delegate work to a separate Pi process with its own context and tmux session. Managed subagents cannot spawn nested subagents, and this skill is not loaded into their sessions.

## Spawn

Give each child a short, descriptive name. The name appears in the parent UI, while the generated handle remains its stable identifier:

```sh
subagent spawn --name implementation --prompt "Complete task"
```

By default, the child inherits the current Pi provider, model, and reasoning level from the bash environment. Use `--provider`, `--model`, or `--thinking` only when deliberately choosing a different configuration, for example a faster model for simple investigation or a stronger model for difficult review. Never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back to the CLI explicitly.

`--cwd` defaults to the current directory. To run a child in an existing Git worktree, pass `--cwd /path/to/worktree`. Repeat `--prompt` and `--file` as needed; Pi receives all of them in the first user turn. Run `subagent spawn` directly without piping or redirecting its concise output.

## Tools

Without `--tools`, Pi enables its four default tools:

- `read` - Read text files and images.
- `bash` - Execute shell commands. This can also modify files, so it is not a read-only capability.
- `edit` - Apply exact text replacements to existing files.
- `write` - Create or overwrite files.

Three additional built-in tools are available but off by default:

- `grep` - Search file contents.
- `find` - Find files by glob pattern.
- `ls` - List directory contents.

`--tools` is a comma-separated allowlist across built-in, extension, and custom tools. Common choices:

```sh
# Enforced read-only repository investigation
--tools read,grep,find,ls

# Investigation that may run tests or other commands; bash can modify files
--tools read,bash,grep,find,ls

# Implementation work: omit --tools to use the defaults
```

## Isolation flags

- `--no-extensions` - Disable normal extension discovery. Use for an independent run that should not inherit unrelated extension behavior or extension-provided tools. The subagent control bridge is still explicitly loaded.
- `--extension <path>` - Load one extra extension file or directory. Repeatable. Combine with `--no-extensions` to keep only the control bridge plus the named extensions, for example a custom model-provider extension.
- `--no-skills` - Hide installed skills from the child. Use for tightly specified tasks that should rely only on the supplied prompt and files.
- `--no-prompt-templates` - Disable prompt-template commands. Usually unnecessary, but useful when testing a minimal child environment.
- `--no-context-files` - Ignore repository instruction files such as `AGENTS.md` and `CLAUDE.md`. Use only when those instructions would bias an independent investigation. Do not use for implementation unless intentionally bypassing repository guidance.

Spawn prints a random handle. Each run owns the tmux session `pi-subagent-<handle>`, shown in the `Subagents` box above the editor while it runs; `/subagent` attaches to one. Keep the handle for later commands. Subagents persist after their current turn completes: `wait`, completion, and becoming idle do not terminate them. They survive `/reload`. When the spawning Pi session quits or is replaced, their processes are shut down but their transcripts are kept, and resuming that session relaunches them with full history. That shutdown is not the same as `subagent stop`: only `subagent stop` and `subagent rm` end a run, so a child that quits or is killed on its own is relaunched too.

## Inspect and wait

```sh
subagent status <handle>
subagent list
subagent wait <handle>
```

Run `subagent list` at any time to rediscover active subagents and their handles, names, and current states if you no longer remember them.

`wait` follows the durable session state and prints the latest final assistant response. Run it directly so the bash tool returns that response; do not redirect it to a file or pipe it unless the user explicitly asks for an artifact. Do not infer completion from captured terminal text. Set the bash timeout above `wait`'s default 1800-second deadline.

## Communicate

```sh
# Change the name shown in the parent UI.
subagent rename <handle> "new name"

# Idle: starts a new prompt. Busy: steers the current work.
subagent send <handle> "message"

# Busy: waits until current work finishes, then starts another turn.
subagent send <handle> --follow-up "message"
```

Names are 1–64 characters and need not be unique. Messages use the subagent extension's control inbox; do not send terminal keys.

## Stop, resume, remove

```sh
# End the run but keep its transcript.
subagent stop <handle>

# Reopen a stopped or interrupted run with its full history.
subagent resume <handle>

# Delete the transcript of a run that is not running.
subagent rm <handle>
```

Explicitly stop every subagent when it is no longer needed; do not leave completed subagents running idle. Stopping keeps the record, so `resume` can reopen it later and `rm` is the only command that deletes history. A run whose tmux session disappeared without `stop` — a machine restart, for example — reports `interrupted` and is relaunched when the parent session is resumed.
