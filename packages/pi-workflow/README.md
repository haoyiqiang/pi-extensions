# @maplezzk/pi-workflow — private workflow integration

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

An **independent workflow engine**, imported from
[`@juicesharp/rpiv-workflow` 2.12.0](./UPSTREAM.md). It owns the typed stage/loop DSL,
predicate routing, output collection/validation, retries, JSONL audit journals,
recovery and `/wf`. Subagent execution belongs to `pi-subagents`, not this package.

**Private and opt-in:** neither this package nor the new subagent executor enters
the root Pi profile or release configuration. The current interactive-subagents
product is unchanged. This is not a drop-in replacement for the complete RPIV
bundle or its default workflows, skills, extension tools and lane UI.

## Architecture

```text
pi-workflow: DSL / runner / journal / /wf / execution configuration
    │  pi-workflow:executor:discover:v1 (Pi event bus)
    ▼
pi-subagents/workflow-executor: managed lifecycle and saved policy
    ├─ embedded: isolated in-process Pi SDK session
    └─ terminal: isolated Pi CLI child → pi-terminal-mux
```

There is no cross-product runtime dependency or private source import. Executor
discovery is synchronous and versioned; missing or duplicate compatible executors
fail rather than falling back to the launcher session. The retained upstream
`SubagentWorkflow` engine and Agent UI are not loaded by the executor-only entry.

Programmatic embedders can still supply their own host. The public startup registrar
owns a token-guarded unregister operation; the actual runner supplies its canonical
cancellation factory per execution and awaits retirement. Saved execution identity
travels in the workflow header, separate from child-session policy and credentials.

## Explicit development activation

From this repository after `npm install`, load **these files explicitly** in a
trusted development session:

```sh
pi -e ./packages/pi-extensions-i18n/index.ts \
   -e ./packages/pi-subagents/workflow-executor.ts \
   -e ./packages/pi-workflow/extension.ts
```

Do not load `pi-subagents/index.ts` just to run workflows: that is the retained
legacy product factory, with separate tools/UI. The notice outlet above is required
for source-tagged notices. No settings or root-profile files are rewritten.

This package ships **no default workflows**. A minimal project definition at
`.rpiv/workflows/config.ts` is:

```ts
import { acts, defineWorkflow } from "@maplezzk/pi-workflow";

export default defineWorkflow({
  name: "inspect",
  start: "review",
  stages: {
    review: acts.prompt({ prompt: "Inspect the current changes and summarize risks." }),
    check: acts.prompt({
      prompt: "Review those findings and identify missing verification.",
      sessionPolicy: "continue",
    }),
  },
  edges: { review: "check", check: "stop" },
});
```

Run `/wf inspect review the current changes`. Continue-policy stages fork the
predecessor's saved history; they do not run in the launcher session. The retained
command grammar also supports `/wf @<run-id-or-name>` recovery. See
[workflow basics](./docs/workflow-basics.md) and the
[authoring reference](./docs/workflow-authoring.md) for the inherited DSL and grammar;
references to the upstream host/UI are not promises of this managed profile.

### Cancel a run

`/wf-cancel` cancels the only active run, or lists run IDs when more than one is
active. Use `/wf-cancel <run-id>` to select one or `/wf-cancel all` for all current
runs. Pending executor acquisition is cancellable too. The command waits for known
retirement and reports cleanup failure rather than claiming a successful stop.
It does not change `/wf` parsing or claim a lane/widget surface. Switching or closing
the owning Pi session also cancels its managed executions.

## Execution configuration

See [`config.example.json`](./config.example.json). Settings are loaded per run:

- Global: `<agentDir>/extensions/pi-workflow/config.json`.
- Project: `<cwd>/.pi/pi-workflow.json`.
- Agent directory uses `pi-extensions-config` and honors `PI_CODING_AGENT_DIR`.

```json
{
  "execution": {
    "executor": "pi-subagents",
    "backend": "embedded",
    "agentType": "general-purpose",
    "maxConcurrency": 4
  },
  "skills": [],
  "requiredTools": []
}
```

Project execution fields merge over global fields; project `skills` and
`requiredTools` replace their respective arrays. Unknown keys, malformed files,
invalid types/backends and invalid positive integer limits fail closed. Optional
`execution.maxTurns` sets the child turn budget. `backend: "terminal"` selects a
separate autonomous CLI child, not a persistent human-driven terminal conversation.
Native Windows terminal execution remains unsupported; child-visible provider/model
configuration and credentials must match the requested model.

The backend recorded in a run stays sticky on resume even if the configuration's
new-run default changes. Resume does not convert existing sessions across backends.
Existing child model/thinking/tool/prompt/turn policies remain saved-policy governed.

### Explicit skill approval

An approval has `name`, `filePath`, `baseDir`, and `format` (`pi` or
`positional-v1`), with optional `requiredTools` and `expectedSha256`. Relative
file/base paths resolve against the **configuration file's directory** that defines
the approval, not the process CWD. Only explicitly approved instructions are read;
there is no ambient skill, prompt-template or extension discovery.

Instruction snapshots, canonical resource metadata and resolver identity are bound
to managed session policy. Changed approvals/instructions/requirements reject on
resume before a model call or writer acquisition. Supporting scripts and assets
remain **live**; this is not a hermetic resource bundle or an OS sandbox.
`requiredTools` means minimum requirements, not permission grants. The managed
profile currently admits builtin tools only, with no nested Agent, questionnaire,
advisor or web-tool activation. Full resource semantics and bounds are documented
in [workflow resources](../pi-subagents/docs/workflow-resources.md).

## Storage and upstream compatibility

No automatic storage migration is performed:

- Project definitions/packs: `.rpiv/workflows/config.ts` and `packs/*.ts`.
- User definitions/packs: `$XDG_CONFIG_HOME/rpiv-workflow/`, defaulting to
  `~/.config/rpiv-workflow/`.
- Run journals: `.rpiv/workflows/runs/`, retaining schema version 3 with optional
  execution identity.
- Managed children live beneath each run's `sessions/managed` directory with exact
  file references; raw top-level orphan pruning is never made recursive.

The jiti configuration loader aliases both `@maplezzk/pi-workflow` and the legacy
`@juicesharp/rpiv-workflow` public subpaths to this engine **only during config/pack
evaluation**. It is not an installation of the old product. Definitions are executable
TypeScript with host privileges: review them before loading an untrusted repository.
Legacy global registries are retained for import compatibility; do not co-load a
separate upstream workflow implementation in the same process.

Clean managed sessions can reattach/fork. Bare legacy JSONL, crashed/quarantined
writers, incompatible saved model policies, RPIV shell/runtime substitutions and
arbitrary extension tools are not silently adopted or emulated.

## Entrypoints and validation

| Entry | Purpose |
| --- | --- |
| Package root | Engine API; no default extension factory |
| `/registration` | DSL, loader, validation and host contracts |
| `/startup` | Lightweight lifecycle/execution registration |
| `/runner` | Run and resume API |
| `/internal` | Private test/reset helpers |
| `./extension.ts` | Explicit Pi `/wf` frontend |

```sh
npm run typecheck --workspace @maplezzk/pi-workflow
npm test --workspace @maplezzk/pi-workflow
npm run check
```

Node.js 22+, Pi development version 0.87.1. Tests isolate HOME/agent paths and use
scripted hosts/models; real SDK/CLI parity tests run in the subagent workspace.
They require no API credentials, live model, mux daemon or upstream checkout.
Real provider and visible multiplexer behavior still require manual smoke tests.
Inherited internal engine diagnostics are being migrated separately; this private
status is not a claim of complete product localization or publish readiness.

## License

[MIT](./LICENSE). Exact revision, attribution, preserved upstream tests/docs and
local deltas are recorded in [UPSTREAM.md](./UPSTREAM.md).
