/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * only after `agent_settled` has durably published the outcome. Explicitly
 * resident agents report each settled task without closing their surface.
 *
 * `ask_question` keeps the session OPEN: it writes a `${sessionFile}.ask`
 * signal the parent's watcher picks up, parks the session in a "waiting" state
 * (auto-exit is suppressed for that turn via `awaitingAnswer`), and the parent
 * replies with subagent_message — which lands as the subagent's next turn.
 */
import type { ExtensionAPI, ExtensionContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, writeFileSync } from "node:fs";
import { createSubagentActivityRecorder, LIVENESS_INTERVAL_MS, writeSubagentLiveness } from "./activity.ts";
import { writeSubagentOutcome } from "./outcome.ts";
import { createInboxReceiver } from "./inbox.ts";
import { writerFile } from "./runs.ts";

/**
 * Number of child subagents this session itself still has in flight.
 *
 * When this extension is loaded inside a subagent that can spawn its own
 * children (e.g. a worker delegating to scout/researcher), `index.ts` runs in
 * the same process and publishes a live count through a shared process-global
 * symbol. A subagent that spawns children and then writes a "waiting for
 * results" message would otherwise auto-exit the instant that turn ends —
 * killing the session before its children report back. Reading this count lets
 * `agent_settled` keep the session open until every child has finished and its
 * result has been delivered.
 *
 * Returns 0 when the spawning tools aren't loaded (scout/researcher, or a
 * standalone session), so those agents auto-exit exactly as before.
 */
function runningChildrenCount(): number {
  const fn = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
  if (typeof fn !== "function") return 0;
  try {
    const n = fn();
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT !== "0";
  const sessionFile = process.env.PI_SUBAGENT_SESSION;
  const executionId = process.env.PI_SUBAGENT_ID;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let sequence = 0;
  const inbox = sessionFile && executionId && existsSync(writerFile(sessionFile)) ? createInboxReceiver(pi, sessionFile, executionId) : undefined;
  let seenEntries = new Set<string>();
  let activityOutcome: "completed" | "aborted" | "error" = "completed";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  // Set when ask_question is called; suppresses auto-exit so the session stays
  // open while it waits for the orchestrator's reply. Cleared when the reply
  // lands on `input`, including a reply steered into the current run. Automatic
  // retries and recovery do not count as replies.
  let awaitingAnswer = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    inbox?.start(ctx);
    if (heartbeat) clearInterval(heartbeat);
    if (sessionFile && executionId) {
      writeSubagentLiveness(sessionFile, executionId);
      heartbeat = setInterval(() => {
        try { writeSubagentLiveness(sessionFile, executionId); }
        catch (error) { console.error("Subagent liveness publication failed:", error); }
      }, LIVENESS_INTERVAL_MS);
      heartbeat.unref?.();
    }
    seenEntries = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    if (ctx.hasUI) renderWidget(ctx, null);
  });

  pi.on("input", () => {
    if (inbox?.paused()) return { action: "handled" };
    inbox?.input();
    recorder.input();
    // A submitted message is the orchestrator's (or a human's) reply — the
    // pending ask_question has been answered, however it was delivered. Clear
    // here, not only on agent_start, because a reply steered in *mid-run* is
    // absorbed into the current run (pi's `steer` behavior injects it before
    // the next LLM call): no new agent_start fires, so without this the flag
    // would stay set and settlement would park the session as `waiting` even
    // though the answer already arrived and was consumed. (The `input` event
    // fires for mid-run steers because prompt() emits it before queueing.)
    awaitingAnswer = false;
  });

  pi.on("context", (event) => {
    if (inbox?.context(event.messages)) {
      recorder.input();
      awaitingAnswer = false;
    }
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    // Retries/recovery can start another run without any parent reply.
    inbox?.agentStart();
    recorder.agentStart();
  });

  pi.on("agent_end", () => {
    // A low-level run can still be followed by retry, recovery or queued work.
    recorder.agentEndWaiting();
  });

  pi.on("agent_before_settle", (event) => {
    // The final activity outcome is only supplied at this boundary. Observe it
    // here, but publish nothing until all boundary continuations have settled.
    activityOutcome = event.outcome;
    inbox?.beforeSettle();
  });

  function publishSettlement(ctx: ExtensionContext) {
    inbox?.settled(activityOutcome);
    if (inbox?.hasPending()) {
      recorder.agentEndWaiting();
      return;
    }
    const branch = ctx.sessionManager.getBranch();
    const fresh = branch.filter((entry) => !seenEntries.has(entry.id));
    const instruction = fresh.findLastIndex((entry) => entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user"));
    const entries = fresh.slice(instruction + 1).filter((entry) => entry.type === "message");
    // Never shut down while this session still has work in flight:
    //  - awaitingAnswer: an ask_question is pending the orchestrator's reply.
    //  - runningChildrenCount(): this subagent spawned its own children and is
    //    waiting for their results (delivered as steered turns). Exiting now
    //    would strand those children and drop their results.
    // In both cases the session parks as `waiting` and resumes when the next
    // turn lands.
    const hasPendingChildren = runningChildrenCount() > 0;
    if (awaitingAnswer || hasPendingChildren) {
      recorder.agentEndWaiting();
      return;
    }
    if (!sessionFile || !executionId) throw new Error("Missing managed subagent session or execution ID");
    const source = entries.findLast((entry) => entry.message.role === "assistant");
    const message = source?.message.role === "assistant" ? source.message : undefined;
    const text = (entry?: SessionMessageEntry): string => entry?.message.role === "assistant"
      ? entry.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";
    const finalOutput = text(source);
    const outcome = activityOutcome === "aborted" || message?.stopReason === "aborted" ? "aborted"
      : activityOutcome === "error" || message?.stopReason === "error" ? "failed"
      : message?.stopReason === "length" ? "truncated"
      : message?.stopReason === "toolUse" ? "failed"
      : !finalOutput.trim() ? "no-output" : "succeeded";
    // A terminal error often has no text of its own. Retain useful partial
    // responses from this task, never an earlier task's assistant response.
    const outputEntries = finalOutput.trim() ? [source!]
      : outcome === "failed" || outcome === "aborted" || outcome === "truncated"
        ? entries.filter((entry) => entry.message.role === "assistant" && text(entry).trim()) : [];
    const output = outputEntries.map(text).join("\n\n");
    const errorMessage = outcome === "failed" ? message?.errorMessage || "Final provider/agent error (no errorMessage supplied)."
      : outcome === "aborted" ? "Task was manually aborted."
      : outcome === "truncated" ? "Assistant output was truncated (stopReason=length)."
      : outcome === "no-output" ? "Settled without new assistant output." : undefined;
    writeSubagentOutcome({
      version: 1, executionId, sequence: sequence + 1,
      outcome, output, autoExit,
      ...(errorMessage ? { errorMessage } : {}),
      source: {
        kind: "agent_settled", sessionFile, sessionId: ctx.sessionManager.getSessionId(),
        entryId: source?.id ?? null, leafId: ctx.sessionManager.getLeafId(),
        stopReason: message?.stopReason ?? null,
        outputEntryIds: outputEntries.map((entry) => entry.id),
      },
    });
    sequence++;
    seenEntries = new Set(branch.map((entry) => entry.id));

    if (autoExit && outcome !== "aborted") {
      recorder.agentEndDone();
      inbox?.closing();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
  }
  pi.on("agent_settled", (_event, ctx) => {
    // Publication and the close decision share the sender's short lock. A
    // message either prevents auto-exit or sees a closing writer and waits for
    // positive exit before a single replacement is reserved.
    if (inbox) inbox.boundary(() => publishSettlement(ctx)); else publishSettlement(ctx);
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    inbox?.toolStart(event.toolCallId);
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    if (inbox?.paused()) return { block: true, reason: "This collaborator has an uncertain action; only explicit affected-action authorization/reconciliation releases it." };
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    inbox?.toolEnd(event.toolCallId);
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    inbox?.stop();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+Alt+O
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "ask_question",
    label: "ask_question",
    description:
      "Ask the orchestrator (the parent agent that spawned you) a single question and pause until they reply. " +
      "Use this when requirements are ambiguous, a decision would materially affect your work, you're blocked, " +
      "or you need information or confirmation only the orchestrator has. Prefer asking over guessing. " +
      "Your session stays open while you wait — the answer arrives as your next message, then you continue. " +
      "Ask exactly one question per call; make separate calls for unrelated questions.",
    promptSnippet:
      "Use this tool to ask the orchestrator one clarifying, missing-requirement, preference, or decision question before continuing — instead of guessing.",
    promptGuidelines: [
      "Ask exactly one question per tool call.",
      "If you need answers to multiple things, make separate ask_question calls instead of bundling them.",
      "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
      "Use it when multiple valid paths exist and the right one depends on the orchestrator's intent.",
      "Give enough context in the question that the orchestrator can answer without re-reading your whole task.",
      "After asking, stop and wait — the reply will arrive as your next message.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "The single freeform question to ask the orchestrator. Include enough context to answer it directly.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      // Keep the session open: suppress auto-exit for this turn and park in the
      // "waiting" phase. The parent's watcher picks up the `.ask` signal and
      // notifies the orchestrator, who replies via subagent_message.
      awaitingAnswer = true;
      recorder.askQuestion();
      const askData = {
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        agent: process.env.PI_SUBAGENT_AGENT ?? "",
        question: params.question,
      };
      writeFileSync(`${sessionFile}.ask`, JSON.stringify(askData));

      return {
        content: [
          {
            type: "text",
            text:
              "Question sent to the orchestrator. Stop here and wait — do not continue working or " +
              "assume an answer. Their reply will arrive as your next message.",
          },
        ],
        details: { question: params.question },
      };
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("ask_question ")) +
        theme.fg("muted", String((args as any).question ?? ""));
      return new Text(text, 0, 0);
    },
  });

}
