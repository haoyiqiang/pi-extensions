import { messages } from "./messages.ts";

export function getAdvisorSystemPrompt(): string {
	return messages.systemPrompt();
}
