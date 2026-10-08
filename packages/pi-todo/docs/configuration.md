# Configuration

The canonical file is `<agent-dir>/extensions/pi-todo/config.json`, where `<agent-dir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`.

If the canonical file is absent, the package may read the old `$XDG_CONFIG_HOME/rpiv-todo/config.json` or `~/.config/rpiv-todo/config.json`. An invalid canonical file does not fall through to legacy configuration. The package never writes configuration.

## Fields

- `maxWidgetLines`: number, minimum 3, default 12. Read again while rendering.
- `collapseKey`: Pi key id such as `alt+t` or `ctrl+shift+t`; default `ctrl+shift+t`. `off` disables registration. Rebind with `/reload`.
- `guidance.promptSnippet`: non-empty string replacing the built-in tool prompt snippet.
- `guidance.promptGuidelines`: non-empty array of non-empty strings replacing all built-in guidelines.

Unknown fields are preserved by virtue of this package being read-only. Invalid JSON or a non-object configuration produces a localized warning and uses defaults.
