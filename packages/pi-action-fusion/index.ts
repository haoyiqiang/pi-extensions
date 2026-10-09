import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { updateJsonObjectAtomic } from "pi-utils";

import { createActionFusionExtension } from "./src/action-fusion.ts";
import { loadActionFusionConfig } from "./src/config.ts";

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
    if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
    loadedEnabled = loaded.config.enabled;
    if (loadedEnabled) createActionFusionExtension()(pi);
  });
  pi.registerCommand("config:action-fusion", {
    description: "Configure Action Fusion: status, enable, or disable; reload after changes",
    async handler(args, ctx) {
      const action = args.trim() || "status";
      const loaded = loadActionFusionConfig();
      if (action === "status") {
        ctx.ui.notify(loaded.warning ?? `Action Fusion: loaded=${String(loadedEnabled)}; configured=${String(loaded.config.enabled)}.
${loaded.path}`, loaded.warning ? "warning" : "info");
        return;
      }
      if (action !== "enable" && action !== "disable") {
        ctx.ui.notify("Usage: /config:action-fusion [status|enable|disable]", "warning");
        return;
      }
      if (loaded.warning) {
        ctx.ui.notify(loaded.warning, "warning");
        return;
      }
      try {
        const enabled = action === "enable";
        updateJsonObjectAtomic(loaded.path, (current) => ({ ...current, enabled }));
        ctx.ui.notify(`Action Fusion configured=${String(enabled)}. Run /reload to apply.
${loaded.path}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not save Action Fusion configuration: ${String(error)}`, "error");
      }
    },
  });
}
