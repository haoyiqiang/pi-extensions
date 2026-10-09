import { scope, type MessageParams } from "pi-utils";
import { registerLocalesFromDir } from "pi-utils/loader";

const NAMESPACE = "pi-terminal-mux";
const loaded = registerLocalesFromDir(NAMESPACE, new URL("../locales/", import.meta.url));
if (loaded.diagnostics.length > 0) {
  throw new Error(
    `Failed to load pi-terminal-mux locales: ${loaded.diagnostics.map((item) => `${item.locale}: ${item.error}`).join("; ")}`,
  );
}

const translate = scope(NAMESPACE);

export const i18n = {
  t(key: string, params?: MessageParams): string {
    return translate(key, key, params);
  },
};
