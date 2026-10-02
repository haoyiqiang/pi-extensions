import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createTranslator, loadCatalog } from "./catalog.ts";
import {
  applyLocale,
  clearLocaleOverride,
  getLocalePreference,
  LOCALE_ENV,
  parseLocalePreference,
  saveLocalePreference,
  type LocalePreference,
} from "./runtime.ts";
import {
  NOTICE_TAG_COLOR,
  installNoticeRenderer,
  notifyWithSource,
  type NoticeColor,
  type NoticeSource,
} from "./notice.ts";

export * from "./catalog.ts";
export * from "./runtime.ts";

const commandMessages = loadCatalog(new URL("../locales/command.json", import.meta.url));
const NOTICE_TAG = "language";
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };
const FLAG_NAME = "locale";

function registerLocaleCommand(
  pi: ExtensionAPI,
  getFlagPreference: () => LocalePreference | undefined,
): void {
  const i18n = createTranslator(commandMessages);
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
  installNoticeRenderer(pi);
  const commandI18n = createTranslator(commandMessages);
  let flagPreference: LocalePreference | undefined;

  pi.registerFlag(FLAG_NAME, {
    type: "string",
    description: commandI18n.t("flagDescription"),
  });

  pi.on("session_start", (_event, ctx) => {
    const rawFlag = pi.getFlag(FLAG_NAME);
    flagPreference = typeof rawFlag === "string" ? parseLocalePreference(rawFlag) : undefined;
    if (typeof rawFlag === "string" && rawFlag.trim() && !flagPreference) {
      clearLocaleOverride();
      notifyWithSource({
        ctx,
        source: NOTICE_SOURCE,
        level: "error",
        message: commandI18n.t("invalid", { value: rawFlag }),
      });
      return;
    }
    if (flagPreference) applyLocale(flagPreference);
    else clearLocaleOverride();
  });

  registerLocaleCommand(pi, () => flagPreference);
}

export {
  formatNotice,
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
  type NoticeRenderOptions,
  type NoticeSendOptions,
  type NoticeSource,
} from "./notice.ts";
