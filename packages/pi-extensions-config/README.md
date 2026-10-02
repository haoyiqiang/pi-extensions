# pi-extensions-config

Shared, side-effect-free JSON configuration I/O for Pi extensions.

## Capabilities

- Resolves `PI_CODING_AGENT_DIR`, including `~` and `~/...` forms.
- Builds conventional `<agent-dir>/extensions/<package>/config.json` paths.
- Distinguishes missing JSON files from malformed or non-object configuration.
- Writes formatted JSON atomically with best-effort `0600` permissions.
- Applies preserving read-modify-write updates without dropping sibling fields.
- Provides a boolean save wrapper for user-facing commands that must not report a failed write as successful.

The package owns configuration mechanics only. Feature schemas, defaults, environment precedence, migrations, and settings UI remain with each consuming extension.

## Usage

```ts
import {
  extensionConfigPath,
  readJsonObject,
  updateJsonObjectAtomic,
} from "pi-extensions-config";

const path = extensionConfigPath("pi-example");
const current = readJsonObject(path) ?? {};

updateJsonObjectAtomic(path, (config) => {
  config.enabled = true;
});
```

This is a library package and registers no Pi extension, command, tool, or UI.

The package architecture is informed by [`@juicesharp/rpiv-config`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-config) (MIT). This implementation targets Pi's agent directory, preserves missing-vs-invalid diagnostics, and uses atomic replacement writes.

## License

[MIT](../../LICENSE)
