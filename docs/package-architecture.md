# Package architecture

This repository publishes independently installable Pi extensions and a small set of shared foundations. The root package is a distribution profile for users who intentionally want the complete suite; it is not a runtime orchestrator and does not own feature behavior.

## Layers

### Product and experience packages

- `pi-spark` owns the compact editor/footer, transcript folding, credits, presets, recap, metrics, and session resources.
- `pi-blackhole` owns deterministic compaction, observational memory, and raw-session recall.
- `@maplezzk/pi-interactive-subagents` owns subagent processes, persistent child sessions, terminal surfaces, and the subagent widget.

These packages may depend on foundations but must not depend on one another.

### Capability packages

- `pi-distill` transforms verbose tool results before the next model turn.
- `@maplezzk/pi-web-search` owns web search, URL Context, and bounded fetch tools.
- `pi-models-discovery` owns dynamic provider model discovery.
- `pi-naming` owns session and terminal naming.
- `pi-rewind` owns Git-backed file and conversation restore.
- `pi-context-view` passively inspects context composition.

Capability packages may depend on foundations but must not depend on product packages or another capability package.

### Foundation packages

- `pi-extensions-config` owns portable agent-dir paths, JSON object reads, atomic writes, and preserving updates.
- `pi-extensions-i18n` owns locale state, catalogs, and the shared notice outlet.
- `pi-terminal-mux` exposes the terminal-surface abstraction used by naming and subagents.

Foundations must not depend on product or capability packages. A new foundation belongs here only after at least three real consumers need the same stable mechanism.

### Internal packages

- `@maplezzk/pi-test-utils` provides deterministic temp-directory and extension-registration fixtures.
- `@maplezzk/pi-subagents` is a private upstream migration baseline. It retains embedded subagent source/tests and an injected terminal lifecycle primitive using the public i18n/mux foundations, but is not activated; `@maplezzk/pi-interactive-subagents` remains the active product. Backend integration, shared config/localization, and the eventual product-layer promotion are separate changes.

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
pi-naming ──────────────────────→ pi-terminal-mux
@maplezzk/pi-interactive-subagents → pi-terminal-mux
@maplezzk/pi-subagents (private) ─→ pi-extensions-i18n / pi-terminal-mux
```

Runtime code imports sibling packages by their public npm name. It must not import another package through `../other-package/src/...` or any other private path.

## UI ownership

- `pi-spark` is the only package that replaces the editor or footer and the only owner of core transcript folding.
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
