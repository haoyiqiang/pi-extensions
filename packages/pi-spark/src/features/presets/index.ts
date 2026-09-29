import { Key } from "@earendil-works/pi-tui";

import { PresetManager } from "./manager";
import { showPresetSelector } from "./selector";
import { loadConfig } from "../../config";
import { i18n, NOTICE_SOURCE } from "../../i18n";
import { notifyWithSource } from "pi-extensions-i18n";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerPresets(pi: ExtensionAPI): void {
  let presetManager: PresetManager | undefined = undefined;

  pi.registerFlag("preset", {
    description: i18n.t("presetFlagDescription"),
    type: "string",
  });

  pi.on("session_start", async (event, ctx) => {
    const config = loadConfig(ctx).presets;
    const presetFlag = event.reason === "startup" ? pi.getFlag("preset") : undefined;

    if (!config || Object.keys(config).length === 0) {
      if (presetFlag) notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("noPresets") });
      return;
    }

    presetManager = new PresetManager(pi, config);
    presetManager.sync(ctx);

    pi.registerCommand("preset", {
      description: i18n.t("presetCommandDescription"),
      getArgumentCompletions: (prefix: string) => {
        if (!presetManager) return null;

        const items = presetManager.keys
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ value: key, label: key, description: presetManager!.describe(key) }));

        return items.length > 0 ? items : null;
      },
      handler: async (args, ctx) => {
        if (!presetManager) return;

        const key = args.trim();
        if (key) {
          await presetManager.apply(key, ctx);
          return;
        }

        const selected = await showPresetSelector(ctx, presetManager);
        if (selected) {
          await presetManager.apply(selected, ctx);
        }
      },
    });

    if (presetFlag && typeof presetFlag === "string") {
      await presetManager.apply(presetFlag, ctx);
    }
  });

  pi.on("model_select", (_event, ctx) => {
    presetManager?.sync(ctx);
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    presetManager?.sync(ctx);
  });

  pi.registerShortcut(Key.ctrlSuper("p"), {
    description: i18n.t("presetCycleForward"),
    handler: async (ctx) => {
      await presetManager?.cycle(ctx, "forward");
    },
  });

  pi.registerShortcut(Key.ctrlShiftSuper("p"), {
    description: i18n.t("presetCycleBackward"),
    handler: async (ctx) => {
      await presetManager?.cycle(ctx, "backward");
    },
  });

  pi.on("session_shutdown", () => {
    presetManager = undefined;
  });
}
