import { PRESET_CHANGE } from "../../events";
import { formatModel } from "../../utils/format";
import { i18n, NOTICE_SOURCE } from "../../i18n";
import { notifyWithSource } from "pi-extensions-i18n";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PresetConfig, PresetsConfig } from "./config";

export class PresetManager {
  private pi: ExtensionAPI;
  private presets: PresetsConfig;
  private active: string | undefined = undefined;

  constructor(pi: ExtensionAPI, presets: PresetsConfig) {
    this.pi = pi;
    this.presets = presets;
  }

  get keys(): string[] {
    return Object.keys(this.presets);
  }

  isActive(ctx: ExtensionContext, key: string): boolean {
    const current = this.getCurrentPreset(ctx);
    return key === this.findKey(current);
  }

  sync(ctx: ExtensionContext): void {
    const current = this.getCurrentPreset(ctx);
    const currentKey = this.findKey(current);
    if (currentKey === this.active) return;

    this.active = currentKey;
    this.pi.events.emit(PRESET_CHANGE, this.active);
  }

  async apply(key: string, ctx: ExtensionContext): Promise<boolean> {
    const preset = this.presets[key];
    if (!preset) {
      notifyWithSource({
        ctx,
        source: NOTICE_SOURCE,
        level: "error",
        message: i18n.t("unknownPreset", {
          key,
          available: this.keys.length
            ? i18n.t("availablePresets", { keys: this.keys.join(", ") })
            : i18n.t("noPresetsDefined"),
        }),
      });
      return false;
    }

    const model = ctx.modelRegistry.find(preset.provider, preset.model);
    if (!model) {
      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "error", message: i18n.t("presetModelNotFound", { key, model: `${preset.provider}/${preset.model}` }) });
      return false;
    }

    const success = await this.pi.setModel(model);
    if (!success) {
      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "error", message: i18n.t("presetNoApiKey", { key, model: `${preset.provider}/${preset.model}` }) });
      return false;
    }

    this.pi.setThinkingLevel(preset.thinkingLevel);

    this.active = this.findKey({
      provider: model.provider,
      model: model.id,
      thinkingLevel: this.pi.getThinkingLevel(),
    });
    this.pi.events.emit(PRESET_CHANGE, this.active);

    if (this.active === key) {
      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("presetApplied", { key, description: this.describe(key) }) });
    } else {
      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("presetThinkingClamped", { key, requested: preset.thinkingLevel, applied: this.pi.getThinkingLevel() }) });
    }

    return true;
  }

  async cycle(ctx: ExtensionContext, direction: "forward" | "backward"): Promise<void> {
    if (this.keys.length === 0) {
      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("noPresets") });
      return;
    }

    const current = this.getCurrentPreset(ctx);
    const currentKey = this.findKey(current);
    const currentIndex = currentKey ? this.keys.indexOf(currentKey) : -1;
    const step = direction === "forward" ? 1 : -1;
    const nextIndex = currentIndex === -1 ? direction === "forward" ? 0 : this.keys.length - 1 : (currentIndex + step + this.keys.length) % this.keys.length;

    for (let offset = 0; offset < this.keys.length; offset++) {
      const candidateIndex = (nextIndex + step * offset + this.keys.length) % this.keys.length;
      const candidateKey = this.keys[candidateIndex];
      if (!candidateKey) continue;

      if (await this.apply(candidateKey, ctx)) return;
    }
  }

  describe(key: string): string {
    const preset = this.presets[key];
    return preset ? formatModel(preset.provider, preset.model, preset.thinkingLevel) : "";
  }

  private findKey(preset: PresetConfig | undefined): string | undefined {
    if (!preset) return;

    return this.keys.find((key) => {
      const p = this.presets[key];

      return p.provider === preset.provider && p.model === preset.model && p.thinkingLevel === preset.thinkingLevel;
    });
  }

  private getCurrentPreset(ctx: ExtensionContext): PresetConfig | undefined {
    if (!ctx.model) return undefined;

    return {
      provider: ctx.model.provider,
      model: ctx.model.id,
      thinkingLevel: this.pi.getThinkingLevel(),
    };
  }
}
