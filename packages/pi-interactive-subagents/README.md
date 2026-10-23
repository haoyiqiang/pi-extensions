# pi-interactive-subagents

Async subagents for [Pi](https://github.com/earendil-works/pi), running in native tmux or Orca surfaces. Spawn a sub-agent, keep working in the main session, and get the result steered back when it settles.

This integration supports **tmux and Orca**, not headless delegation. The shared `pi-terminal-mux` library's headless contract for other consumers is unchanged.

## How it works

`subagent()` returns after native startup and the child bridge's ready signal, **not after task completion**. The complete launch command is supplied when mux creates the surface: a detached tmux split or an Orca split placed relative to the parent terminal. There is no interactive-shell startup delay or launch-key injection, and creation does not steal focus. A live widget tracks work; durable results are steered back automatically. Core tool feedback and result delivery work even when the parent runtime has no UI.

Launch and resume replace inherited terminal-rename authority with a restricted surface context. A child cannot rename its parent's shared tmux window/session or Orca workspace/tab through the terminal naming API. Arguments, names and cwd are shell-quoted; task content is passed as a quoted argument or artifact, not evaluated as shell code.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

### Terminal confidence and bounded failures

- Inventory distinguishes **present**, **absent** and **unknown**. Failed screen capture is never proof of disappearance. Unknown inventory retains work and ownership; it does not trigger a replacement launch, delete evidence or invent success. Live-pane messaging is refused while the terminal cannot be verified.
- A confirmed missing surface preserves any already-published result. Without a settled result it produces a durable, diagnosable interruption/failure rather than waiting for a screen marker forever.
- The child publishes an independent heartbeat every 5 seconds. A long tool or provider request remains healthy without token/activity events. After 20 seconds without a fresh heartbeat, status becomes **unresponsive; execution uncertain**, not completed or automatically killed. A new heartbeat recovers the display.
- Child readiness has a 15-second budget after native creation. Failed startup cleans up its owned surface and confirms absence where possible. Closure reconciliation has a 3-second budget after the bounded backend close call; backend command/inventory timeouts are additional finite bounds. The obsolete `PI_SUBAGENT_SHELL_READY_DELAY_MS` setting is no longer used.
- Failed or unconfirmed closure retains an inspectable `<session>.terminal-<execution>.json` diagnostic and ownership, and emits a status message with that path. It does not reverse durable success or claim a completed cleanup. An ambiguous create receipt retains its launch script/diagnostic and is never automatically retried; an unidentified surface may require manual terminal inspection.

Persistent run facts now back identity, status and the widget. Full watcher takeover, inbox transport and parent recovery still belong to subsequent lifecycle slices; reading a record does not restart or take over its child.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux/Orca surface (async) |
| `subagent_message` | Address an owned collaborator by stable ID or unique name — steer active work or start the next generation |
| `subagent_status` | List this parent's recorded collaborators, or inspect an ID/name, lifecycle, liveness and latest result reference |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Readable handle, 1–64 Unicode characters after NFKC/whitespace normalization. Control characters and line breaks are rejected before launch artifacts. Default and explicit collisions are suffixed within the parent (`scout`, `scout-2`, …), shortening the base when necessary |
| `model` | string | role, then parent model | Override with an exact `provider/model` ID (or an unambiguous exact model ID) |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

Launch acknowledgement includes **stable `id`, actual assigned `name`, `generation` and startup status**. Completion retains the identity. A follow-up after settlement starts a new work generation; steering active work keeps its generation. A resident child can start another generation without another Pi process.

`subagent_message` accepts `id`, `name`, or both. Both must identify the same collaborator, and every operation is scoped to the current parent session:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
subagent_message({ id: "<id returned by subagent>", message: "Review the fix" });
subagent_status({}); // recorded collaborators, not role definitions
subagent_status({ id: "<stable id>", name: "scout" });
```

- **Running** — exact message strings (including indentation, CRLF and trailing newlines) are durably published, then the child bridge uses Pi's ID-bearing custom-message interface. No terminal keys, editor focus, slash-command expansion or shell interpretation participates. `deliverAs: "auto"` (default) and `"steer"` steer busy work; `"followUp"` waits behind the current automatic work. All modes start a prompt when idle.
- **Finished / starting** — concurrent instructions queue behind a single fenced writer reservation, rather than launching once per message. A completed child reclaims its stable identity and pinned loadout. An auto-exiting writer is not replaced until its exit is positively observed.

Optional `messageId` makes caller retries idempotent within that collaborator's inbox. Reuse the same ID, exact bytes and delivery mode; conflicting reuse fails. Queue order uses an explicit monotonically allocated `sequence`, not wall-clock/random filename order. Steering can intentionally run before an earlier follow-up, as Pi's two queues require.

Tool acknowledgements and `subagent_status.messages` separate evidence:

- `queued`: the full instruction is durably retained; the child has not acknowledged reading it.
- `accepted`: the child durably acknowledged it, possibly only queued in Pi memory. A void `sendMessage()` return is **not** consumption.
- `consumed`: its exact attempt ID is present in the persisted child transcript; `contextObserved` separately records exposure to a model request. This does **not** prove requested external effects or task completion.
- `settled`: Pi reached final settlement for that input, or an explicit reconciliation resolved it. `evidence.settled` distinguishes actual Pi settlement from a recorded `resolution`.
- `uncertain` / `paused-uncertain`: dispatch may have reached Pi or tools without a trustworthy final settlement. The full instruction, transcript association and affected `actionId` remain available; ordinary messages remain queued, not permission to repeat it.

Receiver restart automatically redelivers demonstrably never-dispatched input with the same logical ID. A dispatch-intent crash gap is conservatively paused, even when transcript inclusion can be established. Neither runtime reconstruction nor generic follow-up clears that pause. After checking the affected operation with the user, resolve the exact action explicitly:

```typescript
subagent_message({ id, authorization: {
  actionId: "<uncertainty.actionId from status>",
  decision: "retry", // user explicitly permits repeating this instruction
  reason: "User checked the destination and authorized this affected action again."
} });
// Or decision: "confirm-completed" after reliable reconciliation; do not repeat it.
```

The original evidence is retained, including authorized prior attempts. Only this collaborator is paused; the parent can continue independent work. This is controlled-interface deduplication, **not exactly-once model calls or arbitrary external side effects**. Atomic fsynced records plus observed Pi JSONL writes cover process restart; they do not promise machine/power-loss durability for Pi's transcript.

Each parent's `artifacts/<sessionId>/subagent-runs.json` retains ownership, child session, terminal/backend, validated effective loadout, writer identity, work generation and latest result reference. Atomic publication is combined with short cross-process critical sections, so unrelated concurrent updates and name reservations cannot overwrite one another. Read/write failures are errors, not an empty registry or a successful launch. Legacy interactive name registries remain inspectable; normalized duplicate aliases are ambiguous and require ID addressing. Unknown legacy writers cannot be resumed just because their surface is missing.

The managed-Pi startup script runs a **single-use writer gate before Pi opens the transcript** (opening can itself migrate/write history). Its persistent claim outlives the parent process and is reusable only after the gate observes Pi's actual exit. Replayed native startup commands fail before opening Pi. Heartbeat age, a completed task, a missing surface and a parent restart are **not** writer-exit proof. A killed exit observer or an orphaned short mutation lock is retained for inspection rather than stolen on a stale timeout. This deliberately favors a diagnosable refusal over two writers.

A replacement controller can query retained state and publish instructions to the existing fenced receiver without taking over its writer. Old-generation observation and cleanup cannot update or close its replacement. `subagent_status` and the widget project retained outcomes; completed resident surfaces are not counted as running delegated work. Full parent-runtime reload takeover, suspension and notification replay remain separate lifecycle work. Optional Claude children retain legacy terminal messaging and are not covered by the managed-Pi inbox guarantees.

**Resume replays the original loadout.** Before launch, a versioned, validated `<session>.loadout.json` snapshot records the actual tool allowlist and extension paths, qualified model, thinking, identity/prompt mode, selected skill paths, cwd/config root, isolation options, delegation policy and auto-exit/resident policy. Editing, moving or deleting the role does not change a resumed child. Required resources and model availability are checked again; references pin paths, not dependency file contents.

Missing, partial, corrupt or unknown-version snapshots cannot become unrestricted launches. Unsafe legacy records remain readable but cannot resume: the error asks you to delegate a fresh named role and leaves history intact. Restrictive legacy loadout snapshots with explicitly pinned built-in/control tools, model/thinking, cwd/config and lifecycle fields remain supported for otherwise fenced records; old custom-extension or delegation grants cannot be verified. A loadout alone is never proof that a legacy writer exited.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `openrouter/z-ai/glm-5.3` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — definitions override by declared name, not filename. Launch uses the parsed definition discovery selected, even when its declared name differs from the source filename. Hidden definitions still shadow lower-priority definitions and remain explicitly addressable.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Exact role model; precedence is call override > role > current parent model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | **Required.** Omission is a configuration error; an empty `tools:` grants only conversation and required control capabilities (`ask_question`). Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`, `subagent_status`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Defaults to `true` (autonomous); explicit `false` is resident. Replayed on resume |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory, resolved relative to the role's source root (see below) |
| `no-skills` | boolean | Disable ambient skill discovery; explicitly selected skills still load |
| `no-prompt-templates` | boolean | Disable ambient prompt-template discovery |
| `no-context-files` | boolean | Disable ambient AGENTS.md/CLAUDE.md discovery |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

Omitting `auto-exit` now defaults to **autonomous** (`true`). The child publishes its final outcome only after Pi's `agent_settled` event: provider retries, queued work, compaction and recovery may still follow a low-level `agent_end`. There is no "done" tool. Autonomous children shut down only after their complete result is durably saved; sessions and results remain available for follow-up.

Set `auto-exit: false` explicitly for a **resident** role. Each settled task still returns a result automatically, but the parent does not close the resident surface. It can accept another task in the same process. Resume restores this policy from the original snapshot rather than forcing autonomous behavior.

- **Manual input adds work, not residency.** It never changes the role's recorded lifetime policy. A manual abort is reported distinctly and leaves the child open for inspection or further input.
- **Pending work suppresses finalization:** an unanswered `ask_question` or outstanding descendant work parks the child as `waiting`. The last descendant remains outstanding until Pi accepts its result.

### Settled results

Managed Pi children retain structured result artifacts containing the complete output, outcome, error diagnostic and exact session-entry source before notifying the parent or requesting shutdown. Success, final failure, manual abort, truncated output and no new output are distinct outcomes. Failure can include useful partial work; neither truncation nor absence of a new answer is shown as unconditional success. A resumed task cannot reuse an earlier task's answer.

Automatic parent messages are bounded previews with a `Full result:` artifact reference. The `subagent_result` message details also include `outcome`, `resultFile` and `source`. Results do not depend on screen text, and a lost surface or failed diagnostic read cannot reverse an already saved outcome. A shell-level exit without a settled result is not success.

This slice retains result evidence but does **not** yet promise result replay or notification deduplication across parent restarts/reloads. Durable inbox transport and correlated multi-question replies are separate lifecycle slices. The optional Claude Code path retains its legacy completion handling; the managed-Pi settlement guarantees do not cover it.

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn any known definition, including hidden roles; a managed child may only spawn targets in its recorded `subagent_agents` list, never its own role. Launch, follow-up and resume enforce that policy from the caller's validated snapshot, not an inherited `PI_SUBAGENT_ALLOWED` or other ambient grant. Explicitly loading the controller extension does not grant delegation rights. Unknown tools and missing backing extensions fail before a runnable child is created.

**These are Pi tool restrictions, not an OS sandbox.** A child with bash/write/edit capabilities retains the user's filesystem and process permissions. Pattern-based `safe_bash` is not a security boundary. No container, worktree or arbitrary shell-side-effect isolation is added here. The optional `cli: claude` path is not covered by the managed-Pi loadout/resume guarantees.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter. Relative role cwd resolves against the project root for project roles, the agent configuration root for global roles, and this package's root for bundled roles. A relative call override resolves against the current parent's context cwd; omission inherits that actual cwd. The resolved absolute directory (including inheritance) and selected config root are recorded once, so a changed parent cwd cannot move a resumed child. Isolation options are profile-only; ordinary calls cannot override tools, skills or isolation to expand permissions.

## Status widget & configuration

The widget combines the child's business-activity snapshot with independent heartbeat freshness and terminal inventory: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (uncertain/unresponsive), or `running` (legacy CLI fallback). A frozen activity snapshot is not proof that the child is still responsive. Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Requirements

- [Pi](https://github.com/earendil-works/pi) 0.87.1 or newer
- Node.js 22.19 or newer
- A parent terminal inside [tmux](https://github.com/tmux/tmux) or Orca, with its parent pane/terminal identity available

```bash
tmux new -A -s pi 'pi'
```

## Development and verification

From the repository root:

```bash
npm ci
npm run typecheck --workspace pi-interactive-subagents
npm test --workspace pi-interactive-subagents
```

The workspace lockfile is authoritative. Pi and TUI imports use the supported
`@earendil-works` packages, with `typebox` schemas; no temporary legacy aliases or
personal extension installs are required. The package manifest can be loaded
normally, for example `pi -e ./packages/pi-interactive-subagents`.

The default suite uses the shared registered-tool/lifecycle harness, real temporary
sessions, a deterministic child runtime process, and executable terminal stand-ins.
It verifies native asynchronous launch and follow-up acknowledgements, child task
receipt, automatic parent results, and visible widgets/rendering. It makes no model
requests and does not use an existing tmux server or user terminal. A separate loader
check exercises Pi's normal package-manifest and control-extension loading.

Real-process terminal smoke tests remain explicitly opt-in:

```bash
# Inside a disposable tmux session; requires configured model credentials.
# This command starts real Pi processes and can incur model charges.
npm run test:integration --workspace pi-interactive-subagents
# Optional: PI_TEST_MODEL=provider/model PI_TEST_TIMEOUT=120000
```

This includes the [#3 native-tool prefactor](https://github.com/haoyiqiang/pi-extensions/issues/3),
[#4 role/loadout safety](https://github.com/haoyiqiang/pi-extensions/issues/4),
[#5 settled outcomes](https://github.com/haoyiqiang/pi-extensions/issues/5) and
[#6 terminal startup/liveness](https://github.com/haoyiqiang/pi-extensions/issues/6) and
[#7 persistent identity/single-writer status](https://github.com/haoyiqiang/pi-extensions/issues/7), not
all of [Spec #2](https://github.com/haoyiqiang/pi-extensions/issues/2). Public-tool tests
cover role aliases/precedence/visibility, missing versus empty tools, invalid resources
and snapshots, model/cwd/identity/skill/isolation replay, lifetime policy, nested refusals
and settled result publication. Terminal tests use the existing child runtime and
executable tmux/Orca stand-ins, with independently controlled parent/child clocks for
readiness, long work and lost liveness. The mux suite retains its startup-command/inventory
contracts. No paid model or real terminal smoke run is required for the deterministic
suite. Real controller processes also race name allocation and double resume against
shared temporary storage, replay stale/duplicate startup scripts, and verify generation
fencing and status after runtime recreation. Durable messaging and complete parent
recovery remain separate slices.
See the repository `GLOSSARY.md` and `docs/adr/0001-pause-uncertain-delegated-actions.md`
for the reviewed domain language and recovery policy.

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
