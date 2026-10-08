# Switch to unified Pi subagents and workflows

> [中文说明](./migration.zh-CN.md)

The repository's default Git/local profile now loads `pi-subagents` and
`pi-workflow`, not `pi-interactive-subagents`. This is a runtime-profile switch,
not an npm publication. The two new products remain `private: true`; the retired
source is archived outside the repository and no longer participates in workspace
builds, tests or releases. The unified package retains its MIT attribution.

## Before reloading

1. Finish or stop active legacy subagents. Live processes and legacy task IDs are
   not transferred to a different manager by `/reload`.
2. Run `pi list` and choose one installation style. If the repository is already
   your package source, updating that checkout changes the default entries; no
   global settings rewrite is needed.
3. If you separately installed the old npm package or an explicit old extension
   path, remove that declaration before enabling the unified entry. Use the exact
   source printed by `pi list` with `pi remove <source>`, or edit your settings
   deliberately. Do not co-load old and new products.
4. Back up any configuration you intend to edit. This migration does not delete
   old configuration, session files, `.pi/workflows` outputs, or `.rpiv` journals.

For the complete suite:

```sh
pi install git:github.com/maplezzk/pi-extensions
```

The complete suite also enables Spark, Blackhole and the other root-profile
extensions. Do not add it alongside separately installed copies of the same
extensions. For a selective local launch, use:

```sh
pi --no-extensions \
  -e ./packages/pi-extensions-i18n/index.ts \
  -e ./packages/pi-subagents/index.ts \
  -e ./packages/pi-workflow/extension.ts
```

The workflow-only `pi-subagents/workflow-executor.ts` entry is an alternative to
`pi-subagents/index.ts`, never an additional executor to load with it.

Use Pi 0.87.1 or a tested compatible runtime, with Node.js 22 or newer. Restart
Pi or run `/reload` after stopping old work. New tool definitions apply to that
new extension generation; existing conversations can still contain historical
calls to tools that no longer exist.

## Backend and agent definitions

Both execution backends use Pi. There is no external Claude CLI branch or CLI
selector; Pi's own model providers remain independent of the execution backend.

- Default: `embedded`, with ordinary autonomous Agent execution.
- Open `/config:subagents` without arguments, then **Settings → Execution backend (project)**
  to select `terminal` or `embedded`. Only approved project overrides are written;
  global defaults remain read-only.
- Configuration: `<agentDir>/subagents.json`, overlaid by
  `<project>/.pi/subagents.json`. `PI_CODING_AGENT_DIR` is supported.

Legacy interactive-subagents configuration is not read as this new schema. Agent
Markdown definitions use `<agentDir>/agents`, `.agents/agents`, and `.pi/agents`;
project definitions take precedence. Review old CLI-specific tools/model options
rather than assuming their names mean the same thing in Pi.

Selecting terminal does not make every task human-driven. Set `interactive: true`
on the Agent invocation or agent definition for a persistent interactive terminal.
A visible interactive session requires a supported multiplexer. Autonomous terminal
work can use the headless process fallback. Existing sessions retain their backend;
terminal descendants stay on their saved terminal branch.

### Extension-default migration

`defaultExtensions` in global/project `subagents.json` is optional: absent in both
layers still means `true` for compatibility. Use `true` for all approved ordinary-child
resources (including future discovery), `false` or `[]` for none, or a string array
for explicit selectors. **Settings → Default extensions (project)** saves only the
project key; Reset deletes it to inherit global/default. Multi-select Ctrl+A saves
an explicit current list, not future-inclusive `true`; Esc cancels without writing.
Global configuration is never changed by this UI.

Omitted agent `extensions` now follows this default; explicit values override it.
Existing user definitions with `extensions: true` stay explicit and are not rewritten.
`isolated: true`, `exclude_extensions`, and root/UI filtering still apply. Discovery
uses approved Pi resources, not an exact copy of the parent's loaded list or temporary
CLI sources. Opening the picker performs metadata discovery only, with missing remote
packages skipped: no imports, factories, installs, or resource reload.

The deprecated frontmatter/programmatic `inherit_extensions` field is **rejected**,
including when the same definition also has `extensions`. Rename/remove the legacy
field; use only `extensions`, or omit it to follow defaults. There is no compatibility
alias or automatic file migration. Details show policy/source, not actual loaded
extensions; newly saved defaults apply only at new admission.

## Tool and command changes

| Retired surface | Unified surface |
| --- | --- |
| `subagent` | `Agent`, with `prompt`, `description`, `subagent_type`, and optional `run_in_background` |
| `subagent_resume` | `Agent` with `resume` referencing a **new manager-owned** agent ID |
| `subagent_interrupt` | `steer_subagent` with `action: "interrupt"` |
| End the task, retain the session | `steer_subagent` with `action: "cancel"` |
| Retire ownership after cleanup | `steer_subagent` with `action: "close"` |
| Background result | `get_subagent_result` |
| `subagents_list` / old management command | `/config:subagents` management panel and above-editor AgentWidget |
| `/plan`, `/iterate` | Explicit workflow definitions run through `/wf`; no aliases |
| `__pi_subagents` global bridge | Versioned event-bus RPC; see [RPC](./rpc.md) |

The original `pi-subagents` Symbol manager view remains a view of the same root
manager for its existing consumers. It is not the retired interactive bridge.
The separate upstream `SubagentWorkflow` engine is not activated.
`/agents` and backend command arguments are removed, with no aliases. FleetView and
its terminal-input shortcuts are removed without a replacement. AgentWidget,
Agent/RPC execution and persisted sessions remain; legacy `fleetView` keys are
ignored without rewriting user files.

## Workflow migration

`pi-workflow` owns `/wf`, `/wf-cancel`, the DSL, journals and recovery. Its normal
`standard` profile preserves native SDK stage sessions and ordinary approved Pi
resources. Stage-level Agent delegation uses the common subagent backend. Do not
set a managed stage backend merely to choose where those Agent calls execute.

Project definitions remain at `.rpiv/workflows/config.ts`; user definitions and
journals keep their documented legacy paths. See the [workflow README](../../pi-workflow/README.md)
for a minimal two-stage definition and model/thinking tiers.

- Workflow settings: `<agentDir>/extensions/pi-workflow/config.json` and
  `<project>/.pi/pi-workflow.json`.
- Model resolution: preset-stage → stage → skill → defaults. With no override,
  standard stages use Pi SDK settings defaults, not the current launcher selection.
- No RPIV skill pack, tool bundle or lane dock is installed by this migration.
  Configure dependencies used by your own definitions before running them.
- Standard execution can recover ordinary Pi JSONL sessions. Managed execution
  still requires its own saved policy/checkpoint evidence; it does not silently
  adopt ordinary or legacy sessions.
- Old `.pi/workflows/*.json` task/report outputs are not executable workflow DSL
  definitions. They are retained, not converted or run automatically.

## Acceptance

Check one new Agent task, its result, and interrupt/cancel/close before long jobs. Then
run a small file-defined workflow, inspect its journal, cancel a run, and resume a
failed stage. Confirm that required skills, tools and models exist in your setup.

Repository tests cover the package composition and real offline SDK/process paths.
They are not a claim that every personal workflow or live provider was exercised.
Neither user-global configuration changes nor npm publication is performed by the
repository migration itself.
