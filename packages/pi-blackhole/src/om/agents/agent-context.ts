/**
 * Cross-version `AgentContext` builder for the OM agent loops.
 *
 * Pi 0.85/0.86 put the system prompt on `AgentContext.systemPrompt` and their
 * agent loop forwards it to the provider as `Context.systemPrompt`; a
 * `system`-role entry in `messages` is ignored there. Pi 0.87 removed the field
 * and carries the prompt as a leading transcript system message instead.
 * Emitting the wrong carrier silently drops the system prompt, so the observer,
 * reflector, and dropper must not hardcode either one. The host's carrier is
 * probed by capability (`createInitialSystemMessage`, added in 0.87), never by
 * version, so this keeps working without an allowlist.
 *
 * See https://github.com/k0valik/pi-blackhole/issues/118.
 */
import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import type { SystemMessage, Tool } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";

/** The pi-ai transcript helpers that exist from Pi 0.87 on. */
interface TranscriptSupport {
  createInitialSystemMessage: (
    systemPrompt: string | undefined,
    tools: Tool[] | undefined,
  ) => SystemMessage | undefined;
  toToolDeclaration: (tool: Tool) => Tool;
}

const hostTranscript = piAi as TranscriptSupport;

/**
 * True when the host carries the system prompt as a leading transcript system
 * message (Pi 0.87+) instead of `AgentContext.systemPrompt` (Pi <= 0.86).
 */
export function supportsTranscriptSystemMessages(): boolean {
  return (
    typeof (piAi as { createInitialSystemMessage?: unknown }).createInitialSystemMessage ===
    "function"
  );
}

/** Context for hosts that read `AgentContext.systemPrompt` (Pi <= 0.86). */
export function buildLegacyAgentContext(
  systemPrompt: string,
  tools: AgentTool<any>[],
): AgentContext {
  // `systemPrompt` is absent from the 0.87 `AgentContext` type but required by
  // older hosts; the extra field is ignored by 0.87's agent loop.
  const context: AgentContext & { systemPrompt?: string } = { systemPrompt, messages: [], tools };
  return context;
}

/** Context for hosts that read a leading transcript system message (Pi 0.87+). */
export function buildTranscriptAgentContext(
  systemPrompt: string,
  tools: AgentTool<any>[],
): AgentContext {
  const declarations = tools.map((tool) => hostTranscript.toToolDeclaration(tool));
  const initial = hostTranscript.createInitialSystemMessage(systemPrompt, declarations);
  return { messages: initial ? [initial] : [], tools };
}

/** Build the `AgentContext` the loaded host understands. */
export function buildAgentContext(systemPrompt: string, tools: AgentTool<any>[]): AgentContext {
  return supportsTranscriptSystemMessages()
    ? buildTranscriptAgentContext(systemPrompt, tools)
    : buildLegacyAgentContext(systemPrompt, tools);
}
