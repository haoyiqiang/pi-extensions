import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { updateJsonObjectAtomic } from "pi-extensions-config";
import { NOTICE_TAG_COLOR, notifyWithSource } from "pi-extensions-i18n";
import { i18n } from "./i18n.js";
import { setConfiguredBackend } from "./runtime.js";
import { getSubagentsConfigPaths, loadSettings } from "./settings.js";

/** Changes the default for new agents; owned sessions retain their original backend. */
export function registerBackendCommand(pi: ExtensionAPI): void {
  pi.registerCommand("config:subagents", {
    description: i18n.t("product.backendDescription"),
    async handler(args, ctx) {
      let choice = args.trim();
      if (!choice) {
        if (!ctx.hasUI) {
          notifyWithSource({ ctx, source: { tag: "agents", color: NOTICE_TAG_COLOR }, level: "info",
            message: i18n.t("product.backendCurrent", { backend: loadSettings(ctx.cwd).backend ?? "embedded" }) });
          return;
        }
        choice = await ctx.ui.select(i18n.t("product.backendDescription"), ["embedded", "terminal"]) ?? "";
        if (!choice) return;
      }
      if (choice !== "embedded" && choice !== "terminal") {
        notifyWithSource({ ctx, source: { tag: "agents", color: NOTICE_TAG_COLOR }, level: "warning",
          message: i18n.t("product.backendUsage") });
        return;
      }
      try {
        const path = getSubagentsConfigPaths(ctx.cwd).project;
        updateJsonObjectAtomic(path, (settings) => ({ ...settings, backend: choice }));
        setConfiguredBackend(choice);
        notifyWithSource({ ctx, source: { tag: "agents", color: NOTICE_TAG_COLOR }, level: "info",
          message: i18n.t("product.backendSaved", { backend: choice, path }) });
      } catch (error) {
        notifyWithSource({ ctx, source: { tag: "agents", color: NOTICE_TAG_COLOR }, level: "error",
          message: i18n.t("product.backendSaveFailed", { error: String(error) }) });
      }
    },
  });
}
