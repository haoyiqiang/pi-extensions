import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunState } from "./shared.ts";

export interface SubagentWidgetRun {
	name: string;
	startTime: number;
	state: RunState;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RESET = "\x1b[0m";

/** Above-editor box in the interactive-subagent widget style. */
export function renderSubagentWidget(runs: readonly SubagentWidgetRun[], width: number): string[] {
	if (runs.length === 0 || width < 1) return [];
	const shown = runs.slice(0, 7);
	const lines = [borderTop("Subagents", `${runs.length} agents`, width)];
	for (const run of shown) {
		lines.push(borderLine(` ${formatElapsed(run.startTime)}  ${run.name} `, ` ${run.state} `, width));
	}
	if (runs.length > shown.length) {
		lines.push(borderLine(` +${runs.length - shown.length} more `, "", width));
	}
	lines.push(borderBottom(width));
	return lines;
}

function formatElapsed(startTime: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function borderLine(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (width === 1) return `${ACCENT}│${RESET}`;
	const contentWidth = Math.max(0, width - 2);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= contentWidth) {
		const truncated = truncateToWidth(right, contentWidth);
		return `${ACCENT}│${RESET}${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}${ACCENT}│${RESET}`;
	}
	const truncatedLeft = truncateToWidth(left, Math.max(0, contentWidth - rightWidth));
	const pad = Math.max(0, contentWidth - visibleWidth(truncatedLeft) - rightWidth);
	return `${ACCENT}│${RESET}${truncatedLeft}${" ".repeat(pad)}${right}${ACCENT}│${RESET}`;
}

function borderTop(title: string, info: string, width: number): string {
	if (width <= 0) return "";
	if (width === 1) return `${ACCENT}╭${RESET}`;
	const inner = Math.max(0, width - 2);
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fill = "─".repeat(Math.max(0, inner - titlePart.length - infoPart.length));
	const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
	return `${ACCENT}╭${content}╮${RESET}`;
}

function borderBottom(width: number): string {
	if (width <= 0) return "";
	if (width === 1) return `${ACCENT}╰${RESET}`;
	return `${ACCENT}╰${"─".repeat(Math.max(0, width - 2))}╯${RESET}`;
}
