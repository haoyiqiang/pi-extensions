# Widget and `/todos`

The TUI widget is registered under `rpiv-todos` with `placement: "aboveEditor"`. It is created only for the factory-owned foreground TUI session. Headless, RPC, print, JSON, and nested child runtimes do not rebind or clear another runtime's widget.

The widget is hidden when no visible tasks remain. It displays a heading, task rows, and an overflow summary. Completed tasks displayed during a turn are hidden at the start of the next turn. Pi's tool-output expansion state temporarily shows all rows.

The collapse shortcut defaults to `ctrl+shift+t`. The widget renders all text from the active `en-US` or `zh-CN` catalog at render time.

`/todos` uses the calling session id, groups visible tasks by status, and sends output through the shared tagged notice renderer. It does not open a custom screen or take over the editor/footer.
