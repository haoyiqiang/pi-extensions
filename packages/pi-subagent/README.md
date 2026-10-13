# pi-subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own terminal panel, opened through [`pi-terminal-mux`](../pi-terminal-mux), with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, or queue follow-ups. The panel stays visible beside the current terminal; there is no `/subagent` attach command.

## Requirements

- Pi
- Node.js 22.18 or newer for native TypeScript execution
- tmux or Orca. Start Pi inside it. `PI_TERMINAL_MUX` or `PI_SUBAGENT_MUX` can force a backend.

## Install

```bash
pi install npm:pi-subagent
# or, for one run:
pi -e npm:pi-subagent
```

The extension supplies a parent-session-only [subagent skill](skills/subagent/SKILL.md). The CLI stays at the package root as `subagent.ts`, with an npm bin entry. When a parent session starts, including `pi -e`, the extension links it into Pi's bin directory (`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin`). Pi prepends that directory to the bash tool's `PATH`. An existing non-symlink `subagent` command is left unchanged.

No manual link, npm `postinstall` hook, runtime loader, or JavaScript build is added. The CLI runs directly through `#!/usr/bin/env node`. Node's native TypeScript stripping does not support files under `node_modules`, and a symlink does not bypass that restriction. Direct execution requires a source checkout outside `node_modules`; the npm-installed CLI limitation remains unresolved. The package's `build` script only type-checks and emits no files.

Run commands from the task's directory. Bundled roles are selected by name with `--role`; their paths resolve within the package. The extension manages child messaging, state, suspension, and resume.

## Usage

Discover commands and look up their arguments, defaults, and examples as needed:

```sh
subagent --help
subagent roles --help
subagent spawn --help
subagent send --help
subagent wait --help
```

All operational commands support `<command> --help` or `<command> -h`; `subagent help [command]` is an equivalent form. Help prints to stdout and exits with status 0 without reading run records or launching a panel, and does not require model settings or a multiplexer. Invalid commands or arguments still fail with a nonzero status. Use the CLI help as the parameter reference; the skill focuses on the delegation workflow.

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in panel titles and CLI output. Generated handles remain the stable identifiers used by management commands. Spawn prints the panel id.

The Pi command is submitted through `pi-terminal-mux`'s `createSurface(name, { command })` API when the panel is created, including on resume. There is no generated `launch.sh`, fixed shell-ready delay, or separate terminal input injection. tmux starts the command through `split-window`; Orca receives `--command` and manages shell startup/submission itself. A returned panel id confirms creation/submission, not that Pi is ready; the control bridge records the child's state.

Override the model configuration when needed:

```sh
subagent spawn \
  --model openai-codex/gpt-5.4-mini \
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

Users can press Escape in the child panel, then enter a correction to continue. `wait` keeps waiting when the latest assistant reply has `stopReason: "aborted"`, and returns the next normal reply after the child becomes idle. Execution errors, child exit, and timeout still return failure; `wait` does not close the panel. The default 1800-second deadline includes time spent waiting for user input. Retry cancellations that Pi reports as errors remain errors.

## Roles

The parent model already sees the role catalog. Inspect presets through the CLI when needed, then spawn without repeating their settings:

```sh
subagent roles
subagent spawn \
  --role explore \
  --name authentication-lookup \
  --prompt "Find authentication entry points and references. Search breadth: medium. Return absolute paths and line references; do not modify files or run builds/tests."
```

Roles are Markdown files in `skills/subagent/references/` with required `name` and `description`, optional startup presets, and a system-instruction body:

```yaml
name: explore
description: Locate files, symbols, and references through read-only search.
tools: [read, bash, grep, find, ls]
extensions: true
```

The extension advertises only role names and descriptions in the **parent** system prompt and instructs the model to read and follow the subagent skill before delegating. Children receive neither this catalog nor the extension-provided subagent skill. Full bodies and preset values stay out of the parent catalog. `spawn --role <name>` automatically applies presets and appends the body without frontmatter. `--role` is optional: an ordinary child uses CLI options and parent/Pi defaults. `--name` is an independent display label.

Precedence is **explicit CLI > Markdown preset > parent/Pi defaults**, without conflict errors. `--model provider/model` and `--thinking` override role values. `--tools` or `--no-tools` replaces the role's tool list. Any `-e/-ne` replaces its whole extension preset: `-e A` keeps ordinary discovery and explicitly loads A; `-ne -e A` loads only A plus the mandatory control bridge. Role sources are never silently merged into a CLI selection.

`tools` accepts a string array (`[]` disables all tools). `extensions` accepts `true` for ordinary discovery, `false`/`[]` to disable it, or an array to load only the specified paths/package sources. Relative role extension paths resolve from the role file's directory; package sources are unchanged. Unspecified fields retain defaults, and unknown frontmatter fields are ignored. Only the package's role directory is scanned.

`subagent roles` remains an inspection command, showing **Name, Description, Model, Thinking, Tools, Extensions** as Markdown. Undeclared values appear as an em dash; arrays use JSON without changing path whitespace. It does not install extensions or start children. [SKILL.md](skills/subagent/SKILL.md) describes the workflow; CLI help describes arguments.

The three built-in roles follow [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) at revision `e955e29c51b7a6cce37e1108cd2d6c57a77e151c`, using lowercase names:

| Role | Use for | Tools preset |
|---|---|---|
| [general-purpose](skills/subagent/references/general-purpose.md) | Implementation, research, code review, and other multi-step tasks | CLI/Pi defaults |
| [explore](skills/subagent/references/explore.md) | Targeted file, symbol, and reference lookups; specify quick, medium, or very thorough search breadth | `read,bash,grep,find,ls` |
| [plan](skills/subagent/references/plan.md) | Read-only implementation planning with concrete steps, trade-offs, and critical files | `read,bash,grep,find,ls` |

All three inherit model and thinking unless a preset pins them; no upstream model pin is copied. Explore and Plan instructions are adapted from the reference and retain its [MIT license](skills/subagent/references/LICENSE). General-purpose has brief task-driven guidance and no special tool restriction; omitting `--role` remains valid. Instructions are additive, not the upstream replacement mode. None requires TODO tooling, report files, commits, or a multi-phase approval workflow.

Use `general-purpose` or a plain child for reviews, design-document audits, cross-file consistency checks, and broader analysis; `explore` is a focused search role. Follow the task's authorization for edits, checks, and commits. Roles do not grant permissions, sandbox Bash, or automatically stop the child.

For custom instructions, use repeatable `--append-system-prompt <text|path>`. Existing files are read verbatim, including any frontmatter; other values are literal text. Verify custom paths exist. Relative paths resolve from the invoking shell's directory, even with `--cwd`. A selected role comes first, followed by extra additions in flag order. The combined content is saved as `append-system-prompt.md` in the run directory and appended to Pi's normal system prompt, preserving `APPEND_SYSTEM.md`. Follow-ups, reloads, and resume reuse that snapshot. Ordinary Pi settings and context files are still discovered normally.

`--prompt` is the task's user message; `--file` is a task attachment. A role alone is not a task: supply at least one of them. Children start with a new conversation, not a fork of the parent's history. There is no system-prompt replacement mode.

## Configure

`/config:subagent` opens a TUI panel for the role presets. Select a role to edit its fields:

- Model: any available session model, or inherit the parent's.
- Thinking: cycle through Pi's thinking levels, or inherit the parent's.
- Tools: toggle tools from the session's tool list, inherit Pi's defaults, or disable all tools.
- Extensions: toggle ordinary discovery or individual sources. Candidates come from configured packages and Pi's extension directories; selecting any source replaces ordinary discovery.
- Prompt (Markdown): edit the role's Markdown body in Pi's editor; the frontmatter is preserved.

Preset changes are written back to `skills/subagent/references/<role>.md`, preserving the Markdown body and unrelated frontmatter. Spawn options still override the presets: `--model`, `--thinking`, `--tools`, and `-e`/`-ne` replace the role's values for that run.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist, overriding role tools
- `--no-tools`: disable all tools; mutually exclusive with `--tools`
- `-e / --extension <path|source>`: explicitly load an extension file, directory, or package source; repeatable
- `-ne / --no-extensions`: disable ordinary discovery; explicit extensions and the control bridge still load
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Use `-ne -e ./extensions/todo.ts` to select explicit extensions without ordinary discovery. Local CLI extension paths resolve from the invoking shell's directory, even with `--cwd`; package sources are passed to Pi unchanged. Resolved tool and extension settings are saved for resume, and the control bridge is always retained. The launcher always invokes Pi, never an automatically selected `pi-test.sh`. When disabling discovery, explicitly retain any extension that registers your custom model provider.

Run metadata lives in `<agent-dir>/extensions/pi-subagent/runs`. Existing runs under `<agent-dir>/subagents` remain readable. Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the panel closes, but transcript and metadata are kept. Resuming that parent session opens a new panel with their full history. Inbox messages are retained until their tagged user messages appear in durable session history; asynchronous rejection does not delete them. Unaccepted messages report an error and can be retried after fixing the cause and reloading/resuming the child. Metadata updates are locked across processes, and `wait` rejects stale responses predating a send. The `stop` command removes a run only after panel absence is confirmed; closure failure or uncertainty preserves the run.
