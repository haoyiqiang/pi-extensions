import type { AgentSession, AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { extractText } from "../context.js";
import { i18n } from "../i18n.js";
import { createStructuredCapture, createStructuredOutputTool, structuredFailure, structuredRetryPrompt,
  type StructuredCapture } from "../structured-output.js";
import type { CompiledSchema } from "../workflow/json-schema.js";
import type { RunOptions } from "./embedded.js";
import { compileInvocationSchema, validTurnBudget } from "./invocation-policy.js";

type Message = AgentSession["messages"][number];
export type EmbeddedInvocationOptions = Pick<RunOptions,
  "signal" | "onToolActivity" | "onAssistantUsage" | "onCompaction" | "onTextDelta" | "onTurnEnd">;
export interface EmbeddedInvocationResult {
  text: string;
  aborted: boolean;
  steered: boolean;
  failure?: string;
  structuredJson?: string;
  structuredRetried?: boolean;
}
interface Invocation {
  finished: boolean;
  stopping: boolean;
  hardLimit: boolean;
  capture?: StructuredCapture;
  tool?: ToolDefinition;
  onToolActivity?: EmbeddedInvocationOptions["onToolActivity"];
}
export interface EmbeddedInvocationPolicy {
  readonly maxTurns?: number;
  readonly graceTurns?: number;
  readonly schema?: CompiledSchema;
  active?: Invocation;
}
const policies = new WeakMap<AgentSession, EmbeddedInvocationPolicy>();

export function createEmbeddedInvocationPolicy(options: {
  maxTurns?: number; graceTurns?: number; structuredOutput?: CompiledSchema;
}): EmbeddedInvocationPolicy {
  if (!validTurnBudget(options.maxTurns, options.graceTurns)) throw new Error(i18n.t("invocation.invalidBudget"));
  let schema: CompiledSchema | undefined;
  if (options.structuredOutput !== undefined) {
    if (!options.structuredOutput || typeof options.structuredOutput.check !== "function") throw new Error(i18n.t("invocation.invalidValidator"));
    const snapshot = compileInvocationSchema(options.structuredOutput.schema);
    const check = options.structuredOutput.check.bind(options.structuredOutput);
    schema = { schema: snapshot.schema, check: (value) => {
      const verdict = snapshot.check(value);
      return verdict === true ? check(value) : verdict;
    } };
  }
  return { maxTurns: options.maxTurns, graceTurns: options.graceTurns, schema };
}

/** Stable SDK tool identity dispatches only to the current invocation's fresh capture. */
export function embeddedStructuredTools(policy: EmbeddedInvocationPolicy): ToolDefinition[] {
  if (!policy.schema) return [];
  const definition = createStructuredOutputTool(policy.schema, createStructuredCapture());
  return [{ ...definition, execute: async (id, params, signal, onUpdate, ctx) => {
    const active = policy.active;
    if (!active?.tool || active.finished || active.stopping || signal?.aborted) throw new Error(i18n.t("invocation.notRunning"));
    return active.tool.execute(id, params, signal, onUpdate, ctx);
  } }];
}

export function rememberEmbeddedPolicy(session: AgentSession, policy: EmbeddedInvocationPolicy): void {
  policies.set(session, policy);
}

const safely = (callback: (() => void) | undefined) => { try { callback?.(); } catch { /* observation must not disable policy */ } };

export function observeEmbeddedActivity(policy: EmbeddedInvocationPolicy,
  activity: Parameters<NonNullable<EmbeddedInvocationOptions["onToolActivity"]>>[0],
  startupObserver?: EmbeddedInvocationOptions["onToolActivity"],
): void {
  const active = policy.active;
  const observer = active && !active.finished ? active.onToolActivity : startupObserver;
  safely(() => observer?.(activity));
}

function lastAssistant(session: AgentSession, start: number): Message | undefined {
  for (let index = session.messages.length - 1; index >= start; index--) {
    const message = session.messages[index];
    if (message.role === "assistant") return message;
  }
  return undefined;
}
function assistantText(message: Message | undefined): string {
  if (message?.role !== "assistant") return "";
  const content: unknown = message.content;
  return typeof content === "string" ? content.trim()
    : Array.isArray(content) ? extractText(content).trim() : "";
}
function lastAssistantText(session: AgentSession, start: number): string {
  for (let index = session.messages.length - 1; index >= start; index--) {
    const text = assistantText(session.messages[index]);
    if (text) return text;
  }
  return "";
}
function failureOf(message: Message | undefined): string | undefined {
  if (message?.role !== "assistant") return undefined;
  if (message.stopReason === "error") return message.errorMessage?.trim() || i18n.t("invocation.providerError");
  if (message.stopReason === "length" && !assistantText(message)) return i18n.t("invocation.outputLimit");
  return undefined;
}

/** The invocation lock covers prompts, the one schema retry and abort draining. */
export async function invokeEmbeddedSession(
  session: AgentSession, prompt: string, options: EmbeddedInvocationOptions = {}, onStarted?: () => void,
): Promise<EmbeddedInvocationResult> {
  let policy = policies.get(session);
  // The legacy facade also accepts sessions not created by runAgent. Do not infer a policy for them.
  if (!policy) { policy = {}; policies.set(session, policy); }
  if (policy.active || session.isStreaming) throw new Error(i18n.t("invocation.busy"));
  const capture = policy.schema ? createStructuredCapture() : undefined;
  const active: Invocation = { finished: false, stopping: false, hardLimit: false, capture, onToolActivity: options.onToolActivity,
    tool: policy.schema && capture ? createStructuredOutputTool(policy.schema, capture) : undefined };
  policy.active = active;
  const controls: Promise<void>[] = [];
  const nativeSignals = new Set<AbortSignal>();
  const onNativeAbort = () => { active.stopping = true; };
  const trackNativeSignal = () => {
    const signal = session.agent?.signal;
    if (!signal || nativeSignals.has(signal)) return;
    nativeSignals.add(signal);
    signal.addEventListener("abort", onNativeAbort, { once: true });
    if (signal.aborted) onNativeAbort();
  };
  let unsubscribe: (() => void) | undefined;
  let turnCount = 0;
  let steered = false;
  let retried = false;
  let text = "";
  let lastNonempty = "";
  let observed: Message | undefined;
  let sawAssistant = false;
  let controlFailure: string | undefined;
  let start = 0;
  const stopSession = () => {
    try { controls.push(Promise.resolve(session.abort()).catch(() => {})); } catch { /* best effort; prompt still owns settlement */ }
  };
  const abort = () => {
    if (active.stopping) return;
    active.stopping = true;
    stopSession();
  };
  const finalMessage = () => observed ?? lastAssistant(session, start);
  const aborted = () => active.stopping || options.signal?.aborted === true
    || (finalMessage()?.role === "assistant" && (finalMessage() as { stopReason?: string }).stopReason === "aborted");

  try {
    start = session.messages.length;
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      // Pi resets its abort flag after asynchronous prompt preflight. Reassert a latched cancellation.
      if (event.type === "agent_start") {
        trackNativeSignal();
        if (active.stopping) stopSession();
      }
      if (event.type === "turn_end" && !active.hardLimit) {
        turnCount++;
        const limit = policy.maxTurns;
        if (limit !== undefined && !active.stopping) {
          if (turnCount >= limit + policy.graceTurns!) {
            active.hardLimit = true;
            abort();
          } else if (!steered && turnCount >= limit && !failureOf(finalMessage()) && !aborted()) {
            steered = true;
            const failed = () => { controlFailure = i18n.t("invocation.wrapUpFailed"); abort(); };
            // Internal policy is not interactive input: bypass asynchronous input/command expansion.
            try { controls.push(Promise.resolve(session.sendCustomMessage({
              customType: "pi-subagents-policy", content: i18n.t("terminalPolicy.wrapUp"), display: false,
            }, { deliverAs: "steer" })).catch(failed)); }
            catch { failed(); }
          }
        }
        safely(() => options.onTurnEnd?.(turnCount));
      }
      if (event.type === "message_start" && event.message.role === "assistant") {
        text = ""; observed = undefined; sawAssistant = true;
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        text += delta;
        if (text.trim()) lastNonempty = text.trim();
        safely(() => options.onTextDelta?.(delta, text));
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        // Legacy subscribers/tests can emit usage-only records, not complete transcript messages.
        if (event.message.content !== undefined) {
          observed = event.message; sawAssistant = true;
          text = assistantText(event.message);
          if (text) lastNonempty = text;
        }
        const u = event.message.usage;
        if (u) safely(() => options.onAssistantUsage?.({ input: u.input ?? 0, output: u.output ?? 0,
          cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: u.cost?.total ?? 0 }));
      }
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        safely(() => options.onToolActivity?.({ type: event.type === "tool_execution_start" ? "start" : "end", toolName: event.toolName }));
      }
      if (event.type === "compaction_end" && !event.aborted && event.result) {
        safely(() => options.onCompaction?.({ reason: event.reason, tokensBefore: event.result!.tokensBefore }));
      }
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    onStarted?.();
    if (options.signal?.aborted) active.stopping = true;
    if (!active.stopping) await session.prompt(prompt);
    // A prompt resolves at SDK settlement, so this cannot race a still-streaming invocation.
    if (capture && capture.json === undefined && !aborted() && !failureOf(finalMessage()) && !controlFailure) {
      retried = true;
      await session.prompt(structuredRetryPrompt(capture));
    }
  } finally {
    active.finished = true;
    options.signal?.removeEventListener("abort", abort);
    for (const signal of nativeSignals) signal.removeEventListener("abort", onNativeAbort);
    try { unsubscribe?.(); } finally {
      try {
        // A rejected delayed steer can append an abort operation while draining.
        for (let index = 0; index < controls.length; index++) await controls[index];
      } finally { policy.active = undefined; }
    }
  }

  // Event tracking survives compaction; an index fallback exists only for legacy partial session doubles.
  const resultText = text.trim() || lastNonempty || (!sawAssistant ? lastAssistantText(session, start) : "");
  const wasAborted = aborted();
  return {
    text: resultText,
    aborted: wasAborted, steered,
    failure: controlFailure ?? (active.hardLimit ? i18n.t("terminalPolicy.turnLimit") : failureOf(finalMessage()))
      ?? (!wasAborted && capture ? structuredFailure(capture) : undefined),
    ...(capture?.json !== undefined ? { structuredJson: capture.json } : {}),
    ...(retried ? { structuredRetried: true } : {}),
  };
}
