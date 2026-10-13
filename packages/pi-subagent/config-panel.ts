import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSettingsListTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { discoverExtensionSources } from "./extension-sources.ts";
import { loadRoles, roleFilePath, THINKING_LEVELS, updateRoleConfig, updateRolePrompt, type Role, type RoleConfigPatch } from "./roles.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

const INHERIT = "__inherit__";
const NO_TOOLS = "__no_tools__";
const DISCOVERY = "__discovery__";
const ADD_SOURCE = "__add_source__";
const DONE = "__done__";

interface PanelOptions {
	title: string;
	hint?: string;
	items: SettingItem[];
	maxVisible?: number;
	search?: boolean;
	/** Return false to keep the panel open after a row activates. */
	onActivate?: (id: string, value: string) => boolean;
}

/** Render a SettingsList panel; resolves with the activated row id, or undefined on Esc. */
function showPanel(ctx: ExtensionCommandContext, options: PanelOptions): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) => {
		const theme = getSettingsListTheme();
		const list = new SettingsList(
			options.items,
			Math.min(options.items.length, options.maxVisible ?? 12),
			theme,
			(id, value) => {
				if (options.onActivate?.(id, value) === false) return;
				done(id);
			},
			() => done(undefined),
			{ enableSearch: options.search },
		);
		const container = new Container();
		container.addChild(new Text(options.title, 0, 0));
		if (options.hint) container.addChild(new Text(theme.hint(options.hint), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(list);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => list.handleInput?.(data),
		};
	});
}

function findRole(name: string): Role | undefined {
	return loadRoles().find((role) => role.name === name);
}

function modelLabel(role: Role): string {
	return role.model ?? "inherit";
}

function thinkingLabel(role: Role): string {
	return role.thinking ?? "inherit";
}

function toolsLabel(role: Role): string {
	if (role.tools === undefined) return "inherit";
	return role.tools.length > 0 ? role.tools.join(", ") : "none";
}

function extensionsLabel(role: Role): string {
	if (role.extensions === undefined || role.extensions === true) return "discovery";
	if (role.extensions === false || role.extensions.length === 0) return "disabled";
	return role.extensions.join(", ");
}

/** Persist a role patch; failures are reported instead of thrown so the panel stays usable. */
function save(ctx: ExtensionCommandContext, name: string, patch: RoleConfigPatch): void {
	try {
		updateRoleConfig(name, patch);
	} catch (error) {
		ctx.ui.notify(`Could not update ${name}: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function pickModel(ctx: ExtensionCommandContext, role: Role): Promise<string | null | undefined> {
	const current = role.model;
	const available = [...new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`))].sort();
	if (current && !available.includes(current)) available.unshift(current);
	const items: SettingItem[] = [
		{
			id: INHERIT,
			label: "Inherit parent model",
			currentValue: current ? "" : "current",
			values: [""],
			description: "Remove the model preset",
		},
		...available.map((id) => ({
			id,
			label: id,
			currentValue: id === current ? "current" : "",
			values: [""],
		})),
	];
	const selected = await showPanel(ctx, {
		title: `Model for ${role.name}`,
		hint: "Type to filter; Enter selects",
		items,
		search: available.length > 8,
	});
	return selected === undefined ? undefined : selected === INHERIT ? null : selected;
}

async function editTools(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string): Promise<void> {
	const allTools = pi.getAllTools().map((tool) => tool.name).sort();
	while (true) {
		const role = findRole(name);
		if (!role) return;
		const selected = new Set(role.tools ?? []);
		const items: SettingItem[] = [
			{
				id: INHERIT,
				label: "Use inherited defaults",
				currentValue: role.tools === undefined ? "current" : "",
				values: [""],
				description: "Remove the tools preset; the child gets Pi's default tools",
			},
			...allTools.map((tool) => ({
				id: tool,
				label: tool,
				currentValue: selected.has(tool) ? "on" : "off",
				values: ["on", "off"],
			})),
			{
				id: NO_TOOLS,
				label: "No tools",
				currentValue: role.tools?.length === 0 ? "current" : "",
				values: [""],
				description: "Disable every tool for this role",
			},
		];
		const activated = await showPanel(ctx, {
			title: `Tools for ${name}`,
			hint: "Enter toggles a tool; selecting any tool replaces the inherited preset",
			items,
			maxVisible: 14,
			search: true,
		});
		if (activated === undefined) return;
		if (activated === INHERIT) {
			save(ctx, name, { tools: null });
			return;
		}
		if (activated === NO_TOOLS) {
			save(ctx, name, { tools: [] });
			return;
		}
		const next = new Set(selected);
		if (next.has(activated)) next.delete(activated);
		else next.add(activated);
		save(ctx, name, { tools: allTools.filter((tool) => next.has(tool)) });
	}
}

async function editExtensions(ctx: ExtensionCommandContext, name: string): Promise<void> {
	while (true) {
		const role = findRole(name);
		if (!role) return;
		const discovering = role.extensions === undefined || role.extensions === true;
		const selected = Array.isArray(role.extensions) ? role.extensions : [];
		const ownBridge = join(packageDir, "index.ts");
		const candidates = [...new Set([...selected, ...discoverExtensionSources(ctx.cwd)])]
			.filter((source) => source !== ownBridge)
			.sort();
		const items: SettingItem[] = [
			{
				id: DISCOVERY,
				label: "Ordinary discovery",
				currentValue: discovering ? "on" : "off",
				values: ["on", "off"],
				description: "Load configured and project extensions; selecting a source below turns this off",
			},
			...candidates.map((source) => ({
				id: source,
				label: source,
				currentValue: selected.includes(source) ? "on" : "off",
				values: ["on", "off"],
				description: selected.includes(source) ? "Enter to unselect" : "Enter to select",
			})),
			{ id: ADD_SOURCE, label: "Add a source", currentValue: "", values: [""], description: "Path, npm:, git:, or https: source" },
			{ id: DONE, label: "Done", currentValue: "", values: [""] },
		];
		const activated = await showPanel(ctx, {
			title: `Extensions for ${name}`,
			hint: "Enter toggles a source; any selected source replaces ordinary discovery",
			items,
			maxVisible: 16,
			search: true,
		});
		if (activated === undefined || activated === DONE) return;
		if (activated === ADD_SOURCE) {
			const value = await ctx.ui.input("Extension source", "Path, npm:, git:, or https:");
			if (value?.trim()) save(ctx, name, { extensions: [...selected, value.trim()] });
			continue;
		}
		if (activated === DISCOVERY) {
			save(ctx, name, { extensions: discovering ? false : true });
			continue;
		}
		const next = selected.includes(activated)
			? selected.filter((source) => source !== activated)
			: [...selected, activated];
		save(ctx, name, { extensions: next.length > 0 ? next : false });
	}
}

async function editRole(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string): Promise<void> {
	while (true) {
		const role = findRole(name);
		if (!role) return;
		const selected = await showPanel(ctx, {
			title: `Role: ${name}`,
			hint: roleFilePath(name),
			items: [
				{
					id: "model",
					label: "Model",
					currentValue: modelLabel(role),
					values: [modelLabel(role)],
					description: "Enter to pick an available model or inherit the parent's",
				},
				{
					id: "thinking",
					label: "Thinking",
					currentValue: thinkingLabel(role),
					values: ["inherit", ...THINKING_LEVELS],
					description: "Enter cycles the thinking level; inherit = parent session level",
				},
				{
					id: "tools",
					label: "Tools",
					currentValue: toolsLabel(role),
					values: [toolsLabel(role)],
					description: "Enter to choose the tool preset",
				},
				{
					id: "extensions",
					label: "Extensions",
					currentValue: extensionsLabel(role),
					values: [extensionsLabel(role)],
					description: "Enter to toggle ordinary discovery or individual extension sources",
				},
				{
					id: "prompt",
					label: "Prompt (Markdown)",
					currentValue: "edit",
					values: ["edit"],
					description: "Edit the role's Markdown body in Pi's editor; frontmatter is preserved",
				},
			],
			onActivate: (id, value) => {
				if (id !== "thinking") return true;
				save(ctx, name, { thinking: value === "inherit" ? null : value });
				return false;
			},
		});
		if (selected === undefined) return;
		if (selected === "model") {
			const picked = await pickModel(ctx, role);
			if (picked !== undefined) save(ctx, name, { model: picked });
		} else if (selected === "tools") {
			await editTools(pi, ctx, name);
		} else if (selected === "extensions") {
			await editExtensions(ctx, name);
		} else if (selected === "prompt") {
			const edited = await ctx.ui.editor(`Edit ${name} prompt (Markdown)`, role.prompt);
			if (edited === undefined) continue;
			try {
				updateRolePrompt(name, edited);
			} catch (error) {
				ctx.ui.notify(`Could not update ${name}: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
	}
}

/** `/config:subagent`: review and edit role presets in `skills/subagent/references/*.md`. */
export async function openSubagentConfigPanel(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify("/config:subagent requires the interactive TUI", "warning");
		return;
	}
	while (true) {
		let roles: Role[];
		try {
			roles = loadRoles();
		} catch (error) {
			ctx.ui.notify(`Could not load subagent roles: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const selected = await showPanel(ctx, {
			title: "Subagent roles",
			hint: "Presets are written back to skills/subagent/references/*.md",
			items: roles.map((role) => {
				const value = `${modelLabel(role)} · ${thinkingLabel(role)}`;
				return {
					id: role.name,
					label: role.name,
					currentValue: value,
					description: role.description,
					values: [value],
				};
			}),
		});
		if (selected === undefined) return;
		await editRole(pi, ctx, selected);
	}
}
