/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * only after `agent_settled` has durably published the outcome. Explicitly
 * resident agents report each settled task without closing their surface.
 *
 * Questions remain in the durable inbox until an explicitly correlated reply
 * is persisted and observed by this child. Ordinary input is never an answer.
 */
import type { ExtensionAPI, ExtensionContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { createSubagentActivityRecorder, LIVENESS_INTERVAL_MS, writeSubagentLiveness } from "./activity.ts";
import { readSubagentOutcomes, writeSubagentOutcome } from "./outcome.ts";
import { createInboxReceiver, SubagentInbox } from "./inbox.ts";
import { SubagentRuns, writerFile, readControl, replace, checkpointFile, type SubagentControl, type SubagentCheckpoint } from "./runs.ts";
import { SubagentNotifications } from "./notifications.ts";
import { summarizeEntryUsage } from "./session.ts";

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
  let controlTimer: ReturnType<typeof setInterval> | undefined;
  let controlling: SubagentControl | undefined;
  let controlFinished = false;
  let active = false;
  let preparing = false;
  const activeTools = new Set<string>();
  let interruptedTools: string[] = [];
  let sequence = 0;
  let descendants: SubagentNotifications | undefined;
  const mailbox = sessionFile ? new SubagentInbox(sessionFile) : undefined;
  const inbox = sessionFile && executionId && existsSync(writerFile(sessionFile)) ? createInboxReceiver(pi, sessionFile, executionId) : undefined;
  let seenEntries = new Set<string>();
  let startLeafId: string | null = null;
  const subagentId = process.env.PI_SUBAGENT_RUN_ID;
  const initialGeneration = Number(process.env.PI_SUBAGENT_GENERATION) || undefined;
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

  function control(): SubagentControl | undefined { return sessionFile && executionId ? readControl(sessionFile, executionId) : undefined; }
  function quiesce(ctx: ExtensionContext) {
    const request = control();
    if (!request || controlFinished || !sessionFile || !executionId) return;
    if (!controlling || controlling.id !== request.id) {
      controlling = request;
      interruptedTools = [...new Set([...interruptedTools, ...activeTools])];
      // Cooperative cancellation is only a request. Parent separately requires
      // the wrapper's exit receipt AND confirmed terminal closure.
      if (active || preparing || !ctx.isIdle()) { ctx.abort(); return; }
    }
    if (active || preparing || !ctx.isIdle()) return;
    inbox?.suspend();
    const pending = mailbox?.snapshot();
    const unknown = pending?.messages.find((message) => message.uncertainty)?.uncertainty;
    const wait = mailbox?.questions().some((question) => question.state !== "answered") ? "question"
      : descendants?.pendingResults(ctx, executionId) ? "descendants" : "continue";
    // Resident human input can start work without a parent inbox generation.
    // An older outcome must not complete that newer active-branch work.
    const unfinished = wait !== "continue" || ctx.sessionManager.getBranch().some((entry) => !seenEntries.has(entry.id) && (entry.type === "message" || entry.type === "custom_message"));
    const checkpoint: SubagentCheckpoint = {
      requestId: request.id, executionId, leafId: ctx.sessionManager.getLeafId(), resultAfterSequence: unfinished ? sequence : 0,
      wait,
      ...(interruptedTools.length ? { uncertainty: { actionId: unknown?.actionId ?? `subagent-action:${request.id}`, reason: "A tool was active at interruption; abort/shutdown does not prove its external effects. Reconcile or explicitly authorize this exact action before continuation.", activeTools: interruptedTools } }
        : unknown ? { uncertainty: { actionId: unknown.actionId, reason: unknown.reason, activeTools: unknown.activeTools } } : {}),
    };
    // Pin the actual active ancestry before closing. appendEntry's void return
    // is not a receipt: verify the marker in real JSONL bytes before claiming it.
    pi.appendEntry("subagent_suspension", checkpoint);
    const markerId = ctx.sessionManager.getLeafId();
    const diskEntries = new Map<string, any>();
    if (existsSync(sessionFile)) for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
      try { const entry = JSON.parse(line); if (entry.id) diskEntries.set(entry.id, entry); } catch { /* An unfinished trailing record is not a receipt. */ }
    }
    const marker = markerId && diskEntries.get(markerId);
    const persisted = marker?.type === "custom" && marker.customType === "subagent_suspension" && marker.data?.requestId === request.id &&
      marker.parentId === checkpoint.leafId && ctx.sessionManager.getBranch().every((entry) => diskEntries.has(entry.id));
    if (!persisted) checkpoint.uncertainty = { actionId: `subagent-action:${request.id}`, reason: "Interrupted branch marker is not persisted; inspect retained history before authorizing continuation.", activeTools: interruptedTools };
    replace(checkpointFile(sessionFile, executionId), checkpoint);
    controlFinished = true;
    inbox?.closing();
    ctx.shutdown();
  }

  // Show widget + status bar on session start
  pi.on("session_start", (event, ctx) => {
    recorder.sessionStart();
    inbox?.start(ctx, event.reason === "reload");
    if (controlTimer) clearInterval(controlTimer);
    controlTimer = setInterval(() => { try { quiesce(ctx); } catch (error) { console.error("Subagent suspension handshake failed:", error); } }, 50);
    controlTimer.unref?.();
    if (heartbeat) clearInterval(heartbeat);
    if (sessionFile && executionId) {
      writeSubagentLiveness(sessionFile, executionId);
      heartbeat = setInterval(() => {
        try { writeSubagentLiveness(sessionFile, executionId); }
        catch (error) { console.error("Subagent liveness publication failed:", error); }
      }, LIVENESS_INTERVAL_MS);
      heartbeat.unref?.();
    }
    if (sessionFile && ctx.sessionManager.getSessionFile() === sessionFile) {
      descendants = new SubagentNotifications(new SubagentRuns(ctx.sessionManager.getSessionId(), sessionFile, ctx.sessionManager.getSessionDir()));
    }
    seenEntries = new Set(ctx.sessionManager.getEntries().map((entry) => entry.id));
    startLeafId = ctx.sessionManager.getLeafId();
    if (sessionFile && executionId) sequence = readSubagentOutcomes(sessionFile, executionId).at(-1)?.result.sequence ?? 0;
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    if (ctx.hasUI) renderWidget(ctx, null);
  });

  pi.on("input", (_event, ctx) => {
    if (control() || inbox?.paused()) return { action: "handled" };
    if (ctx.isIdle()) preparing = true;
    inbox?.input(ctx.isIdle());
    recorder.input();
  });

  pi.on("context", (event) => {
    descendants?.observeResults(event.messages, executionId!);
    if (inbox?.context(event.messages)) {
      recorder.input();
    }
  });

  pi.on("before_agent_start", () => {
    preparing = true;
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    // Retries/recovery can start another run without any parent reply.
    active = true;
    preparing = false;
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
    // Pi owns branch selection, compaction and context edits. Raw history is
    // still used for accounting/baselines, never for choosing an answer.
    const allEntries = ctx.sessionManager.getEntries();
    const fresh = allEntries.filter((entry) => !seenEntries.has(entry.id));
    const branch = ctx.sessionManager.getBranch();
    const activeWork = branch.filter((entry) => !seenEntries.has(entry.id));
    const instruction = activeWork.findLast((entry) => entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user"));
    const managedInstruction = fresh.findLast((entry) => entry.type === "custom_message" && entry.customType === "subagent_instruction" &&
      (entry.details as { executionId?: string })?.executionId === executionId);
    // A consumed instruction abandoned by navigation cannot borrow an answer
    // from another branch. A later active human instruction can start new work.
    const belongsToWork = !managedInstruction || activeWork.some((entry) => entry.id === managedInstruction.id) ||
      (instruction && fresh.findIndex((entry) => entry.id === instruction.id) > fresh.findIndex((entry) => entry.id === managedInstruction.id));
    const responseEntries = belongsToWork ? activeWork.slice(instruction ? activeWork.indexOf(instruction) + 1 : 0) : [];
    const responseIds = new Set(responseEntries.map((entry) => entry.id));
    const association = managedInstruction?.type === "custom_message" ? managedInstruction.details as { generation?: number; subagentId?: string } : undefined;
    // Initial CLI work is bound at launch. Subsequent managed work is bound
    // to the instruction actually consumed, never the latest mutable run row.
    const generation = association?.generation ?? (sequence === 0 ? initialGeneration : undefined);
    const entries = ctx.sessionManager.buildSessionProjection().entries
      .filter(({ sourceEntry }) => responseIds.has(sourceEntry.id))
      .flatMap(({ sourceEntry, messages }) => messages
        .filter((message) => message.role === "assistant")
        .map((message) => ({ ...sourceEntry, type: "message" as const, message }) as SessionMessageEntry));
    // Durable ownership, not watcher membership, keeps the last descendant
    // outstanding through dispatch, persistence, model exposure and settlement.
    const hasPendingChildren = descendants?.pendingResults(ctx, executionId!);
    if (mailbox?.questions().some((question) => question.state !== "answered") || hasPendingChildren) {
      recorder.agentEndWaiting();
      return;
    }
    if (!sessionFile || !executionId) throw new Error("Missing managed subagent session or execution ID");
    const rawSource = responseEntries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    const source = entries.find((entry) => entry.id === rawSource?.id);
    // Terminal metadata belongs to the actual final response even when an edit
    // omits its context contribution. Never substitute an intermediate answer.
    const message = rawSource?.type === "message" && rawSource.message.role === "assistant" ? rawSource.message : undefined;
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
    const model = message?.model && message.provider
      ? ctx.model?.id === message.model && ctx.model.provider === message.provider ? ctx.model
        : ctx.modelRegistry.getAll().find((model) => model.id === message.model && model.provider === message.provider)
      : ctx.model;
    const errorMessage = outcome === "failed" ? message?.errorMessage || "Final provider/agent error (no errorMessage supplied)."
      : outcome === "aborted" ? "Task was manually aborted."
      : outcome === "truncated" ? "Assistant output was truncated (stopReason=length)."
      : outcome === "no-output" ? "Settled without new assistant output." : undefined;
    writeSubagentOutcome({
      version: 1, executionId, sequence: sequence + 1,
      outcome, output, autoExit,
      ...(subagentId || association?.subagentId ? { subagentId: subagentId ?? association?.subagentId } : {}),
      ...(generation === undefined ? {} : { generation }),
      usage: { generation: summarizeEntryUsage(fresh, model, message), session: summarizeEntryUsage(allEntries, model, message) },
      ...(errorMessage ? { errorMessage } : {}),
      source: {
        kind: "agent_settled", sessionFile, sessionId: ctx.sessionManager.getSessionId(),
        entryId: rawSource?.id ?? null, leafId: ctx.sessionManager.getLeafId(),
        stopReason: message?.stopReason ?? null,
        outputEntryIds: outputEntries.map((entry) => entry.id),
        startLeafId, instructionEntryId: instruction?.id ?? managedInstruction?.id ?? null,
      },
    });
    sequence++;
    seenEntries = new Set(allEntries.map((entry) => entry.id));
    startLeafId = ctx.sessionManager.getLeafId();

    if (autoExit && outcome !== "aborted") {
      recorder.agentEndDone();
      inbox?.closing();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
  }
  pi.on("agent_settled", (_event, ctx) => {
    active = false;
    preparing = false;
    if (control() && (controlling || activityOutcome === "aborted")) return;
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
    activeTools.add(event.toolCallId);
    if (controlling || control()) interruptedTools = [...new Set([...interruptedTools, event.toolCallId])];
    inbox?.toolStart(event.toolCallId);
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    if (control()) return { block: true, reason: "Owned work is suspending/stopping; no new tool action permitted." };
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
    activeTools.delete(event.toolCallId);
    inbox?.toolEnd(event.toolCallId);
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    inbox?.stop();
    if (controlTimer) clearInterval(controlTimer);
    controlTimer = undefined;
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

      if (!params.question.trim()) throw new Error("Question must not be empty");
      const question = mailbox!.ask({ executionId: executionId!, subagentId, question: params.question });
      recorder.askQuestion();

      return {
        content: [
          {
            type: "text",
            text:
              `Question ${question.questionId} durably recorded for the orchestrator. Stop here and wait — do not continue working or ` +
              "assume an answer. Their reply will arrive as your next message.",
          },
        ],
        details: question,
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
