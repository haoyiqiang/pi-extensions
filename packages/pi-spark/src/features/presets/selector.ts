import { keyHint, rawKeyHint, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Box, Container, SelectList, Spacer, Text } from "@earendil-works/pi-tui";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import type { PresetManager } from "./manager";
import { i18n, NOTICE_SOURCE } from "../../i18n";
import { notifyWithSource } from "pi-extensions-i18n";

export async function showPresetSelector(ctx: ExtensionContext, presetManager: PresetManager): Promise<string | undefined> {
  if (presetManager.keys.length === 0) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("noPresets") });
    return undefined;
  }

  const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const items = presetManager.keys.map((key) => ({
      value: key,
      label: presetManager.isActive(ctx, key) ? `${key} ${theme.fg("success", "✓")} ` : key,
      description: presetManager.describe(key),
    }));

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));

    const box = new Box(1, 1);
    box.addChild(new Text(theme.bold(theme.fg("accent", i18n.t("selectPreset"))), 0, 0));
    box.addChild(new Spacer(1));

    const selectList = new SelectList(items, 10, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });

    const activeIndex = presetManager.keys.findIndex((key) => presetManager.isActive(ctx, key));
    if (activeIndex > 0) selectList.setSelectedIndex(activeIndex);

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    box.addChild(selectList);
    box.addChild(new Spacer(1));

    const keyHints = [rawKeyHint("↑↓", i18n.t("keyNavigate")), keyHint("tui.select.confirm", i18n.t("keySelect")), keyHint("tui.select.cancel", i18n.t("keyCancel"))];
    box.addChild(new Text(keyHints.join("  "), 0, 0));

    container.addChild(box);
    container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
      handleMouse: (event: TuiMouseEvent) => container.handleMouse(event),
    };
  });

  return selected ?? undefined;
}
