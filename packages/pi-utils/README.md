# pi-utils

Shared foundation for Pi extensions:

- portable JSON configuration I/O (`src/config.ts`);
- a locale/catalog runtime with `zh-CN`, `en-US` and `auto` preferences, plus the shared source-tagged notice outlet;
- deterministic test fixtures (`createExtensionRegistrationHarness`, temp-directory isolation, and the `pi-utils/rpiv` Pi/UI/session helpers).

The package replaces the former `pi-extensions-config`, `pi-extensions-i18n`, and `@maplezzk/pi-test-utils` packages.

## Install

Feature packages depend on `pi-utils` at runtime, so installing a feature package is enough to provide the locale command and the shared notice renderer. Install it directly only when you want the locale command without another feature package:

```bash
pi install npm:pi-utils
```

Reload Pi after installation:

```text
/reload
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

## Localization

- `zh-CN`, `en-US`, and `auto` locale preferences.
- A process-global namespace registry backed by `globalThis[Symbol.for(...)]`, so locale changes propagate across separately resolved package instances.
- Persistent setting at `~/.pi/agent/extensions/pi-utils/config.json`. The retired `~/.pi/agent/extensions/pi-extensions-i18n/config.json` path remains a read-only fallback; the next save writes the new path.
- `--locale` launch override and `PI_EXTENSIONS_LOCALE` environment-variable override.
- `/config:language` interactive command, `/languages` alias, and direct selection such as `/config:language en-US`.
- Namespaced render-time lookup with English fallback, plus a `./loader` subpath for flat per-locale files.
- Compatibility catalog loading and validation requiring both language entries for every existing message key.
- Translator interpolation for user-facing UI, command descriptions, and agent prompts.

### Locale precedence

```text
--locale launch flag
    > PI_EXTENSIONS_LOCALE environment variable
    > persisted config (pi-utils, then the retired pi-extensions-i18n path)
    > default zh-CN
```

Launch overrides are session-owned. Starting a child without `--locale` does not
clear the root override; children inherit the active locale unless explicitly
bound to another owner. Persisted preference remains shared.

The `auto` preference checks `LC_ALL`, `LC_MESSAGES`, and `LANG`; Chinese system locales resolve to `zh-CN`, and other locales resolve to `en-US`. `zh` and `en` are accepted as short aliases.

The extension emits `LOCALE_CHANGED_EVENT` (`pi-utils:i18n:locale:changed:v1`,
`{ locale: "zh-CN" | "en-US" }`) after resolving the launch flag or saving a language
selection. Features may re-register their own translated tool/command definitions
on that event. Refresh at `session_start` and before input/model requests as a
fallback for environment or externally edited preferences; do not reset feature
state or custom guidance.

### Namespaces and catalogs

Register a namespace and resolve strings at render time:

```ts
import { registerStrings, scope } from "pi-utils";

registerStrings("pi-example", {
  "en-US": { saved: "Saved" },
  "zh-CN": { saved: "已保存" },
});

const t = scope("pi-example");
t("saved", "Saved");
```

Repository packages use flat `locales/en-US.json` and `locales/zh-CN.json` files through `registerLocalesFromDir` from `pi-utils/loader`. `createTranslator`, `getLocale`, and `loadCatalog` remain available as compatibility APIs for external key-first bilingual catalogs; those catalogs must contain both locale keys:

```json
{
  "description": {
    "zh-CN": "扩展描述",
    "en-US": "Extension description"
  }
}
```

Invalid catalogs fail during loading, which makes missing translations visible in tests and CI instead of silently leaking a single-language message to users.

### Source-tagged notices

Every user-visible notice goes through `notifyWithSource`, which draws it as a filled background block in the transcript (the same block Pi uses for extension messages) with a short `[tag]` source label. Pi renders `info` notices as dim, unprefixed text, so without the block and tag you cannot tell which extension spoke. Every package uses the same muted label colour (`NOTICE_TAG_COLOR`): the tag text identifies the source, the colour deliberately does not.

```ts
import { NOTICE_TAG_COLOR, notifyWithSource, type NoticeColor, type NoticeSource } from "pi-utils";

const NOTICE_TAG = "distill";
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("failed") });
```

The body colour follows `level` (`warning` yellow, `error` red, `info` the extension message text colour), and `textColor` overrides it for verdict-style lines that carry their own semantic colour. In tui mode the notice is written as a Pi custom entry below the message; rpc/print/json keep using `ctx.ui.notify` with plain `[distill] message` text so no ANSI leaks into other frontends. Details stay collapsed on a single line with an expand arrow (collapsed `▶`, expanded `▼`): click the block in fullscreen mode, or press `Ctrl+O` in regular mode. A notice without details gets no arrow.

The block is registered once by this package's extension entry. A feature package should ship an `i18n-entry.ts` containing `export { default } from "pi-utils"` and list it before its own entry in `pi.extensions`. This uses normal dependency resolution in scoped, hoisted and nested npm layouts; workspace sibling paths are not portable. Entries are deduplicated per runtime event bus, not across independent child sessions. Use `formatNotice({ source, message, mode, theme })` when you only need the rendered string.

Notice delivery is keyed by the stable `ctx.sessionManager` owner, not the last extension API loaded in the process. For a reduced UI view or a child that intentionally relays notices to its launcher:

```ts
import { bindNoticeOwner, getNoticeOwnerBinding } from "pi-utils";

const release = bindNoticeOwner(view, getNoticeOwnerBinding(parentCtx));
// notifyWithSource({ ctx: view, ... }) now uses that explicit parent lease.
release();
```

Bindings are token-safe: root shutdown or replacement invalidates an old relay, which falls back to its own UI rather than appending to a closed/replacement session. Installing the renderer alone never claims notice ownership.

## Test fixtures

Deterministic helpers for this monorepo's tests live in the same package:

- `withTempDir` and `withTempAgentDir` isolate temporary directories and `PI_CODING_AGENT_DIR`;
- `createExtensionRegistrationHarness` records ownership of commands, tools, shortcuts, flags, entry renderers, message renderers, and event handlers, and throws immediately on collisions;
- `pi-utils/rpiv` provides adapted Pi/UI/session/manifest fixtures with upstream MIT attribution in `RPIV-LICENSE`.

These helpers are test-only surfaces; product packages import them from test files only.

## Requirements

- Node.js 22 or newer.
- Pi's extension runtime when using the locale command or the notice renderer.

## License

[MIT](../../LICENSE)
