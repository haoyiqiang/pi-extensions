import {
  createAssistantMessageEventStream,
  createProvider,
  getCurrentTools,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TERMINAL_FAUX_PROVIDER = "terminal-faux";
export const TERMINAL_FAUX_MODEL_ID = "terminal-faux-1";

export const TERMINAL_FAUX_MARKERS = {
  slow: "[[terminal-faux:slow]]",
  structured: "[[terminal-faux:structured-valid]]",
  recover: "[[terminal-faux:structured-recover]]",
  missing: "[[terminal-faux:structured-missing]]",
  invalidThenValid: "[[terminal-faux:structured-invalid-then-valid]]",
  invalid: "[[terminal-faux:structured-invalid]]",
  endless: "[[terminal-faux:endless]]",
  wrapUp: "[[terminal-faux:wrap-up]]",
  retryEndless: "[[terminal-faux:structured-retry-endless]]",
} as const;
export const TERMINAL_FAUX_JSON_PREFIX = "terminal-faux-json=";
export const TERMINAL_FAUX_REQUEST_ACTIVE = "terminal-faux request active\n";

const TERMINAL_FAUX_API = "terminal-faux-api";
const SLOW_DELAY_MS = 30_000;
const SCRIPT_TURN_SAFETY_LIMIT = 24;
const STRUCTURED_TOOL = "StructuredOutput";

const model: Model<typeof TERMINAL_FAUX_API> = {
  id: TERMINAL_FAUX_MODEL_ID,
  name: "Terminal Faux Model",
  api: TERMINAL_FAUX_API,
  provider: TERMINAL_FAUX_PROVIDER,
  baseUrl: "faux://offline",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

interface ScriptPayload {
  users: string[];
  assistants: string[];
  tools: string[];
  slow: boolean;
  prompt: string;
  completedTurns: number;
  continuations: number;
  structuredResults: Array<{ isError: boolean }>;
}

function messageText(message: TranscriptContext["messages"][number]): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "toolCall") return `${block.name}:${JSON.stringify(block.arguments)}`;
      if (block.type === "image") return `[image:${block.mimeType}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function scriptPayload(context: TranscriptContext): ScriptPayload {
  const users = context.messages.filter((message) => message.role === "user").map(messageText);
  const assistants = context.messages.filter((message) => message.role === "assistant").map(messageText);
  // Custom continuation messages become user-role model input. Find the explicit
  // script marker, not the last user message or an English retry/wrap-up prompt.
  const promptIndex = context.messages.reduce((last, message, index) =>
    message.role === "user" && Object.values(TERMINAL_FAUX_MARKERS).some((marker) => messageText(message).includes(marker))
      ? index : last,
  -1);
  const invocation = context.messages.slice(promptIndex + 1);
  const prompt = promptIndex >= 0 ? messageText(context.messages[promptIndex]) : "";
  return {
    users,
    assistants,
    tools: getCurrentTools(context.messages).map((tool) => tool.name).sort(),
    slow: prompt.includes(TERMINAL_FAUX_MARKERS.slow),
    prompt,
    completedTurns: invocation.filter((message) => message.role === "assistant").length,
    continuations: invocation.filter((message) => message.role === "user").length,
    structuredResults: invocation.flatMap((message) =>
      message.role === "toolResult" && message.toolName === STRUCTURED_TOOL ? [{ isError: message.isError }] : [],
    ),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function usePayload(value: unknown, fallback: ScriptPayload): ScriptPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fallback;
  const candidate = value as Partial<ScriptPayload>;
  return {
    ...fallback,
    users: isStringArray(candidate.users) ? candidate.users : fallback.users,
    assistants: isStringArray(candidate.assistants) ? candidate.assistants : fallback.assistants,
    tools: isStringArray(candidate.tools) ? candidate.tools : fallback.tools,
    slow: typeof candidate.slow === "boolean" ? candidate.slow : fallback.slow,
  };
}

function responseText(payload: ScriptPayload): string {
  return [
    `terminal-faux turn ${payload.assistants.length + 1}`,
    `users=${JSON.stringify(payload.users)}`,
    `assistant_history=${JSON.stringify(payload.assistants)}`,
    `tools=${JSON.stringify(payload.tools)}`,
  ].join("\n");
}

function scriptedToolCall(payload: ScriptPayload): ToolCall | undefined {
  const has = (marker: string) => payload.prompt.includes(marker);
  if (!payload.prompt || has(TERMINAL_FAUX_MARKERS.slow)) return undefined;
  if (payload.completedTurns >= SCRIPT_TURN_SAFETY_LIMIT) {
    throw new Error("Terminal faux script exceeded its safety turn bound");
  }
  const call = (name: string, args: ToolCall["arguments"]): ToolCall => {
    if (!payload.tools.includes(name)) throw new Error(`Terminal faux script requires active tool ${name}`);
    return { type: "toolCall", id: `terminal-faux-call-${payload.assistants.length + 1}`, name, arguments: args };
  };
  if (has(TERMINAL_FAUX_MARKERS.endless)
    || (has(TERMINAL_FAUX_MARKERS.wrapUp) && payload.continuations === 0)
    || (has(TERMINAL_FAUX_MARKERS.retryEndless) && payload.completedTurns > 0)) {
    return call("ls", { path: ".", limit: 1 });
  }
  if (has(TERMINAL_FAUX_MARKERS.missing) || has(TERMINAL_FAUX_MARKERS.retryEndless)
    || has(TERMINAL_FAUX_MARKERS.wrapUp)) return undefined;
  if (payload.structuredResults.some((result) => !result.isError)) return undefined;
  if (has(TERMINAL_FAUX_MARKERS.recover) && payload.completedTurns === 0) return undefined;
  if (has(TERMINAL_FAUX_MARKERS.invalid)) {
    // One rejected call per natural run, then prose; the second rejected call
    // must be caused by the child's sole agent_before_settle continuation.
    if (payload.structuredResults.length > payload.continuations) return undefined;
    return call(STRUCTURED_TOOL, { file: 42, line: 0 });
  }
  if (has(TERMINAL_FAUX_MARKERS.invalidThenValid) && payload.structuredResults.length === 0) {
    return call(STRUCTURED_TOOL, { file: 42, line: 0 });
  }
  const json = payload.prompt.split("\n").find((line) => line.startsWith(TERMINAL_FAUX_JSON_PREFIX));
  const args = json ? JSON.parse(json.slice(TERMINAL_FAUX_JSON_PREFIX.length)) : { file: "fixture.ts", line: 3 };
  return call(STRUCTURED_TOOL, args);
}

function usageFor(payload: ScriptPayload, text: string): AssistantMessage["usage"] {
  const input = Math.max(1, Math.ceil(
    [...payload.users, ...payload.assistants].reduce((sum, entry) => sum + entry.length, 0) / 4,
  ));
  const output = Math.max(1, Math.ceil(text.length / 4));
  const cacheRead = payload.assistants.length;
  const cacheWrite = payload.users.length;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function wait(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function streamScriptedResponse(
  requestModel: Model<typeof TERMINAL_FAUX_API>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    void (async () => {
      const initialPayload = scriptPayload(context);
      let payload = initialPayload;
      let partial: AssistantMessage = {
        role: "assistant",
        content: [],
        api: requestModel.api,
        provider: requestModel.provider,
        model: requestModel.id,
        usage: usageFor(initialPayload, ""),
        stopReason: "pending",
        timestamp: Date.now(),
      };

      try {
        const replacedPayload = await options?.onPayload?.(initialPayload, requestModel);
        payload = usePayload(replacedPayload, initialPayload);
        await options?.onResponse?.({ status: 200, headers: { "x-terminal-faux": "offline" } }, requestModel);
        options?.signal?.throwIfAborted();

        const toolCall = scriptedToolCall(payload);
        const text = payload.prompt && !payload.slow
          ? `terminal-faux scripted turn ${payload.completedTurns + 1}; tools=${JSON.stringify(payload.tools)}`
          : `${payload.slow ? TERMINAL_FAUX_REQUEST_ACTIVE : ""}${responseText(payload)}`;
        partial = { ...partial, usage: usageFor(payload, toolCall ? JSON.stringify(toolCall.arguments) : text) };
        stream.push({ type: "start", partial });
        if (toolCall) {
          const block: ToolCall = { ...toolCall, arguments: {} };
          partial.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial });
          block.arguments = toolCall.arguments;
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(block.arguments), partial });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial });
        } else {
          const textBlock = { type: "text" as const, text: "" };
          partial.content.push(textBlock);
          stream.push({ type: "text_start", contentIndex: 0, partial });
          if (payload.slow) {
            // A real streamed delta proves the request is active before a test
            // cancels it; no timing guesses or polling a child's startup file.
            textBlock.text = TERMINAL_FAUX_REQUEST_ACTIVE;
            stream.push({ type: "text_delta", contentIndex: 0, delta: textBlock.text, partial });
            await wait(SLOW_DELAY_MS, options?.signal);
          }
          for (let offset = textBlock.text.length; offset < text.length; offset += 19) {
            options?.signal?.throwIfAborted();
            const delta = text.slice(offset, offset + 19);
            textBlock.text += delta;
            stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
            await Promise.resolve();
          }
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
        }

        const reason = toolCall ? "toolUse" : "stop";
        const message: AssistantMessage = { ...partial, stopReason: reason };
        stream.push({ type: "done", reason, message });
        stream.end(message);
      } catch (error) {
        const aborted = options?.signal?.aborted === true;
        const message: AssistantMessage = {
          ...partial,
          stopReason: aborted ? "aborted" : "error",
          errorMessage: aborted
            ? "Terminal faux request aborted"
            : error instanceof Error ? error.message : String(error),
        };
        stream.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error: message,
        });
        stream.end(message);
      }
    })();
  });
  return stream;
}

const provider = createProvider({
  id: TERMINAL_FAUX_PROVIDER,
  name: "Terminal Faux Provider",
  auth: {
    apiKey: {
      name: "Offline fixture",
      check: async () => ({ type: "api_key", source: "offline fixture" }),
      resolve: async () => ({ auth: {}, source: "offline fixture" }),
    },
  },
  models: [model],
  api: {
    stream: streamScriptedResponse,
    streamSimple: streamScriptedResponse,
  },
});

export default function terminalFauxProvider(pi: ExtensionAPI): void {
  pi.registerProvider(provider);
}
