import type { Message } from "@earendil-works/pi-ai";
import { ADVISOR_TOOL_NAME, messages } from "./messages.ts";

export function stripInflightAdvisorCall(input: Message[]): Message[] {
	if (input.length === 0) return input;
	const last = input[input.length - 1];
	if (last.role !== "assistant") return input;
	const filtered = last.content.filter((part) => !(part.type === "toolCall" && part.name === ADVISOR_TOOL_NAME));
	if (filtered.length === last.content.length) return input;
	if (filtered.length === 0) return input.slice(0, -1);
	return [...input.slice(0, -1), { ...last, content: filtered }];
}

export function ensureUserTailForAdvisor(input: Message[]): Message[] {
	if (input.length === 0 || input[input.length - 1].role !== "assistant") return input;
	return [
		...input,
		{
			role: "user",
			content: [{ type: "text", text: messages.advisorNudge() }],
			timestamp: Date.now(),
		},
	];
}
