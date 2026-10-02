import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getLocale,
  interpolate,
  type Locale,
  type MessageParams,
} from "./runtime.ts";

export type MessageCatalog = Record<string, Record<Locale, string>>;
export type MessageKey<Catalog extends MessageCatalog> = keyof Catalog & string;

export interface Translator<Catalog extends MessageCatalog> {
  locale(): Locale;
  t(key: MessageKey<Catalog>, params?: MessageParams): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Loads the repository's compatibility catalog format: key → locale → string. */
export function loadCatalog(catalogFile: URL | string): MessageCatalog {
  const filePath = catalogFile instanceof URL ? fileURLToPath(catalogFile) : catalogFile;
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`Invalid i18n catalog: expected an object in ${filePath}`);
  }

  const catalog: MessageCatalog = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (!isRecord(entry) || typeof entry["zh-CN"] !== "string" || typeof entry["en-US"] !== "string") {
      throw new Error(`Invalid i18n catalog entry ${key} in ${filePath}`);
    }
    catalog[key] = {
      "zh-CN": entry["zh-CN"],
      "en-US": entry["en-US"],
    };
  }
  return catalog;
}

/** Compatibility translator for existing key-first bilingual catalogs. */
export function createTranslator<Catalog extends MessageCatalog>(
  catalog: Catalog,
): Translator<Catalog> {
  return {
    locale: getLocale,
    t(key, params) {
      const entry = catalog[key];
      if (!entry) throw new Error(`Unknown i18n message key: ${String(key)}`);
      const locale = getLocale();
      const message = entry[locale];
      if (message === undefined) {
        throw new Error(`Missing ${locale} translation for message key: ${String(key)}`);
      }
      return interpolate(message, params);
    },
  };
}
