import { i18n as sparkI18n } from "../../i18n.ts";

const KEYS = {
  commandDescription: "resourcesCommandDescription",
  commandUsage: "resourcesCommandUsage",
  configLoadFailed: "resourcesConfigLoadFailed",
  configSaveFailed: "resourcesConfigSaveFailed",
  referenceHint: "resourcesReferenceHint",
  referenceDisabledHint: "resourcesReferenceDisabledHint",
  enabled: "resourcesEnabled",
  disabled: "resourcesDisabled",
  pickerTitle: "resourcesPickerTitle",
  pickerNoMatches: "resourcesPickerNoMatches",
  pickerHint: "resourcesPickerHint",
  viewResources: "resourcesViewResources",
  pickerHintMouse: "resourcesPickerHintMouse",
  pickerClose: "resourcesPickerClose",
  actionRead: "resourcesActionRead",
  actionChanged: "resourcesActionChanged",
  actionInspected: "resourcesActionInspected",
  actionOpened: "resourcesActionOpened",
  actionCreated: "resourcesActionCreated",
  actionReferenced: "resourcesActionReferenced",
} as const;

/** Maps the moved picker catalog keys onto spark's shared catalog. */
export const i18n = {
  t(key: string, vars?: Record<string, string>): string {
    const mapped = KEYS[key as keyof typeof KEYS] ?? key;
    return sparkI18n.t(mapped as Parameters<typeof sparkI18n.t>[0], vars);
  },
};
