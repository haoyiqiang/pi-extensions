# pi-terminal-mux

Terminal surface API for Pi extensions, supporting **tmux**, **Orca**, and **headless** background processes.

[中文文档](./README.zh-CN.md)

## Install

```bash
npm install pi-terminal-mux
```

## Create and start a command

```ts
import { createSurface, createSurfaceSplit, readScreen, closeSurface } from "pi-terminal-mux";

const surface = createSurface("my-agent", {
  command: "pi --session /tmp/child.jsonl",
});

const sibling = createSurfaceSplit("review", "right", surface, {
  command: "pi --session /tmp/review.jsonl",
});

const tail = readScreen(surface, 50);
closeSurface(sibling);
closeSurface(surface);
```

`command` is an optional, non-empty **shell command string**, including its arguments. Quote dynamic values with `shellEscape()` for POSIX shells. There is no separate `sendCommand()` call or library-side shell-ready sleep on this path:

- **tmux:** supplies the command to `tmux split-window` while creating the pane.
- **Orca:** supplies `--command` to `terminal create` or `terminal split`. Orca itself starts a shell and submits the command; this is not a direct argv process spawn.
- **Headless:** starts the command with `bash -c`, writing stdout/stderr to a log file.

Returning a handle confirms creation/submission, not application readiness or successful completion. Use your application's ready signal, logs, or exit protocol for that. Creation errors propagate to the caller. Orca input/read errors also propagate instead of appearing successful.

Existing calls without options keep their previous behavior:

```ts
import { createSurface, sendLongCommand } from "pi-terminal-mux";

const surface = createSurface("my-agent");
const scriptPath = sendLongCommand(surface, "pi --session /tmp/child.jsonl", {
  scriptPreamble: "export MY_FLAG=1",
});
```

`sendLongCommand` writes a script first and then submits `bash <script>` to the terminal. It remains available for existing callers and long commands. Do not also submit the startup command after passing it to `createSurface`, or it will run twice.

## Detection

| Backend | Requirements |
|---------|--------------|
| tmux | `TMUX` environment variable and the `tmux` executable |
| Orca | `TERM_PROGRAM=Orca`, the `orca` executable, and a reachable runtime |
| Headless | Neither terminal backend is available |

Automatic detection prefers tmux, then Orca. Force a backend with `PI_TERMINAL_MUX=tmux|orca`; `PI_SUBAGENT_MUX` remains a compatibility alias. An unavailable forced backend does not select another terminal backend. Unknown or removed backend preferences throw an explicit error.

## API

| Function | Behavior |
|----------|----------|
| `createSurface(name, options?)` | tmux right-split; Orca breadth-first splits from the caller, or a new tab without a caller handle; headless fallback. `options.command` starts work during creation |
| `createSurfaceSplit(name, direction, fromSurface?, options?)` | Explicit split; `direction` is left/right/up/down, `options.command` is optional. Requires tmux or Orca; headless has no pane layout |
| `sendCommand(surface, command)` | Send input followed by Enter to an existing terminal |
| `sendLongCommand(surface, command, options?)` | Write a script, then execute it. Supports `scriptPath`, `scriptPreamble`, and `interpreter: "bash" | "powershell"` |
| `sendEscape(surface)` | Send Escape; headless uses SIGINT |
| `readScreen(surface, lines?)` / `readScreenAsync` | Read terminal output or headless logs |
| `closeSurface(surface)` | Close a pane or headless process |
| `renameSurface(surface, name)` | Rename the backend's corresponding window/tab |
| `getLastSplitSource()` / `clearLastSplitSource()` | Track the most recent split source |
| `pollForExit(surface, signal, options)` | Wait for an `.exit` sidecar, sentinel, or headless process exit |

Types `CreateSurfaceOptions` and `CreateSurfaceSplitOptions` both expose `command?: string`. The existing first three split arguments are unchanged.

Detection helpers include `getMuxBackend`, `isMuxAvailable`, `isHeadlessMode`, `muxSetupHint`, `getAgentPaneId`, and `backendAgentPaneEnvVar`. Shell helpers include `shellEscape`, `isFishShell`, and `exitStatusVar`.

The shared API is also exported through `pi-terminal-mux/mux`; Orca-native helpers are exported through `pi-terminal-mux/orca`.

## Naming ownership

`createSurfaceRenameContext(surface)` produces the `PI_TERMINAL_RENAME_CONTEXT` protocol for a child launcher. Replace inherited context on every launch and resume.

A child pane does not prove exclusive ownership of its tmux window or Orca tab. Child contexts therefore grant neither shared window/tab renaming nor workspace renaming. Invalid contexts never fall back to parent permissions.

For ordinary sessions, `resolveTerminalRenameTargets({ tab, workspace })` resolves explicit identities, and `renameTerminalTarget(reference, title)` operates on those captured targets, never on UI focus:

- tmux: window for `tab`, session for `workspace`.
- Orca: terminal tab for `tab`; `workspace` is unsupported.
- Headless: naming is unsupported.

Legacy `renameCurrentTab` / `renameWorkspace` return discriminated success, unsupported, disabled, or failed results. tmux's legacy operations require `PI_SUBAGENT_RENAME_TMUX_WINDOW=1` / `PI_SUBAGENT_RENAME_TMUX_SESSION=1`; explicit-ID resolution ignores those switches.

## Migration

Only tmux and Orca remain in `MuxBackend`. Other backend implementations, native exports/subpaths, WezTerm's `activate` option, and Herdr's read-source options have been removed. Update old backend preferences and imports. This is a breaking reduction of the supported backend/API surface; tmux/Orca calls without startup options remain compatible.

No local executable paths are hardcoded. Orca's caller handle is captured at module load so later UI focus changes cannot redirect splits. Headless keeps the existing Bash default; `sendLongCommand({ interpreter: "powershell" })` explicitly selects PowerShell where available.

## License

MIT
