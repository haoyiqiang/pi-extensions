# Upstream provenance

- Project: [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono)
- Source package: `packages/rpiv-workflow`
- Original npm name/version: `@juicesharp/rpiv-workflow` **2.12.0**
- Exact source revision: `68d9a0014b70006d7b04b57933752338a2716db7`
- Revision link: https://github.com/juicesharp/rpiv-mono/tree/68d9a0014b70006d7b04b57933752338a2716db7/packages/rpiv-workflow
- License: MIT; the upstream [LICENSE](./LICENSE) is preserved byte-for-byte.
- Destination: private `@maplezzk/pi-workflow` 0.1.0; no release or product activation.

## Imported material

The source package contains **198 files**: **124 production TypeScript modules**,
**65 colocated TypeScript test files**, three Markdown reference documents,
README, CHANGELOG, package metadata, LICENSE, and two cover images.

All **189 TypeScript files** are imported under `src/`, retaining their relative
module layout. The three reference documents are preserved verbatim under
`docs/`; the original README, CHANGELOG, and package.json are archived verbatim
under `docs/upstream/`. Cover PNG/SVG artwork is intentionally omitted.
The old package metadata is a historical document, not an active manifest.
No workflows, skills, host executor, or other production code from `rpiv-pi`
is included.

Only the workflow-related reset calls and temporary-home isolation pattern were
extracted from upstream `test/setup.ts`. Tests do not load any other RPIV package.
Four upstream `packages/test-utils` modules (`pi.ts`, `concurrent-host.ts`,
`theme.ts`, `manifest.ts`) are copied under `test/upstream/`, with only the exports
used by this suite exposed by its local index. They are MIT-licensed code from the
same revision and repository, with original attribution retained here. These are
private regression fixtures, not a replacement shared test-utils package. A future
reusable extraction belongs in `@maplezzk/pi-test-utils` with separate ownership.

## Mechanical adaptations

- New private package metadata, root public-API barrel, and explicit thin extension
  re-export. No `pi` resource manifest or publishing configuration.
- Development versions align with this workspace: Pi 0.87.1, TypeScript 5.9.3,
  Vitest 5.0.1; Standard Schema spec is pinned to 1.1.0 (matching upstream's lock).
- `rpiv-config` is removed. `src/config.ts` delegates Pi-native directory resolution
  to `pi-extensions-config.resolveAgentDir()` and locally preserves the original
  XDG-aware user workflow path algorithm. Project overlays and run-state paths
  remain `.rpiv/workflows/`; no storage migration occurs.
- jiti aliases the new and original package names, with their public subpaths, only
  while evaluating config/pack modules. No private checkout or upstream package
  installation is required. Process-global registry symbol names remain unchanged.
- Self-import assertions now use `@maplezzk/pi-workflow`. Imported test-utils
  references point to local fixtures; fixture workflow types point back to `src/`.
- The documentation protocol resolves `../docs` from its new `src/` location.
- Ship-manifest tests resolve the package root above `src/`; the local manifest
  helper excludes the private `test/` directory and Vitest configuration.
- Tests use per-suite temporary HOME/USERPROFILE/PI_CODING_AGENT_DIR, reset only
  workflow registries, and clean their temporary home. No real credentials or
  model access are required. Pi dependencies are inlined/deduped in Vitest.
- Portable import/path/metadata checks supplement, rather than replace, the
  original colocated upstream regression suite.

The mechanical import above deliberately preserved execution semantics first. The
following local integration is separate from that baseline and is not an upstream
release. See the local [README](./README.md), not the archived upstream installation
instructions, for current activation and limitations.

## Standard host and run-lifetime integration

The Pi frontend now defaults to the standard SDK host offered by the unified
`pi-subagents` runtime. Delegated Agent backend selection belongs to subagents;
managed isolation is explicit. The engine still does not import the execution
product or absorb its host implementation.

Run-local cancellation fences prevent abandoned scripts/lifecycle continuations
from mutating journals after termination. Script/prompt contexts gain an optional
signal. Additive cleanup-failure rows prevent recovery from treating failed
retirement as success or repeating completed side effects. The frontend covers
cold command admission and hands off active-run cancellation across root session
replacement, without changing the DSL or `/wf` grammar.

The following list describes the preceding private managed integration, which
remains available as a separate profile.

## Local consumer integration

- The execution registrar gains token-owned unregister semantics; the actual runner
  supplies its canonical cancellation factory per host creation, combines cancellation
  sources and awaits execution retirement instead of fire-and-forget disposal.
- Execution identity is optional credential-free header data, carried into recovery;
  executor/backend/resource mismatches must reject before resumed dispatch. Consumer
  extraction/retry paths preserve canonical cancellation and guard durable writes.
- The explicit Pi frontend discovers a compatible executor through the versioned
  `pi-workflow:executor:discover:v1` event-bus protocol. There is no product dependency
  on `pi-subagents`, no copied RPIV SDK host, and no hidden provider-slot mutation.
- Added portable strict JSON execution/approval configuration through
  `pi-extensions-config`. Existing executable workflow definitions and run storage
  remain on the legacy paths; no automatic data migration is performed.
- Added `/wf-cancel [run-id|all]` without changing `/wf` grammar. Per-run controllers
  cover pending acquisition and active execution, with idempotent cancellation and
  awaited retirement. Root shutdown also tracks invalid acquired-handle cleanup and
  preserves failures that settle during concurrent cleanup.
- Frontend messages and model-facing documentation protocol use bilingual catalogs
  and the shared source-tagged notice outlet. Inherited internal engine diagnostics
  remain part of the ongoing private migration, not a publish-readiness claim.
- Added focused lifecycle, configuration, Pi command/discovery and real managed
  consumer tests alongside the preserved upstream suite. Both workspaces remain
  private and excluded from automatic root activation/release metadata.
