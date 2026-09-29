import {
  NOTICE_TAG_COLOR,
  createTranslator,
  loadCatalog,
  notifyWithSource,
  type NoticeColor,
  type NoticeContext,
  type NoticeLevel,
  type NoticeSource,
} from "pi-extensions-i18n";

export const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

/** 本扩展的提示标签；短且唯一，便于在会话里定位来源。 */
const NOTICE_TAG = "blackhole";
/** 提示标签颜色：所有扩展统一用弱化色，来源靠 tag 文本区分，不靠颜色。 */
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
/** 本扩展的提示来源。 */
export const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

/** 把 Blackhole 的轻量运行时上下文接入统一提示出口。 */
export function notifyBlackhole(
  ctx: { mode?: string; hasUI?: boolean; ui?: NoticeContext["ui"] },
  level: NoticeLevel,
  message: string,
): void {
  if (!ctx.ui) return;
  const mode = ctx.mode ?? (ctx.hasUI ? "tui" : undefined);
  notifyWithSource({ ctx: { mode, ui: ctx.ui }, source: NOTICE_SOURCE, level, message });
}
