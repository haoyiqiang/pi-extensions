import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  registerStrings,
  SUPPORTED_LOCALES,
  type Locale,
  type LocaleStrings,
  type TranslationMap,
} from "./runtime.ts";

export interface LocaleLoadDiagnostic {
  locale: Locale;
  file: string;
  error: string;
}

export interface LocaleLoadResult {
  loaded: Locale[];
  diagnostics: LocaleLoadDiagnostic[];
}

/**
 * Loads flat `locales/<locale>.json` files from an explicit directory URL.
 * Missing or malformed locale files fall back at lookup time and are returned
 * as diagnostics instead of writing to console during module initialization.
 */
export function registerLocalesFromDir(
  namespace: string,
  localesDirectory: URL,
): LocaleLoadResult {
  const byLocale: Partial<Record<Locale, TranslationMap>> = {};
  const loaded: Locale[] = [];
  const diagnostics: LocaleLoadDiagnostic[] = [];

  for (const locale of SUPPORTED_LOCALES) {
    const fileUrl = new URL(`./${locale}.json`, localesDirectory);
    const file = fileURLToPath(fileUrl);
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("locale file must be a JSON object");
      }
      const strings: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") throw new Error(`locale key ${key} must be a string`);
        strings[key] = value;
      }
      byLocale[locale] = strings;
      loaded.push(locale);
    } catch (error) {
      diagnostics.push({
        locale,
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  registerStrings(namespace, byLocale as LocaleStrings);
  return { loaded, diagnostics };
}
