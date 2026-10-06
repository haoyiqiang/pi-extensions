import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { i18n } from "../i18n.js";

type AgentSessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];
type WatchableSession = Pick<AgentSession, "subscribe" | "abort">;

const DEFAULT_BASH_TOOL_TIMEOUT_MS = 180_000;
const MIN_BASH_TOOL_TIMEOUT_MS = 5_000;
const MAX_BASH_TOOL_TIMEOUT_MS = 30 * 60_000;
const SNIPPET_MAX_LENGTH = 120;

export const STANDARD_BASH_TOOL_TIMEOUT_MS = resolveStandardBashTimeoutMs(
  process.env.RPIV_BASH_TIMEOUT_MS,
);

export function resolveStandardBashTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BASH_TOOL_TIMEOUT_MS;
  return Math.min(Math.max(parsed, MIN_BASH_TOOL_TIMEOUT_MS), MAX_BASH_TOOL_TIMEOUT_MS);
}

function timeoutReason(command: string, timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  const snippet = command.length > SNIPPET_MAX_LENGTH
    ? `${command.slice(0, SNIPPET_MAX_LENGTH - 3)}...`
    : command;
  return i18n.t("workflowExecution.bashTimeout", { seconds, command: snippet ? `: \`${snippet}\`` : "" });
}

export interface StandardBashWatchdog {
  timedOut(): { reason: string } | undefined;
  reset(): void;
  dispose(): void;
}

/** Per-command watchdog; the first concurrent bash overrun owns the verdict. */
export function armStandardBashWatchdog(
  session: WatchableSession,
  onAbortFailure: (error: unknown) => void,
  timeoutMs: number = STANDARD_BASH_TOOL_TIMEOUT_MS,
): StandardBashWatchdog {
  let fired: { reason: string } | undefined;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const clear = (id: string): void => {
    const timer = timers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(id);
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "tool_execution_start" && event.toolName === "bash") {
      const id = event.toolCallId;
      const command = typeof event.args?.command === "string" ? event.args.command : "";
      const timer = setTimeout(() => {
        timers.delete(id);
        if (fired) return;
        fired = { reason: timeoutReason(command, timeoutMs) };
        void session.abort().catch(onAbortFailure);
      }, timeoutMs);
      timer.unref?.();
      timers.set(id, timer);
    } else if (event.type === "tool_execution_end") {
      clear(event.toolCallId);
    }
  });

  const clearTimers = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  return {
    timedOut: () => fired,
    reset: () => {
      fired = undefined;
      clearTimers();
    },
    dispose: () => {
      unsubscribe();
      clearTimers();
    },
  };
}
