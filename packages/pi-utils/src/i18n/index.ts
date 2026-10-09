import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerLocalesFromDir } from "./loader.ts";
import {
  applyLocaleForOwner,
  createLocaleOverrideOwner,
  getLocale,
  getLocalePreference,
  inheritLocaleForOwner,
  LOCALE_ENV,
  parseLocalePreference,
  releaseLocaleOverrideOwner,
  saveLocalePreference,
  scope,
  type LocalePreference,
  type MessageParams,
} from "./runtime.ts";
import {
  bindNoticeOwner,
  NOTICE_TAG_COLOR,
  installNoticeRenderer,
  notifyWithSource,
  type NoticeColor,
  type NoticeOwnerRelease,
  type NoticeSource,
} from "./notice.ts";

export * from "./catalog.ts";
export * from "./runtime.ts";

const COMMAND_NAMESPACE = "pi-utils";
const NOTICE_TAG = "language";
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };
const FLAG_NAME = "locale";
const EXTENSION_PROBE_EVENT = "pi-utils:i18n:extension:ready:v1";
export const LOCALE_CHANGED_EVENT = "pi-utils:i18n:locale:changed:v1";
interface ExtensionProbe { loaded: boolean }

interface CommandI18n {
  t(key: string, params?: MessageParams): string;
}

function loadCommandI18n(): CommandI18n {
  const loaded = registerLocalesFromDir(COMMAND_NAMESPACE, new URL("../../locales/", import.meta.url));
  if (loaded.diagnostics.length > 0) {
    throw new Error(
      `Failed to load pi-utils locales: ${loaded.diagnostics.map((item) => `${item.locale}: ${item.error}`).join("; ")}`,
    );
  }
  const translate = scope(COMMAND_NAMESPACE);
  return {
    t(key: string, params?: MessageParams): string {
      return translate(key, key, params);
    },
  };
}

function registerLocaleCommand(
  pi: ExtensionAPI,
  getFlagPreference: () => LocalePreference | undefined,
  i18n: CommandI18n,
): void {
  const command = {
    description: i18n.t("description"),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("noUi") });
        return;
      }

      const requested = args.trim();
      const directPreference = requested ? parseLocalePreference(requested) : undefined;
      if (requested && !directPreference) {
        notifyWithSource({
          ctx,
          source: NOTICE_SOURCE,
          level: "error",
          message: i18n.t("invalid", { value: requested }),
        });
        return;
      }

      let preference = directPreference;
      if (!preference) {
        const options = [i18n.t("zh"), i18n.t("en"), i18n.t("auto")];
        const current = getLocalePreference();
        const currentOption = current === "zh-CN"
          ? options[0]
          : current === "en-US"
            ? options[1]
            : options[2];
        const selected = await ctx.ui.select(`${i18n.t("title")} [${currentOption}]`, options);
        if (selected === undefined) return;
        preference = selected === options[0]
          ? "zh-CN"
          : selected === options[1]
            ? "en-US"
            : "auto";
      }

      try {
        const configPath = saveLocalePreference(preference);
        pi.events.emit(LOCALE_CHANGED_EVENT, { locale: getLocale() });
        const overrides = [
          getFlagPreference() ? i18n.t("flagOverride", { flag: `--${FLAG_NAME}` }) : "",
          process.env[LOCALE_ENV] ? i18n.t("envOverride", { env: LOCALE_ENV }) : "",
        ].filter(Boolean);
        const overrideNotice = overrides.length > 0 ? `\n${overrides.join("\n")}` : "";
        notifyWithSource({
          ctx,
          source: NOTICE_SOURCE,
          level: "info",
          message: `${i18n.t("saved", { locale: preference })}${overrideNotice}\n${configPath}`,
        });
      } catch (error) {
        notifyWithSource({
          ctx,
          source: NOTICE_SOURCE,
          level: "error",
          message: i18n.t("failed", { error: String(error) }),
        });
      }
    },
  };

  for (const name of ["config:language", "languages", "pi-language"] as const) {
    pi.registerCommand(name, command);
  }
}

export default function piI18n(pi: ExtensionAPI): void {
  // Dependency entry shims may load this factory through several package paths.
  const probe: ExtensionProbe = { loaded: false };
  pi.events.emit(EXTENSION_PROBE_EVENT, probe);
  if (probe.loaded) return;
  const releaseProbe = pi.events.on(EXTENSION_PROBE_EVENT, (data) => { (data as ExtensionProbe).loaded = true; });
  const noticeOwner = installNoticeRenderer(pi);
  const localeOwner = createLocaleOverrideOwner();
  const commandI18n = loadCommandI18n();
  let flagPreference: LocalePreference | undefined;
  let releaseNoticeOwner: NoticeOwnerRelease | undefined;

  pi.registerFlag(FLAG_NAME, {
    type: "string",
    description: commandI18n.t("flagDescription"),
  });

  pi.on("session_start", (_event, ctx) => {
    releaseNoticeOwner?.();
    releaseNoticeOwner = bindNoticeOwner(ctx, noticeOwner);

    const rawFlag = pi.getFlag(FLAG_NAME);
    flagPreference = typeof rawFlag === "string" ? parseLocalePreference(rawFlag) : undefined;
    if (typeof rawFlag === "string" && rawFlag.trim() && !flagPreference) {
      inheritLocaleForOwner(localeOwner);
      notifyWithSource({
        ctx,
        source: NOTICE_SOURCE,
        level: "error",
        message: commandI18n.t("invalid", { value: rawFlag }),
      });
      return;
    }
    if (flagPreference) applyLocaleForOwner(localeOwner, flagPreference);
    else inheritLocaleForOwner(localeOwner);
    pi.events.emit(LOCALE_CHANGED_EVENT, { locale: getLocale() });
  });

  pi.on("session_shutdown", () => {
    releaseProbe();
    releaseNoticeOwner?.();
    releaseNoticeOwner = undefined;
    releaseLocaleOverrideOwner(localeOwner);
  });

  registerLocaleCommand(pi, () => flagPreference, commandI18n);
}

export {
  bindNoticeOwner,
  formatNotice,
  getNoticeOwnerBinding,
  notifyWithSource,
  NOTICE_TAG_COLOR,
  installNoticeRenderer,
  hasNoticeRenderer,
  resetNoticeRenderer,
  renderNoticeEntry,
  noticeBodyColor,
  NOTICE_BACKGROUND_COLOR,
  NOTICE_COLOR_MODE,
  NOTICE_ENTRY_TYPE,
  type NoticeApi,
  type NoticeColor,
  type NoticeContext,
  type NoticeEntryData,
  type NoticeEntryTheme,
  type NoticeLevel,
  type NoticeOwnerBinding,
  type NoticeOwnerContext,
  type NoticeOwnerRelease,
  type NoticeRenderOptions,
  type NoticeSendOptions,
  type NoticeSource,
} from "./notice.ts";
