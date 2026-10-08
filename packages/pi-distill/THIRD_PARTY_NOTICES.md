# Third-party notices

## NVIDIA SoL-Pi Evidence-Preserving Reducer

- Source: https://github.com/NVlabs/SoL-Pi
- Imported revision: `e1a586af0ad8956f42ae5b26bba20e48fbf30e00`
- Upstream files: `src/sol-pi/extensions/evidence-preserving-reducer/{archive,candidate,receipt}.ts` and related concepts/tests.
- Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
- License: MIT; the notice and license text are retained in [LICENSE](./LICENSE).

The content-addressed source archival, fused-command log selection, and exact-quote evidence validation are adaptations of upstream. Distill owns the integration: shared result routing, model-registry requests, bounded source loading and quotas, native readback, bilingual catalogs and existing summary behavior. No standalone upstream reducer entrypoint, authentication transport, or compaction mechanism is loaded. Verified quotes establish source membership, not losslessness or complete diagnostic coverage.
