import type { Message } from "@earendil-works/pi-ai";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { messages } from "./messages.ts";

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : stableStringify(item)).join(",")}]`;
	const entries: string[] = [];
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		const item = (value as Record<string, unknown>)[key];
		if (item !== undefined) entries.push(`${JSON.stringify(key)}:${stableStringify(item)}`);
	}
	return `{${entries.join(",")}}`;
}

function inventoryBody(tools: ToolInfo[]): string {
	return tools
		.map((tool) => `### ${tool.name}\n${tool.description}\n\n${messages.parametersLabel()}: ${stableStringify(tool.parameters)}`)
		.join("\n\n---\n\n");
}

export function getInventoryMessage(tools: ToolInfo[]): Message | undefined {
	if (tools.length === 0) return undefined;
	const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
	const message: Message = {
		role: "user",
		content: [{ type: "text", text: `## ${messages.inventoryHeader()}\n\n${inventoryBody(sorted)}` }],
		timestamp: Date.now(),
	};
	return message;
}
