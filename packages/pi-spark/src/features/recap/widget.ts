import { Container, Loader, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

import { i18n } from "../../i18n";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "recap";

export function setRecapLoadingWidget(ctx: ExtensionContext, warning?: string): void {
  ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
    const loader = new Loader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), i18n.t("recapGenerating"));
    loader.start();

    return {
      render: (width: number) => {
        const lines = loader.render(width);
        if (lines[0] === "") lines.shift();

        const loaderLine = (lines[0] ?? "").trimEnd();
        const line = `${loaderLine}${warning ? ` ${theme.fg("warning", i18n.t("recapWarning", { warning }))}` : ""}`;

        return [truncateToWidth(line, width), ""];
      },
      invalidate: () => loader.invalidate(),
      dispose: () => loader.stop(),
    };
  });
}

export function setRecapTextWidget(ctx: ExtensionContext, content: string, warning?: string): void {
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
    const text = `${theme.bold(theme.fg("muted", i18n.t("recapLabel")))}${theme.fg("muted", ` ${content}`)}${warning ? ` ${theme.fg("warning", i18n.t("recapWarning", { warning }))}` : ""}`;

    const container = new Container();
    container.addChild(new Text(text, 1, 0));
    container.addChild(new Spacer(1));

    return container;
  });
}

export function clearRecapWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}
