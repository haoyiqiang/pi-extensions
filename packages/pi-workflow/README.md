# @maplezzk/pi-workflow — independent workflow engine

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

Imported from [`@juicesharp/rpiv-workflow` 2.12.0](./UPSTREAM.md), retaining the stage
and loop DSL, routing, output validation, retries, audit journals, recovery and
`/wf`. Execution and subagent lifecycle belong to `pi-subagents`.

This workspace remains **private and explicitly loaded**, outside the root
profile and release configuration. It is not an installation of the complete RPIV
bundle, its default workflow pack, skills, tool extensions or lane UI.

## Architecture

```text
pi-workflow: DSL / runner / journals / /wf
    │  pi-workflow:executor:discover:v1
    ▼
pi-subagents: standard SDK WorkflowHost
    └─ stage AgentSession, normal approved Pi resources
        └─ Agent → common subagent runtime → embedded or terminal
```

The default `standard` profile keeps stage sessions SDK-based, like the original
RPIV host. Their delegated Agent calls use the backend selected in
`subagents.json`; the workflow package is no longer the only place that can choose
a subagent backend. The host preserves normal skill/template/extension behavior,
fresh prompts, raw Pi session reattach, continuation forks, model/thinking overrides,
nested scopes and bash-tool timeout recovery.

There is no cross-product runtime import. Discovery remains versioned and missing
or duplicate executors fail clearly. The old `SubagentWorkflow` engine and the old
interactive-subagent tool aliases are not loaded by the unified product entry.

## Explicit development activation

From this repository, after `npm install`:

```sh
pi --no-extensions \
  -e ./packages/pi-extensions-i18n/index.ts \
  -e ./packages/pi-subagents/index.ts \
  -e ./packages/pi-workflow/extension.ts
```

Do not also load the old interactive-subagents product. A workflow-only launcher
can replace `pi-subagents/index.ts` with `pi-subagents/workflow-executor.ts`; never
load both executor entries together. The latter supplies child-scoped Agent tools
without the root management UI. Add other main-session tool extensions as needed.

This package ships no default workflow pack. A project definition at
`.rpiv/workflows/config.ts` can be:

```ts
import { acts, defineWorkflow } from "@maplezzk/pi-workflow";

export default defineWorkflow({
  name: "inspect",
  start: "review",
  stages: {
    review: acts.prompt({ prompt: "Inspect the current changes and summarize risks." }),
    check: acts.prompt({
      prompt: "Review the findings and identify missing verification.",
      sessionPolicy: "continue",
    }),
  },
  edges: { review: "check", check: "stop" },
});
```

Run `/wf inspect review the current changes`. Use `/wf @<run-id-or-name>` to
recover a run. Continue-policy stages fork their predecessor; they never replace
the launcher's own conversation. See [workflow basics](./docs/workflow-basics.md)
and the [authoring reference](./docs/workflow-authoring.md).

## Configuration

Workflow settings are loaded per run from:

- `<agentDir>/extensions/pi-workflow/config.json`;
- `<cwd>/.pi/pi-workflow.json`, overlaying the global layer.

Agent-directory resolution honors `PI_CODING_AGENT_DIR`.
[`config.example.json`](./config.example.json) illustrates the normal profile and
model cascade; replace its model-key placeholders with models available to Pi:

```json
{
  "execution": {
    "executor": "pi-subagents",
    "profile": "standard",
    "maxConcurrency": 4
  }
}
```

Optional `models` entries select stage model/thinking overrides:

```json
{
  "models": {
    "defaults": { "model": "provider/default-model", "thinking": "medium" },
    "stages": { "review": { "thinking": "high" } },
    "skills": { "quick-check": "provider/fast-model" },
    "presets": {
      "inspect": {
        "stages": { "review": { "model": "provider/review-model", "thinking": "off" } }
      }
    }
  }
}
```

A leaf is either a model string or `{ "model"?, "thinking"? }`; `thinking`
accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Resolution
uses the first matching tier: `presets.<workflow>.stages.<stage>`, `stages.<stage>`,
`skills.<skill>`, then `defaults`. The selected leaf is composed with `defaults`;
competing stage/skill/preset leaves never merge fields with each other.

The project layer overlays global model entries by key: project `defaults` replaces
global `defaults`; `stages` and `skills` merge by entry name; `presets` merge by
workflow and stage, with a project leaf replacing the same global leaf. If no model
entry resolves, a fresh standard child uses the native SDK settings baseline rather
than inheriting the launcher's current model or thinking level.

To select delegated terminal agents, configure **subagents**, not stage placement:

```json
{ "backend": "terminal" }
```

Save that in `.pi/subagents.json`, or use `/config:subagents terminal`.
The standard run records and reuses its selected delegation backend on recovery.
It does not convert existing sessions across backends.

`requiredTools` is a list of minimum active tool names, not a grant. Standard
children check the actual activated tools. Ordinary resources must be installed
and permitted by the launcher's project-trust decision. Root orchestration/UI
products are filtered from stage sessions, while normal tool extensions remain
available. RPIV-specific substitutions require the corresponding RPIV resource
extension; the workflow engine does not emulate it or bundle its helper assets.

Optional `execution.maxTurns` limits stage turns. The bash watchdog retains
`RPIV_BASH_TIMEOUT_MS`: default 180 seconds, bounded between 5 seconds and 30
minutes per bash command. It supplies the original `toolTimeout/resetToolTimeout`
recovery hooks rather than treating an overrun as an ordinary user cancellation.

### Managed execution is explicit

For the existing restricted isolated execution profile:

```json
{
  "execution": {
    "profile": "managed",
    "backend": "terminal",
    "agentType": "general-purpose",
    "maxConcurrency": 4
  },
  "skills": [],
  "requiredTools": ["read", "bash"]
}
```

In this profile, `execution.backend` places the stage itself, and `agentType`
selects its definition. `skills` holds explicit instruction approvals with `name`,
`filePath`, `baseDir`, `format` (`pi` or `positional-v1`), and optional `requiredTools`
and `expectedSha256`. Relative paths resolve against the config file that defines
them. Project skill/required-tool arrays replace global arrays.

Managed execution remains builtin-only with no ambient resource activation. It
keeps saved policy, resource binding, leases and checkpoint-based recovery; bare
legacy JSONL is not a managed session. These restrictions do **not** apply to the
standard SDK profile. See [managed resources](../pi-subagents/docs/workflow-resources.md).

## Cancellation and lifecycle

- `/wf-cancel` cancels the sole active run, or lists IDs when there are several.
- `/wf-cancel <id>` selects a run; `/wf-cancel all` cancels all current runs.
- Cold command loading and pending executor acquisition are cancellable.
- Tree browsing and cancelled navigation attempts do not terminate detached runs.
  Standard runs can drain across launcher new/resume/fork operations, and the next
  root retains their cancellation controls. Managed runs retire on confirmed
  replacement. Quit/reload closes all owned executions.

The runner closes ordinary journal writes as soon as cancellation is observed, so
late script or lifecycle completion cannot append success/routing after termination.
Async script/prompt authors can use the additive `ScriptContext.signal` for
cooperative I/O cancellation. JavaScript cannot forcibly terminate arbitrary
uncooperative author code; the runner stops awaiting it and fences its continuation.

Executor retirement is awaited before reporting success. If retirement fails,
a durable `run-terminal/cleanup-failed` record overrides stage-derived success.
Automatic resume refuses such runs instead of replaying successful side effects.
Inspect the failure and remaining resources before deciding the next action.

## Storage and migration

The original layout remains:

- project definitions/packs: `.rpiv/workflows/config.ts` and `packs/*.ts`;
- user definitions/packs: `$XDG_CONFIG_HOME/rpiv-workflow/`, default
  `~/.config/rpiv-workflow/`;
- journals: `.rpiv/workflows/runs/`, schema v3 with optional execution identity and
  additive cleanup-failure records.

Standard stages use native Pi JSONL and can reopen existing raw stage sessions.
Managed children stay under each run's `sessions/managed`; orphan pruning is never
made recursive into their leases and sidecars.

During config/pack evaluation, jiti aliases both `@maplezzk/pi-workflow` and legacy
`@juicesharp/rpiv-workflow` public subpaths to this engine. This is not a second
installation of the upstream runtime. Definitions execute with host privileges;
review them before loading untrusted repositories. Do not co-load another workflow
engine in the same process.

## Entrypoints and checks

The package root is the programmatic engine API; `/registration`, `/startup`,
`/runner` and `/internal` retain their existing roles. `./extension.ts` is the Pi
frontend. Programmatic embedders can continue to provide their own host/provider.

```sh
npm run typecheck -w @maplezzk/pi-workflow
npm test -w @maplezzk/pi-workflow
npm run check
```

Node.js 22+, Pi development runtime 0.87.1. Deterministic checks use temporary
configuration and scripted models, not credentials or live services. Native
provider and visible terminal behavior additionally require smoke validation.

[MIT](./LICENSE). Provenance and local changes are recorded in [UPSTREAM.md](./UPSTREAM.md).
