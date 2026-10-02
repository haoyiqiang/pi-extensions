import {
  NOTICE_TAG_COLOR,
  scope,
  type MessageParams,
  type NoticeColor,
  type NoticeSource,
} from "pi-extensions-i18n";
import { registerLocalesFromDir } from "pi-extensions-i18n/loader";

const NAMESPACE = "pi-context-view";
const loaded = registerLocalesFromDir(NAMESPACE, new URL("../locales/", import.meta.url));
if (loaded.diagnostics.length > 0) {
  throw new Error(
    `Failed to load pi-context-view locales: ${loaded.diagnostics.map((item) => `${item.locale}: ${item.error}`).join("; ")}`,
  );
}

const translate = scope(NAMESPACE);

export const i18n = {
  t(key: string, params?: MessageParams): string {
    return translate(key, key, params);
  },
};

/** 本扩展的提示标签；短且唯一，便于在会话里定位来源。 */
const NOTICE_TAG = "context";
/** 提示标签颜色：所有扩展统一用弱化色，来源靠 tag 文本区分，不靠颜色。 */
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
/** 本扩展的提示来源。 */
export const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };
