# Package architecture

The root package is an explicit Git/local distribution profile, not a runtime
orchestrator. Runtime ownership, root activation, and npm publication are separate
concerns: an npm-private product can be active in this checked-out suite without
being eligible for release automation.

## Layers

### Product and experience packages

- `pi-spark` owns the compact editor/footer, transcript folding, credits, presets,
  recap, metrics, resources, and session/terminal naming.
- `pi-blackhole` owns deterministic compaction, observational memory, and recall.
- `@maplezzk/pi-subagents` owns the unified Agent/RPC/Fleet runtime, agent policy,
  scheduling and lifecycle. `subagents.json` selects embedded or terminal Pi
  execution. It is active in the root profile but remains npm-private.
- `@maplezzk/pi-workflow` owns the independent workflow DSL, orchestration,
  journals, recovery, `/wf` and `/wf-cancel`. It is active in the root profile but
  remains npm-private.

Products may depend on foundations, not on one another's implementations.
Subagents and workflow communicate through `pi-workflow:executor:discover:v1`.
Standard stages use native SDK sessions with normal approved resources; their
scoped Agent delegates use the shared subagent backend. Explicit managed mode
retains its isolated policy/checkpoint guarantees. A standalone workflow-executor
entry is available instead of the full subagent product, never alongside it.

The old interactive tools, commands and `__pi_subagents` bridge are not carried
forward. The upstream `Symbol.for("pi-subagents:manager")` view remains for existing
consumers of the same root manager; workflow integration does not use that view.
The retained upstream `SubagentWorkflow` is not a second active engine. Root
session replacement hands off admitted workflow cancellation; quit/reload retires
all owned work.

### Capability packages

- `pi-distill`: tool-output distillation.
- `@maplezzk/pi-web-search`: search, URL Context and bounded fetch.
- `pi-models-discovery`: dynamic model discovery.
- `pi-rewind`: file/session checkpoints.
- `pi-context-view`: passive context inspection.

Capabilities may depend on foundations, not products or other capabilities.

### Foundation packages

- `pi-extensions-config`: portable agent directories and JSON configuration I/O.
- `pi-extensions-i18n`: locale/catalog state and source-tagged notices.
- `pi-terminal-mux`: terminal detection and surface operations, without naming or
  extension-registration policy.

Foundations must not depend on products or capabilities. Introduce another
foundation only when at least three real consumers need the same stable mechanism.

### Internal and retired workspaces

- `@maplezzk/pi-test-utils` supplies deterministic test fixtures.
- `@maplezzk/pi-interactive-subagents` is a retired private source snapshot. It
  declares no installable Pi resources, is absent from the root profile and
  release metadata, and must not be co-loaded with unified subagents. Historical
  source and regression tests remain available without maintaining a second
  active product or rewriting old user data.

Private internal/retired workspaces do not enter runtime profiles or releases.
The explicit private-product exception for **only** subagents and workflow permits
their root activation and deployment-artifact checks, not npm publication. All
private packages remain excluded from release-please and publish jobs.

## Distribution profile

The root `pi.extensions` list explicitly includes each active extension and
`pi.themes` includes Spark themes. No source loading glob is permitted. A package
can declare its own `./index.ts` or another explicit extension path, such as
workflow's `./extension.ts`; its library API `index.ts` is not implicitly an
extension. Pure libraries and retired entries must not enter the profile.

The root suite requires Pi 0.87.1 or a tested compatible runtime. Adding a new
workspace never silently activates it. Changes to the allowlist require
composition tests, including tool/command/renderer ownership and real SDK loading.
See the [migration guide](../packages/pi-subagents/docs/migration.md) for the
breaking old-tool transition, configuration and installation choices.

## Dependency direction

```text
selected features ──────────────→ pi-extensions-config
features ───────────────────────→ pi-extensions-i18n
pi-extensions-i18n ──────────────→ pi-extensions-config
pi-terminal-mux ────────────────→ pi-extensions-i18n
pi-spark ───────────────────────→ pi-terminal-mux
@maplezzk/pi-subagents ─────────→ config / i18n / terminal-mux
@maplezzk/pi-workflow ──────────→ config / i18n
retired interactive snapshot ──→ i18n / terminal-mux (source/test only)
```

Runtime imports use public npm package names, not sibling private source paths.
No new shared model-request wrapper or global workflow executor registry is added.

## UI ownership

- Spark alone replaces the root editor/footer and owns core transcript folding,
  `/rename` and naming configuration.
- Unified subagents owns its agent widget/Fleet and result presentation.
- Workflow owns run notices and commands. Child dialogs are serialized and scoped;
  children cannot replace root editor/footer/widgets. The RPIV lane dock is not
  bundled.
- I18n owns the shared notice entry renderer; Distill owns its audit entry renderer.

Domain packages may create temporary modals/overlays or namespaced status entries,
not claim another package's persistent surfaces. There is no shared product UI host.

## Publication and verification

Public npm packages are independently versioned and released. The unified products'
remaining publication/localization preparation is not permission to restore the
old default runtime. No user-global configuration is modified or npm release
performed as part of changing the checked-out profile.

Repository gates verify dependency boundaries, exact Pi development pins, explicit
resource manifests, locale consistency, deterministic tests, test-free tarballs,
and dependency-sensitive release coverage. Root-active private products receive
artifact checks while remaining non-publishable; internal test/retired workspaces
must not leak into those deployment artifacts.
