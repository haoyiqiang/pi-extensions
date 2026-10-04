import { scope, type MessageParams } from "pi-extensions-i18n";
import { registerLocalesFromDir } from "pi-extensions-i18n/loader";

const namespace = "pi-subagents";
const loaded = registerLocalesFromDir(namespace, new URL("../locales/", import.meta.url));
if (loaded.diagnostics.length > 0) {
  throw new Error(`Failed to load pi-subagents locales: ${loaded.diagnostics.map((item) => `${item.locale}: ${item.error}`).join("; ")}`);
}
const translate = scope(namespace);

/** New code is localized; imported upstream UI/prompts remain a separate migration. */
export const i18n = {
  t(key: string, params?: MessageParams): string {
    return translate(key, key, params);
  },
};
