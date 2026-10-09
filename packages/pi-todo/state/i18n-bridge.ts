import {
  createTranslator,
  loadCatalog,
  NOTICE_TAG_COLOR,
  type MessageParams,
  type NoticeSource,
} from "pi-utils";
import type { TaskStatus } from "../tool/types.js";

export const i18n = createTranslator(loadCatalog(new URL("../catalog.json", import.meta.url)));
export const NOTICE_SOURCE: NoticeSource = { tag: "todo", color: NOTICE_TAG_COLOR };

export function t(key: string, params?: MessageParams): string {
  return i18n.t(key, params);
}

export function formatStatusLabel(status: TaskStatus): string {
  return t(`status.${status}`);
}
