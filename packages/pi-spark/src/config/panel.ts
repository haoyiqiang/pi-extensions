import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { clearConfigCache, loadConfig } from "./index.ts";
import { featureSchemas, type SparkConfig, type SparkConfigInput } from "./schema.ts";
import { patchConfigFeature, projectOverridesFeature, projectSparkConfigPath, sparkConfigPath } from "./store.ts";
import { openConfigPanel as openCleanModeConfigPanel } from "../features/clean-mode/config-panel.ts";
import { openNamingConfigPanel } from "../features/naming/index.ts";

const COMMAND = "config:spark";
type Feature = keyof SparkConfig;
const FEATURES: Record<Feature, string> = {
  cleanMode: "Clean mode",
  credits: "Credits",
  editor: "Editor",
  footer: "Footer",
  metrics: "Metrics",
  naming: "Session and terminal naming",
  presets: "Model presets",
  recap: "Recap",
  resources: "Session resources",
};

interface Choice {
  id: string;
  label: string;
}

async function select(ctx: ExtensionCommandContext, title: string, choices: Choice[]): Promise<string | undefined> {
  const selected = await ctx.ui.select(title, choices.map((choice) => choice.label));
  return choices.find((choice) => choice.label === selected)?.id;
}

function enabled(key: Feature, value: SparkConfig[Feature]): boolean {
  if (value === false) return false;
  if (key === "cleanMode" || key === "resources") return !("enabled" in value) || value.enabled !== false;
  return true;
}

/** Small, frequent settings get direct choices; the JSON editor covers every schema field. */
function quickSettings(key: Feature): Array<{ field: string; values: string[]; fallback: string }> {
  if (key === "editor") return [
    { field: "spinner", values: ["dots", "lights", "tildes", "pulse"], fallback: "tildes" },
    { field: "thinkingLevelIndicator", values: ["border", "model"], fallback: "border" },
  ];
  if (key === "footer") return [
    { field: "style", values: ["default", "p10k"], fallback: "default" },
    { field: "statusPosition", values: ["inline", "below"], fallback: "inline" },
  ];
  if (key === "metrics") return [{ field: "display", values: ["on-stop", "live"], fallback: "on-stop" }];
  if (key === "recap") return [{ field: "thinkingLevel", values: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fallback: "off" }];
  return [];
}

/** Edits the project-owned feature when present, otherwise the global feature. */
export async function openSparkConfigPanel(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(`/${COMMAND} requires interactive mode.`, "warning");
    return;
  }

  clearConfigCache();
  const savedPaths = new Set<string>();
  const previous = new Map<Feature, SparkConfigInput[Feature]>();
  const save = (key: Feature, value: SparkConfigInput[Feature]): boolean => {
    try {
      const validated = value === false ? false : featureSchemas[key].parse(value);
      const path = projectOverridesFeature(ctx.cwd, key) ? projectSparkConfigPath(ctx.cwd) : sparkConfigPath();
      patchConfigFeature(path, key, validated);
      savedPaths.add(path);
      return true;
    } catch (error) {
      ctx.ui.notify(`Failed to save ${FEATURES[key]} configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
  };

  try {
    for (;;) {
      const config = loadConfig(ctx);
      const action = await select(ctx, "Spark configuration · changes are saved immediately; /reload to apply", [
        ...(Object.keys(FEATURES) as Feature[]).map((key) => ({
          id: key,
          label: `${FEATURES[key]}: ${enabled(key, config[key]) ? "on" : "off"} · ${projectOverridesFeature(ctx.cwd, key) ? "project" : "global"}`,
        })),
        { id: "done", label: "Done" },
      ]);
      if (!action || action === "done") break;
      const key = action as Feature;

      for (;;) {
        const value = loadConfig(ctx)[key];
        const isEnabled = enabled(key, value);
        const settings = quickSettings(key);
        const object = value === false ? {} : value as Record<string, unknown>;
        const path = projectOverridesFeature(ctx.cwd, key) ? projectSparkConfigPath(ctx.cwd) : sparkConfigPath();
        const choice = await select(ctx, `${FEATURES[key]} · ${path}`, [
          { id: "toggle", label: `Enabled: ${isEnabled ? "on" : "off"}` },
          ...settings.map((setting) => ({ id: setting.field, label: `${setting.field}: ${object[setting.field] ?? setting.fallback}` })),
          ...(key === "naming" || (key === "cleanMode" && ctx.mode === "tui")
            ? [{ id: "details", label: "Detailed settings…" }] : []),
          { id: "edit", label: "Edit all settings (JSON)…" },
          { id: "reset", label: "Reset settings…" },
          { id: "back", label: "Back" },
        ]);
        if (!choice || choice === "back") break;
        if (choice === "toggle") {
          if (isEnabled) {
            if (save(key, false)) previous.set(key, value);
          } else {
            const next = previous.get(key) ?? (value === false ? {} : value);
            save(key, key === "cleanMode" || key === "resources" ? { ...next as object, enabled: true } : next);
          }
        } else if (choice === "details" && key === "cleanMode") {
          await openCleanModeConfigPanel(ctx, {
            getConfig: () => {
              const current = loadConfig(ctx).cleanMode;
              return featureSchemas.cleanMode.parse(current === false ? { enabled: false } : current);
            },
            onChange: (next) => { save("cleanMode", next); },
          });
        } else if (choice === "details" && key === "naming") {
          await openNamingConfigPanel(ctx, {
            load: () => {
              const current = loadConfig(ctx).naming;
              return featureSchemas.naming.parse(current === false ? {} : current);
            },
            save: (next) => {
              if (!save("naming", next)) throw new Error("Naming settings were not saved.");
              return path;
            },
            path: () => path,
          });
        } else if (choice === "edit") {
          const text = await ctx.ui.editor(`${FEATURES[key]} settings · JSON object or false`, JSON.stringify(value, null, 2));
          if (text === undefined) continue;
          try {
            const next = JSON.parse(text);
            if (next !== false && (next === null || typeof next !== "object" || Array.isArray(next))) {
              throw new Error("Settings must be a JSON object or false.");
            }
            save(key, next);
          } catch (error) {
            ctx.ui.notify(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        } else if (choice === "reset") {
          if (await ctx.ui.confirm(`Reset ${FEATURES[key]}?`, "Replace this feature's section with schema defaults. Unspecified project options still inherit global settings. Other features are preserved.")) {
            if (save(key, featureSchemas[key].parse({}))) previous.delete(key);
          }
        } else {
          const setting = settings.find((entry) => entry.field === choice);
          if (!setting) continue;
          const selected = await ctx.ui.select(`Select ${setting.field}`, setting.values);
          if (selected !== undefined) save(key, { ...object, [setting.field]: selected });
        }
      }
    }
  } catch (error) {
    ctx.ui.notify(`Failed to read Spark configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    if (savedPaths.size > 0) ctx.ui.notify(`Spark configuration saved to ${[...savedPaths].join(", ")}. Run /reload to apply all changes.`, "info");
  }
}

export function registerSparkConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND, {
    description: "Configure Spark features and settings",
    handler: async (_args, ctx) => openSparkConfigPanel(ctx),
  });
}
