/** Text boundaries only. Output budgets apply to accepted replacements, never RAW or fallbacks. */
export type OutputLimitToolResult = {
  content: Array<{ type?: string; text?: string }>;
  details?: { [key: string]: unknown };
};

export function getTextContent(result: OutputLimitToolResult): string {
  return result.content
    .filter((content) => content.type === "text" && typeof content.text === "string")
    .map((content) => content.text ?? "")
    .join("\n");
}

export function hasNonTextContent(result: OutputLimitToolResult): boolean {
  return result.content.some((content) => content.type !== "text" || typeof content.text !== "string");
}
