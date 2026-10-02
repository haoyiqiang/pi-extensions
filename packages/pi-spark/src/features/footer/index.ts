import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Text } from "@earendil-works/pi-tui";

import { SplitLine } from "../../components/split-line";
import { loadConfig } from "../../config";
import { formatContextUsage, formatCwd, formatLink, sanitizeText } from "../../utils/format";
import { getEntryUsage } from "../../utils/usage";
import { formatP10kLeft, osPromptIcon } from "./p10k";

import type { ExtensionContext, ExtensionAPI, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { FooterStyle, StatusPosition } from "./config";

const DEFAULT_STATUS_POSITION: StatusPosition = "inline";
const DEFAULT_STYLE: FooterStyle = "default";

class FooterComponent implements Component {
  private ctx: ExtensionContext;
  private theme: Theme;
  private footerData: ReadonlyFooterDataProvider;
  private statusPosition: StatusPosition;
  private style: FooterStyle;

  constructor(
    ctx: ExtensionContext,
    theme: Theme,
    footerData: ReadonlyFooterDataProvider,
    statusPosition: StatusPosition = DEFAULT_STATUS_POSITION,
    style: FooterStyle = DEFAULT_STYLE,
  ) {
    this.ctx = ctx;
    this.theme = theme;
    this.footerData = footerData;
    this.statusPosition = statusPosition;
    this.style = style;
  }

  invalidate(): void {
    // No-op
  }

  render(width: number): string[] {
    const left = this.getLeft();
    const right = this.getRight();

    const lines = new SplitLine(left, right, { primarySide: "right", ellipsis: this.theme.fg("dim", "…") }).render(width);

    if (this.statusPosition === "below") {
      const statusesText = this.getStatusesText();
      if (statusesText) lines.push(...new Text(statusesText, 0, 0).render(width));
    }

    return lines;
  }

  private getLeft(): string {
    const cwd = this.ctx.sessionManager.getCwd();
    const url = pathToFileURL(resolve(cwd));
    const cwdText = formatLink(formatCwd(cwd, homedir()), url.href);
    const branch = this.footerData.getGitBranch();

    if (this.style === "p10k") return this.getP10kLeft(cwdText, branch);

    const sessionName = this.ctx.sessionManager.getSessionName();
    return this.theme.fg("dim", [cwdText, branch, sessionName].filter(Boolean).join(" · "));
  }

  private getP10kLeft(cwdText: string, branch: string | null): string {
    return formatP10kLeft(
      {
        osIcon: osPromptIcon(platform()),
        path: this.theme.fg("accent", cwdText),
        branch,
      },
      {
        text: (value) => this.theme.fg("text", value),
        dim: (value) => this.theme.fg("dim", value),
        accent: (value) => this.theme.fg("accent", value),
        success: (value) => this.theme.fg("success", value),
      },
    );
  }

  private getRight(): string {
    const statusesText = this.statusPosition === "inline" ? this.getStatusesText() : "";
    const styledCostText = this.getStyledCostText();
    const styledContextUsageText = this.getStyledContextUsageText();

    return [statusesText, styledCostText, styledContextUsageText].filter(Boolean).join(this.theme.fg("dim", " · "));
  }

  /** Gets extension statuses, sorted alphabetically by key. */
  private getStatusesText(): string {
    const extensionStatuses = this.footerData.getExtensionStatuses();
    if (extensionStatuses.size === 0) return "";

    return Array.from(extensionStatuses.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitizeText(text))
      .join(this.theme.fg("dim", " · "));
  }

  private getStyledCostText(): string {
    const totalCost = this.ctx.sessionManager.getEntries().reduce((acc, entry) => acc + (getEntryUsage(entry)?.cost.total ?? 0), 0);
    if (totalCost < 0.0005) return ""; // Hide cost below half a millicent, since it would render as $0.000.

    const costText = `$${totalCost.toFixed(3)}`;

    if (totalCost > 20) return this.theme.fg("warning", costText);
    return this.theme.fg("dim", costText);
  }

  private getStyledContextUsageText(): string {
    const contextUsage = this.ctx.getContextUsage();
    const contextUsageText = formatContextUsage(contextUsage);
    const percent = contextUsage?.percent ?? null;

    if (percent && percent > 90) return this.theme.fg("error", contextUsageText);
    if (percent && percent > 70) return this.theme.fg("warning", contextUsageText);
    return this.theme.fg("dim", contextUsageText);
  }
}

export function registerFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const config = loadConfig(ctx).footer;
    if (ctx.mode !== "tui" || !config) return;

    ctx.ui.setFooter((_tui, theme, footerData) => new FooterComponent(ctx, theme, footerData, config.statusPosition, config.style));
  });
}
