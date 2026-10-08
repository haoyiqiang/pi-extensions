import { createTranslator, loadCatalog, NOTICE_TAG_COLOR, type NoticeSource } from "pi-extensions-i18n";

export const catalog = loadCatalog(new URL("./catalog.json", import.meta.url));
export const i18n = createTranslator(catalog);
export const NOTICE_SOURCE: NoticeSource = { tag: "fusion", color: NOTICE_TAG_COLOR };
