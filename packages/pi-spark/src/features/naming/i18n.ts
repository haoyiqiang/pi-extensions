import type { MessageParams } from "pi-extensions-i18n";
import { i18n as sparkI18n } from "../../i18n.ts";

/** Naming shares Spark's catalog, locale and notice ownership. */
export const i18n = {
  t(key: string, params?: MessageParams): string {
    return sparkI18n.t(`naming.${key}`, params);
  },
};
