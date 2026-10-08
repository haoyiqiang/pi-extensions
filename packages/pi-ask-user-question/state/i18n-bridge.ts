import { createTranslator, loadCatalog, type MessageParams } from "pi-extensions-i18n";
import { ROW_INTENT_META, type SentinelKind } from "./row-intent.js";

export const I18N_NAMESPACE = "pi-ask-user-question";
export const i18n = createTranslator(loadCatalog(new URL("../catalog.json", import.meta.url)));

/** Compatibility surface retained for the imported render graph; lookups remain live by locale. */
export function t(key: string, _fallback?: string, params?: MessageParams): string {
	return i18n.t(key as Parameters<typeof i18n.t>[0], params);
}

export function displayLabel(kind: SentinelKind): string {
	return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}
