# Third-party notices

## NVIDIA SoL-Pi Action Fusion

- Source: https://github.com/NVlabs/SoL-Pi
- Imported revision: `e1a586af0ad8956f42ae5b26bba20e48fbf30e00`
- Upstream files: `src/sol-pi/extensions/action-fusion/{index,file-queue,then-run}.ts` and related Action Fusion regression tests.
- Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
- License: MIT; the notice and license text are retained in [LICENSE](./LICENSE).

This package adapts Action Fusion to the pi-extensions workspace. The queue, sequential mutation/command execution, and interference guard derive from upstream. Repository-specific configuration, localization, native renderer composition, streaming updates, and Pi 0.87.1 integration are local adaptations. Other SoL-Pi mechanisms are not imported or activated.
