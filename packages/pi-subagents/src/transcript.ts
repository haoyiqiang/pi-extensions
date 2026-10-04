import type { SessionView, TranscriptBlock } from "./backends/session.js";
import { extractText } from "./context.js";

/** Existing upstream conversation formatting, independent of the execution implementation. */
export function getAgentConversation(session: Pick<SessionView, "messages">): string {
  const parts: string[] = [];
  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content ?? []);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      const content: readonly TranscriptBlock[] = typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : msg.content ?? [];
      for (const c of content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${c.name ?? c.toolName ?? "unknown"}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content ?? []);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }
  return parts.join("\n\n");
}
