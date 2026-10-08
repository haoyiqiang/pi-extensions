import { createTranslator, loadCatalog, NOTICE_TAG_COLOR, type NoticeSource } from "pi-extensions-i18n";

export const i18n = createTranslator(loadCatalog(new URL("./catalog.json", import.meta.url)));
export const NOTICE_SOURCE: NoticeSource = { tag: "advisor", color: NOTICE_TAG_COLOR };
