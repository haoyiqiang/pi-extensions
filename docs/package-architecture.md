# Package architecture

This repository publishes independently installable Pi extensions and a small set of shared foundations. The root package is a distribution profile for users who intentionally want the complete suite; it is not a runtime orchestrator and does not own feature behavior.

## Layers

### Product and experience packages

- `pi-spark` owns the compact editor/footer, transcript folding, credits, presets, recap, metrics, session resources, and automatic/manual session and terminal naming.
- `pi-blackhole` owns deterministic compaction, observational memory, and raw-session recall.
- `@maplezzk/pi-interactive-subagents` owns subagent processes, persistent child sessions, terminal surfaces, and the subagent widget.

These packages may depend on foundations but must not depend on one another.

### Capability packages

- `pi-distill` transforms verbose tool results before the next model turn.
- `@maplezzk/pi-web-search` owns web search, URL Context, and bounded fetch tools.
- `pi-models-discovery` owns dynamic provider model discovery.
- `pi-rewind` owns Git-backed file and conversation restore.
- `pi-context-view` passively inspects context composition.

Capability packages may depend on foundations but must not depend on product packages or another capability package.

### Foundation packages

- `pi-extensions-config` owns portable agent-dir paths, JSON object reads, atomic writes, and preserving updates.
- `pi-extensions-i18n` owns locale state, catalogs, and the shared notice outlet.
- `pi-terminal-mux` exposes the terminal-surface abstraction used by Spark naming and subagents. It executes terminal operations without title-generation or extension-registration policy.

Foundations must not depend on product or capability packages. A new foundation belongs here only after at least three real consumers need the same stable mechanism.

### Internal packages

- `@maplezzk/pi-test-utils` provides deterministic temp-directory and extension-registration fixtures.
- `@maplezzk/pi-subagents` is the private unified subagent implementation. Its explicit product entry keeps Agent/RPC/Fleet ownership in one manager runtime and selects standard embedded or terminal execution from canonical `subagents.json`. Interactive capability belongs to the backend; the old interactive tool names, commands and `__pi_subagents` bridge are not carried forward. The upstream `Symbol.for("pi-subagents:manager")` view of the same root manager remains for existing consumers; workflow integration uses the versioned event bus, not that registry. Managed isolation remains a separate optional profile. The root profile still selects `@maplezzk/pi-interactive-subagents` pending distribution promotion; never co-load both products.

- `@maplezzk/pi-workflow` is the private independent workflow engine: the imported `rpiv-workflow` owns DSL/routing, run journals, retries/recovery, `/wf` and its UI. The standard host keeps SDK stage sessions and ordinary approved resources, and injects scoped Agent tools using the same subagent backend factory. The unified subagent entry offers this executor; the standalone `pi-subagents/workflow-executor` entry is an alternative without root Agent UI. Neither enables the retained upstream `SubagentWorkflow` engine.

The two private products collaborate through `pi-workflow:executor:discover:v1`, not runtime imports of one another. Subagents owns the ordinary backend default and definition policy; workflow owns its execution profile, concurrency, registration and run lifetime. Standard stages remain SDK sessions and pin the delegation backend; explicit managed execution may place the stage itself in a managed backend. Backend/resource identity travels in the journal. No new shared request library or process-global executor registry is introduced. Root replacement hands off cancellation through the existing owned provider, while quit/reload retires the whole run.

Internal packages are `private: true`. They are part of workspace type checks and tests but never enter release-please, npm tarball checks, or the root Pi profile.

### Distribution profile

The private root `pi-extensions` package explicitly lists every extension and theme loaded by `pi install git:github.com/maplezzk/pi-extensions`. Adding a workspace package does not automatically add it to the full profile. Pure libraries and future private test packages must never appear in the root Pi manifest.

## Dependency direction

The current allowed workspace edges are intentionally narrow:

```text
selected feature packages ─────→ pi-extensions-config
feature packages ───────────────→ pi-extensions-i18n
pi-extensions-i18n ─────────────→ pi-extensions-config
pi-terminal-mux ────────────────→ pi-extensions-i18n
pi-spark ───────────────────────→ pi-terminal-mux
@maplezzk/pi-interactive-subagents → pi-terminal-mux
@maplezzk/pi-subagents (private) ─→ pi-extensions-config / pi-extensions-i18n / pi-terminal-mux
@maplezzk/pi-workflow (private) ──→ pi-extensions-config / pi-extensions-i18n
```

Runtime code imports sibling packages by their public npm name. It must not import another package through `../other-package/src/...` or any other private path.

## UI ownership

- `pi-spark` is the only package that replaces the editor or footer and the only owner of core transcript folding. It also owns `/rename`, automatic naming and `/config:naming`; do not restore the retired standalone `pi-naming` entry.
- `@maplezzk/pi-interactive-subagents` owns the subagent widget and subagent result entries.
- `pi-extensions-i18n` owns the shared notice entry renderer.
- `pi-distill` owns its audit entry renderer.
- Domain packages may create temporary modals, overlays, or namespaced status entries but must not claim another package's persistent surface.

Shared UI hosts are deliberately avoided. Domain UI stays with the package that produces and understands the state.

## Package types

An extension package declares `./index.ts` in `pi.extensions`. A library package has no Pi extension entry and must have no import-time runtime side effects. Every public package owns its README files, tests, package metadata, and compatibility notes.

Independent semantic versions are intentional. The repository does not use lockstep versions because packages remain independently installable and releasable.

## Verification

Repository gates enforce:

- declared package layers, including private internal workspaces, and allowed runtime dependency edges;
- no cross-package private source imports;
- an explicit, resource-complete root distribution profile;
- package metadata and locale consistency;
- deterministic tests and exact Pi development dependency pins;
- npm tarball contents, including exclusion of test sources;
- release coverage and dependency-sensitive publication order.
