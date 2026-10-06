# @maplezzk/pi-subagents — unified subagents

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

One `Agent`/RPC/management interface, with configurable in-process and terminal
execution. Agent definitions, scheduling, queues, results and the Fleet/widget UI
belong to `pi-subagents`; terminal operations use `pi-terminal-mux`. The independent
`pi-workflow` package owns workflow definitions, orchestration, journals and `/wf`.

## Activation and publication

The repository's Git/local profile loads this product by default, together with
`pi-workflow`. The package remains npm-private and unpublished; publication
readiness is separate from runtime activation. Do not co-load the retired
`pi-interactive-subagents` entry or another copy of the upstream subagents extension.
The old package is a source-only snapshot, not an active or released workspace.
Imported management-UI strings still require complete catalog migration before
npm publication; new controls and diagnostics use bilingual catalogs.

See the [migration guide](./docs/migration.md) before reloading an existing setup.
Old live tasks and IDs are not transferred automatically.

The unified entry does **not** register the old `subagent`, `subagent_resume`,
`subagents_list`, `subagent_interrupt`, `/plan`, or `__pi_subagents` compatibility
surface. It also disables the unrelated upstream `SubagentWorkflow` engine.
The upstream source/tests remain available for comparison, not as a second
workflow product.

For an isolated development session from this checkout:

```sh
pi --no-extensions \
  -e ./packages/pi-extensions-i18n/index.ts \
  -e ./packages/pi-subagents/index.ts \
  -e ./packages/pi-workflow/extension.ts
```

Load additional tool extensions explicitly when the main session needs them.
This command does not rewrite your installed extension profile.

## Choose the execution backend

Canonical configuration is layered from:

- `<agentDir>/subagents.json`;
- `<cwd>/.pi/subagents.json`, whose fields override global defaults.

Agent-directory resolution honors `PI_CODING_AGENT_DIR`. See
[`config.example.json`](./config.example.json) for the existing operational settings.

```json
{ "backend": "embedded" }
```

Use `"terminal"` for a separate child process/terminal surface. You can also use
`/config:subagents embedded|terminal`; it preserves unrelated project settings.
Changing the default affects **new agents only**. Existing handles and evicted
`@handle` conversations retain their backend identity.

Ordinary `Agent` calls remain autonomous in either backend. Selecting terminal does
not turn every foreground call into an indefinitely waiting interactive task.
Backend selection also applies to RPC calls, scheduled agents and workflow-stage
`Agent` calls. Unsupported execution modes report an error rather than silently
falling back to embedded.

## Tools and controls

- `Agent`: unchanged foreground/background, type, model, thinking, resume and
  context-inheritance interface. `run_in_background: false` waits for the result;
  background calls return an ID and use the existing completion notification.
- `get_subagent_result`: inspect or collect the same manager-owned records.
- `steer_subagent`: `action` defaults to `steer`, with a required `message`.
  `action: "interrupt"` stops only the current turn; `action: "stop"` retires the
  agent and closes its terminal. Both accept the existing `agent_id`/handle.
- `/agents`, Fleet/widget, mentions and RPC v2 remain the common control plane.

`Agent({ ..., interactive: true })` requests a human-driven terminal session.
It requires the terminal backend and applies only to a fresh, unscheduled agent.
The terminal can remain open across model settlement and turn interruption.
Exit through the child CLI or use the parent's stop action when the conversation
is finished; do not poll for background completion.

An agent definition can set the same preference:

```md
---
name: interactive-reviewer
description: Review changes together with the user
interactive: true
---
Inspect the changes and discuss findings with the user in this terminal.
```

`auto-exit` is also recognized. Explicit invocation mode overrides the definition;
without either preference, execution is autonomous and auto-exiting. Both backends
use Pi; there is no CLI-family selector or external Claude execution branch.
A terminal-owned conversation keeps its nested Agent work on terminal execution,
including after a backend-default change.

## Definitions and policy

Project `.pi/agents` definitions override `.agents/agents`, which override
`<agentDir>/agents`. User definitions can override built-ins, including
`general-purpose`, `Explore` and `Plan`; disabling defaults does not disable user
replacements. The common initializer loads the same registry/settings for the
normal product and the standalone workflow executor.

Tool, extension, skill, prompt, memory, model and turn settings remain part of the
agent definition. The definition is resolved before queueing so a different
workflow/configuration root cannot substitute another agent's tools at execution
time. `cwd` defaults are relative to the parent project's directory; configuration
origin remains separate from the directory where tools operate.

The terminal backend is a process boundary, **not an OS sandbox**. Extensions and
workflow definitions are executable code; install only trusted resources. Optional
terminal integrations are detected by `pi-terminal-mux`. Visible interactive use
requires an appropriate terminal environment; native Windows process supervision
is not currently supported.

## Workflow integration

The main entry also offers the versioned workflow executor. Do not load
`workflow-executor.ts` a second time alongside it. For a workflow-only launcher,
that separate entry initializes the runtime and supplies child-scoped Agent tools
without loading the root Fleet/widget UI.

The default **standard** workflow profile preserves the original SDK host shape:

```text
pi-workflow DSL / runner
  → standard WorkflowHostContext
    → native stage AgentSession with ordinary approved Pi resources
      → scoped Agent tools
        → the same embedded/terminal subagent factory
```

Stage sessions themselves remain SDK sessions. Choosing terminal in `subagents.json`
changes their delegated `Agent` work; it does not silently relocate the whole stage
or disable its extensions and skills. Fresh prompts, continuation forks, raw Pi
session recovery, model/thinking overrides, nested child scopes and bash timeout
recovery use the existing workflow contracts. Child dialogs are serialized and
cancelled with their owning scope; children cannot replace the launcher's editor,
footer or ambient widgets. This is not a migration of RPIV's lane dock.

Stock RPIV skills and tool extensions are **not bundled here**. Migrating the engine
is not an installation of its former host's entire resource bundle. Configure those
resources normally; required tools must actually be available.

### Explicit managed profile

The stricter managed embedded/terminal implementation remains available through
workflow `execution.profile: "managed"`. Its builtin-only admission, approved skill
snapshots, sticky saved policies, leases/checkpoints and fail-closed recovery are
not imposed on ordinary Agent calls or standard workflow stages.

See [managed sessions](./docs/managed-sessions.md),
[managed embedded](./docs/managed-embedded.md), and
[managed workflow resources](./docs/workflow-resources.md). Those documents describe
the isolated profile, not the general product backend.

## Validation and provenance

```sh
npm run typecheck -w @maplezzk/pi-subagents
npm test -w @maplezzk/pi-subagents
npm run check
```

Tests use temporary configuration/session directories and scripted providers; they
must not depend on credentials, a live model or a particular multiplexer daemon.
Visible terminal/provider behavior additionally needs manual smoke validation.

The embedded baseline comes from `tintinweb/pi-subagents` v0.19.0 at
`e955e29c51b7a6cce37e1108cd2d6c57a77e151c`. Terminal behavior draws on
`HazAT/pi-interactive-subagents` and this repository's existing fork. MIT attribution
is retained in [LICENSE](./LICENSE) and
[LICENSE.interactive-subagents](./LICENSE.interactive-subagents).
See [UPSTREAM.md](./UPSTREAM.md) and the [RPC reference](./docs/rpc.md).
