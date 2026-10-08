import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { i18n } from "./src/i18n.ts";
import { filterItems, isBackspace, isPrintable } from "./fuzzy.ts";

const MAX_VISIBLE_ROWS = 10;

function selectListTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.bg("selectedBg", theme.fg("accent", text)),
		selectedText: (text: string) => theme.bg("selectedBg", theme.bold(text)),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

function buildPanel(theme: Theme, title: string, prose: string[], query: string, list: SelectList): Container {
	const container = new Container();
	const border = () => new DynamicBorder((text: string) => theme.fg("accent", text));
	container.addChild(border());
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	container.addChild(new Spacer(1));
	for (const line of prose) {
		container.addChild(new Text(line, 1, 0));
		container.addChild(new Spacer(1));
	}
	const filter = query ? i18n.t("pickerFilter", { query }) : i18n.t("pickerFilterPlaceholder");
	container.addChild(new Text(theme.fg(query ? "accent" : "dim", filter), 1, 0));
	container.addChild(new Spacer(1));
	container.addChild(list);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", i18n.t("pickerNavHint")), 1, 0));
	container.addChild(new Spacer(1));
	container.addChild(border());
	return container;
}

interface PickerOptions {
	title: string;
	prose: string[];
	items: SelectItem[];
	preferredValue?: string;
}

async function showNativePicker(ctx: ExtensionContext, options: PickerOptions): Promise<string | null> {
	const labels = options.items.map((item) => item.label);
	const selected = await ctx.ui.select(options.title, labels);
	if (selected === undefined) return null;
	return options.items.find((item) => item.label === selected)?.value ?? null;
}

function showTuiPicker(ctx: ExtensionContext, options: PickerOptions): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		let query = "";
		let list: SelectList;
		let container: Container;
		const rebuild = () => {
			const filtered = filterItems(options.items, query);
			list = new SelectList(filtered, Math.min(Math.max(filtered.length, 1), MAX_VISIBLE_ROWS), selectListTheme(theme));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			if (!query && options.preferredValue) {
				const index = filtered.findIndex((item) => item.value === options.preferredValue);
				if (index >= 0) list.setSelectedIndex(index);
			}
			container = buildPanel(theme, options.title, options.prose, query, list);
		};
		rebuild();
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (isBackspace(data) && query.length > 0) {
					query = query.slice(0, -1);
					rebuild();
				} else if (isPrintable(data)) {
					query += data;
					rebuild();
				} else {
					list.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}

function showPicker(ctx: ExtensionContext, options: PickerOptions): Promise<string | null> {
	return ctx.mode === "tui" || ctx.mode === undefined
		? showTuiPicker(ctx, options)
		: showNativePicker(ctx, options);
}

export function showAdvisorPicker(ctx: ExtensionContext, items: SelectItem[]): Promise<string | null> {
	return showPicker(ctx, {
		title: i18n.t("pickerAdvisorTitle"),
		prose: [i18n.t("pickerAdvisorProse1"), i18n.t("pickerAdvisorProse2")],
		items,
	});
}

export function showEffortPicker(
	ctx: ExtensionContext,
	items: SelectItem[],
	currentEffort: ThinkingLevel | undefined,
	defaultEffort: ThinkingLevel,
): Promise<string | null> {
	return showPicker(ctx, {
		title: i18n.t("pickerEffortTitle"),
		prose: [i18n.t("pickerEffortProse")],
		items,
		preferredValue: items.some((item) => item.value === currentEffort) ? currentEffort : defaultEffort,
	});
}
