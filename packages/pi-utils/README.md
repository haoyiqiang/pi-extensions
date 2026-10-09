# pi-utils

Shared foundation for Pi extensions:

- portable JSON configuration I/O (`src/config.ts`);
- deterministic test fixtures (`createExtensionRegistrationHarness`, temp-directory isolation, and the `pi-utils/rpiv` Pi/UI/session helpers).

The package replaces the former `pi-extensions-config`, `pi-extensions-i18n`, and `@maplezzk/pi-test-utils` packages.

## Install

This package is an npm library, not a Pi extension. Feature packages depend on it directly. Do not add it to a Pi extension manifest, and do not install it with `pi install`.

```bash
npm install pi-utils
```

## Configuration I/O

`src/config.ts` owns configuration mechanics only. Feature schemas, defaults, environment precedence, migrations, and settings UI remain with each consuming extension.

- Resolves `PI_CODING_AGENT_DIR`, including `~` and `~/...` forms.
- Builds conventional `<agent-dir>/extensions/<package>/config.json` paths.
- Distinguishes missing JSON files from malformed or non-object configuration.
- Writes formatted JSON atomically with best-effort `0600` permissions.
- Applies preserving read-modify-write updates without dropping sibling fields.
- Provides a boolean save wrapper for user-facing commands that must not report a failed write as successful.

```ts
import {
  extensionConfigPath,
  readJsonObject,
  updateJsonObjectAtomic,
} from "pi-utils";

const path = extensionConfigPath("pi-example");
const current = readJsonObject(path) ?? {};

updateJsonObjectAtomic(path, (config) => {
  config.enabled = true;
});
```

## Text

User-facing text lives in the owning feature package as English. `pi-utils` does not select locales, render notices, or load as a Pi extension. Feature packages call `ctx.ui.notify` directly.

## Test fixtures

Deterministic helpers for this monorepo's tests live in the same package:

- `withTempDir` and `withTempAgentDir` isolate temporary directories and `PI_CODING_AGENT_DIR`;
- `createExtensionRegistrationHarness` records ownership of commands, tools, shortcuts, flags, entry renderers, message renderers, and event handlers, and throws immediately on collisions;
- `pi-utils/rpiv` provides adapted Pi/UI/session/manifest fixtures with upstream MIT attribution in `RPIV-LICENSE`.

These helpers are test-only surfaces; product packages import them from test files only.

## Requirements

- Node.js 22 or newer.

## License

[MIT](../../LICENSE)
