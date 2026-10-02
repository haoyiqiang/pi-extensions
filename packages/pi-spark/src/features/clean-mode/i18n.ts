import { i18n as sparkI18n } from "../../i18n.ts";

/** Maps the moved clean-mode catalog keys onto spark's shared catalog. */
export const i18n = {
  t(key: string, vars?: Record<string, string>): string {
    const mapped = `cleanMode${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    return sparkI18n.t(mapped as Parameters<typeof sparkI18n.t>[0], vars);
  },
};
