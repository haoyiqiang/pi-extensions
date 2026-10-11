---
name: subagent
description: Spawn and communicate with observable Pi subagents for independent reviews, investigations, planning, and delegated implementation work.
---

# Subagent

Use the `subagent` CLI to delegate work to a separate Pi process with its own terminal panel and durable conversation. Managed subagents cannot spawn nested subagents, and this skill is not loaded into their sessions.

Use `subagent --help` or `subagent <command> --help` when unsure about syntax or defaults; do not repeat queries whose answers are already in context.

## Spawn

Give each child a short, descriptive name. The generated handle is its stable identifier:

```sh
subagent spawn --name implementation --prompt "Complete task"
```

The child inherits the parent Pi provider, model, and reasoning level from the bash environment. Override them only deliberately or as requested. Never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back explicitly.

`--cwd` defaults to the current directory. The child does not inherit the parent's conversation: supply a self-contained task with the scope, necessary context, constraints, and expected result. Repeat `--prompt` and `--file` as needed; both enter the first user turn.

Select reusable roles from the names and descriptions already advertised in the parent's system prompt. Do not read every role body or run `roles` just to rediscover that catalog; use `subagent roles` only to inspect presets when needed. Check required capabilities and authorization. Use a plain child if no role fits or its workflow conflicts with the task.

```sh
subagent spawn --role explore --name investigation --prompt "Find authentication entry points; search breadth: medium"
```

Use `explore` for targeted file, symbol, and reference lookups; specify search breadth as quick, medium, or very thorough. Use `plan` for read-only implementation planning. Use `general-purpose` or a plain child for implementation, reviews, and broader analysis. Do not route reviews or cross-file consistency audits to `explore`. None of these roles requires TODO tooling, report files, or commits. All inherit model and thinking; `explore` and `plan` preset read-only tools, while `general-purpose` retains CLI/Pi tool defaults.

`--role` applies model, thinking, tools, and extensions presets from `references/`. Explicit CLI options override presets; omitted fields use parent/Pi defaults. Any `-e/-ne` replaces the whole extension preset, not just its source list. The role body is appended without frontmatter to Pi's normal system prompt, preserving `APPEND_SYSTEM.md`. Resolved settings and instructions are saved for follow-ups and resume.

Use `--append-system-prompt` for custom text or files, `--prompt` for the task, and `--file` for task attachments. Resolve custom file paths from the invoking shell's directory, even with `--cwd`; verify they exist and quote absolute paths.

Bash can modify files despite read-only role instructions; tool selection is not a sandbox. Retain repository guidance for implementation unless intentionally overridden.

Run spawn directly, without piping or redirecting its concise output. Keep the handle and panel ID. Panel creation is not proof of task completion; do not attach to a separate tmux session.

## Inspect and wait

```sh
subagent status <handle>
subagent list
subagent wait <handle>
```

Use `list` to rediscover existing runs and handles; use `roles` only to inspect role presets not already in context.

`wait` returns the durable non-aborted assistant response when the child is idle and its inbox is empty. An aborted reply keeps waiting for continuation; errors, child exit, and timeout fail. An interactive question is not completion: obtain the user's answer and continue the same child.

Run wait directly so bash returns the response. Do not redirect or pipe it unless the user asks for an artifact, and do not infer completion from terminal text. Set the bash timeout above wait's deadline; consult `subagent wait --help` for defaults and overrides. Timeout does not stop the child.

Verify findings and actual code changes before reporting completion; distinguish checks performed from checks merely recommended.

## Communicate

```sh
subagent rename <handle> "new display name"

# Idle: starts a new task. Busy: steers current work.
subagent send <handle> "message"

# Busy: queues another turn after current work finishes.
subagent send <handle> --follow-up "message"
```

Messages use the control inbox; do not send terminal keys. Renaming changes only the display label, not the handle or role instructions.

## Stop

```sh
subagent stop <handle>
```

Explicitly stop each child when it is no longer needed. Completion and wait do not terminate it. Stop confirms panel closure before deleting the transcript, metadata, and role snapshot; retain needed findings first. If closure fails or cannot be verified, it reports an error and keeps the run. Keep an idle child only for concrete follow-up work.

Children survive `/reload`. Parent quit or session replacement suspends live children; resuming the parent reopens them with their own history and saved role instructions.
