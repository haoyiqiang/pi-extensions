import {
  createAssistantMessageEventStream,
  createProvider,
  getCurrentTools,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TERMINAL_FAUX_PROVIDER = "terminal-faux";
export const TERMINAL_FAUX_MODEL_ID = "terminal-faux-1";

const TERMINAL_FAUX_API = "terminal-faux-api";
const SLOW_MARKER = "[[terminal-faux:slow]]";
const SLOW_DELAY_MS = 30_000;

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
  return {
    users,
    assistants,
    tools: getCurrentTools(context.messages).map((tool) => tool.name).sort(),
    slow: users.at(-1)?.includes(SLOW_MARKER) === true,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function usePayload(value: unknown, fallback: ScriptPayload): ScriptPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fallback;
  const candidate = value as Partial<ScriptPayload>;
  return {
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

        const text = responseText(payload);
        partial = { ...partial, usage: usageFor(payload, text) };
        stream.push({ type: "start", partial });
        partial.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: 0, partial });

        if (payload.slow) await wait(SLOW_DELAY_MS, options?.signal);

        const textBlock = partial.content[0];
        if (!textBlock || textBlock.type !== "text") throw new Error("terminal faux text block missing");
        for (let offset = 0; offset < text.length; offset += 19) {
          options?.signal?.throwIfAborted();
          const delta = text.slice(offset, offset + 19);
          textBlock.text += delta;
          stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
          await Promise.resolve();
        }
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial });

        const message: AssistantMessage = { ...partial, stopReason: "stop" };
        stream.push({ type: "done", reason: "stop", message });
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
