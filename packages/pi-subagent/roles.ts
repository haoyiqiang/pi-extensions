import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const rolesDir = join(dirname(fileURLToPath(import.meta.url)), "skills", "subagent", "references");

export interface Role {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	extensions?: boolean | string[];
	prompt: string;
}

export function resolveExtensionSource(source: string, baseDir: string): string {
	if (/^(npm:|git:|github:|https?:|ssh:)/.test(source)) return source;
	if (source.startsWith("file://")) return fileURLToPath(source);
	if (source === "~") return homedir();
	if (source.startsWith("~/")) return resolve(homedir(), source.slice(2));
	return resolve(baseDir, source);
}

function stringList(value: unknown, field: string, path: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim()))
		throw new Error(`Role ${field} must be an array of non-empty strings: ${path}`);
	return value.map((item: string) => item.trim());
}

export function loadRoles(directory = rolesDir): Role[] {
	const roles = readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry): Role => {
			const path = join(directory, entry.name);
			const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
			const { name, description, model, thinking } = frontmatter;
			if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(name) ||
				typeof description !== "string" || !description.trim())
				throw new Error(`Role file requires a lowercase name and description: ${path}`);
			if (!body.trim()) throw new Error(`Role prompt is empty: ${path}`);
			if (model !== undefined && (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model)))
				throw new Error(`Role model must use provider/model: ${path}`);
			if (thinking !== undefined && (typeof thinking !== "string" || !THINKING_LEVELS.includes(thinking as typeof THINKING_LEVELS[number])))
				throw new Error(`Invalid role thinking level: ${path}`);
			const tools = stringList(frontmatter.tools, "tools", path);
			const extensions = typeof frontmatter.extensions === "boolean"
				? frontmatter.extensions
				: stringList(frontmatter.extensions, "extensions", path)?.map((source) => resolveExtensionSource(source, dirname(path)));
			return { name, description: description.trim(), model: model as string | undefined,
				thinking: thinking as string | undefined, tools, extensions, prompt: body };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	if (new Set(roles.map((role) => role.name)).size !== roles.length)
		throw new Error(`Duplicate role names in ${directory}`);
	return roles;
}

export interface RuntimeOptions {
	provider?: string;
	model?: string;
	thinking?: string;
	tools?: string;
	noTools?: boolean;
	noExtensions?: boolean;
	/** Undefined means no extension CLI option was supplied; [] is an explicit selection. */
	extensions?: string[];
}

/** Resolve presets only after parsing CLI, so inherited environment values cannot override a role. */
export function resolveRuntimeOptions(
	cli: RuntimeOptions,
	role: Role | undefined,
	defaults: Pick<RuntimeOptions, "provider" | "model" | "thinking">,
): RuntimeOptions {
	let provider = defaults.provider;
	let model = defaults.model;
	if (role?.model) {
		const slash = role.model.indexOf("/");
		provider = role.model.slice(0, slash);
		model = role.model.slice(slash + 1);
	}
	if (cli.model !== undefined) {
		const slash = cli.model.indexOf("/");
		if (slash >= 0) {
			provider = cli.model.slice(0, slash);
			model = cli.model.slice(slash + 1);
		} else {
			// Legacy bare model IDs keep the parent's provider unless explicitly supplied.
			provider = cli.provider ?? defaults.provider ?? provider;
			model = cli.model;
		}
	}
	if (cli.provider !== undefined) provider = cli.provider;
	const toolsFromCli = cli.tools !== undefined || cli.noTools === true;
	const extensionsFromCli = cli.extensions !== undefined || cli.noExtensions === true;
	return {
		provider,
		model,
		thinking: cli.thinking ?? role?.thinking ?? defaults.thinking ?? "medium",
		tools: toolsFromCli ? cli.tools : role?.tools?.length ? role.tools.join(",") : undefined,
		noTools: toolsFromCli ? cli.noTools === true : role?.tools?.length === 0,
		noExtensions: extensionsFromCli ? cli.noExtensions === true : role?.extensions === false || Array.isArray(role?.extensions),
		extensions: extensionsFromCli ? cli.extensions ?? [] : Array.isArray(role?.extensions) ? role.extensions : [],
	};
}

export function formatRoleCatalog(roles: Role[]): string {
	if (roles.length === 0) return "";
	const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return [
		"<available_subagent_roles>",
		"Read and follow the subagent skill before delegating work. Select a role below when its description matches the task; otherwise delegate without a role.",
		...roles.map((role) => `- ${escape(role.name)}: ${escape(role.description.replace(/\s+/g, " "))}`),
		"</available_subagent_roles>",
	].join("\n");
}
