/**
 * Test helper for the OM agent system-prompt carrier.
 *
 * Pi 0.87 removed `AgentContext.systemPrompt`; the prompt now travels as the
 * leading transcript `system` message (Pi 0.87's `createInitialSystemMessage`).
 * Reading it here keeps these tests honest on the 0.87 devDependency — a
 * regression back to the legacy field alone reads as an empty prompt.
 * See https://github.com/k0valik/pi-blackhole/issues/118.
 */
export function leadingSystemPrompt(context: {
  messages?: ReadonlyArray<{ role?: unknown; content?: unknown }>;
}): string {
  const first = context.messages?.[0];
  if (first?.role !== "system" || typeof first.content !== "string") return "";
  return first.content;
}
