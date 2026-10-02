import { scope, type MessageParams } from "pi-extensions-i18n";
import { registerLocalesFromDir } from "pi-extensions-i18n/loader";

const NAMESPACE = "pi-distill";
const loaded = registerLocalesFromDir(NAMESPACE, new URL("../locales/", import.meta.url));
if (loaded.diagnostics.length > 0) {
  throw new Error(
    `Failed to load pi-distill locales: ${loaded.diagnostics.map((item) => `${item.locale}: ${item.error}`).join("; ")}`,
  );
}

const translate = scope(NAMESPACE);

function scopedCatalog(prefix = "") {
  return {
    t(key: string, params?: MessageParams): string {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      return translate(fullKey, fullKey, params);
    },
  };
}

export const i18n = scopedCatalog();
export const rendererI18n = scopedCatalog("render");
export const promptI18n = scopedCatalog("prompt");
