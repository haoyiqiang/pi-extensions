import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { updateJsonObjectAtomic } from "pi-utils";
import { notifyWithSource } from "pi-utils";
import { createActionFusionExtension } from "./src/action-fusion.ts";
import { loadActionFusionConfig } from "./src/config.ts";
import { i18n, NOTICE_SOURCE } from "./src/i18n.ts";

export { createActionFusionExtension, type ActionFusionOptions } from "./src/action-fusion.ts";
export { loadActionFusionConfig, type ActionFusionConfig } from "./src/config.ts";
export {
  assertUnchangedBeforeCommand, executeMutationThenRun,
  THEN_RUN_RUNNING, THEN_RUN_SUCCEEDED, THEN_RUN_FAILED, THEN_RUN_SKIPPED,
  type ThenRunInput, type ActionFusionDetails, type FusedDetails,
} from "./src/then-run.ts";

export default function actionFusion(pi: ExtensionAPI): void {
  let initialized = false;
  let loadedEnabled = false;
  pi.on("session_start", (_event, ctx) => {
    if (initialized) return;
    initialized = true;
    const loaded = loadActionFusionConfig();
    if (loaded.warning) notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: loaded.warning });
    loadedEnabled = loaded.config.enabled;
    if (loadedEnabled) createActionFusionExtension()(pi);
  });
  pi.registerCommand("config:action-fusion", {
    description: i18n.t("configDescription"),
    async handler(args, ctx) {
      const action = args.trim() || "status";
      const loaded = loadActionFusionConfig();
      if (action === "status") {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: loaded.warning ? "warning" : "info", message:
          loaded.warning ?? i18n.t("configStatus", { loaded: String(loadedEnabled), enabled: String(loaded.config.enabled), path: loaded.path }),
        });
        return;
      }
      if (action !== "enable" && action !== "disable") {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("configUsage") });
        return;
      }
      if (loaded.warning) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: loaded.warning });
        return;
      }
      try {
        const enabled = action === "enable";
        updateJsonObjectAtomic(loaded.path, (current) => ({ ...current, enabled }));
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("configSaved", { enabled: String(enabled), path: loaded.path }) });
      } catch (error) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "error", message: i18n.t("configSaveFailed", { error: String(error) }) });
      }
    },
  });
}
