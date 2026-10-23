import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { replace, transaction, readControl, readCheckpoint, writerClosingFile, writerExited, writerFile, type SubagentRun } from "./runs.ts";

export const INSTRUCTION_TYPE = "subagent_instruction";
export type DeliveryMode = "auto" | "steer" | "followUp";
interface Instruction {
  id: string;
  sequence: number;
  content: string;
  deliverAs: DeliveryMode;
  subagentId: string;
  executionId: string;
  generation: number;
  replyTo?: string;
  continuation?: boolean;
}
interface Question {
  questionId: string;
  eventId: string;
  executionId: string;
  subagentId?: string;
  question: string;
}
export interface Authorization {
  actionId: string;
  decision: "retry" | "confirm-completed";
  reason: string;
}
interface Mailbox { version: 1; messages: Instruction[]; authorizations: Authorization[] }
interface Receipt {
  messageId: string;
  attemptId: string;
  executionId: string;
  receiverId: string;
  phase: "accepted" | "dispatching" | "settled" | "suspended";
  contextSeen?: boolean;
  uncertain?: string;
  activeTools?: string[];
}

/** Sender-owned publication, receiver-owned receipts. Neither side patches the other's facts. */
export class SubagentInbox {
  readonly directory: string;
  constructor(readonly sessionFile: string) { this.directory = `${sessionFile}.inbox`; }
  private read(): Mailbox {
    const file = join(this.directory, "messages.json");
    const value = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, messages: [], authorizations: [] };
    if (value.version !== 1 || !Array.isArray(value.messages) || !Array.isArray(value.authorizations)) throw new Error(`Invalid subagent inbox: ${file}`);
    return value;
  }
  receipts(): Receipt[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter((name) => name.startsWith("receipt-") && name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(this.directory, name), "utf8")));
  }
  save(receipt: Receipt): void {
    mkdirSync(this.directory, { recursive: true });
    replace(join(this.directory, `receipt-${receipt.attemptId}.json`), receipt);
  }
  /** Read JSONL bytes, not a second mutable SessionManager or its in-memory index. */
  private associations(): Map<string, { id: string; content: unknown; details: any }> {
    const entries = new Map<string, { id: string; content: unknown; details: any }>();
    if (!existsSync(this.sessionFile)) return entries;
    const lines = readFileSync(this.sessionFile, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let entry;
      try { entry = JSON.parse(lines[i]); }
      catch (error) { if (i === lines.length - 1) break; throw error; }
      if (entry.type === "custom_message" && entry.customType === INSTRUCTION_TYPE && typeof entry.details?.attemptId === "string") {
        entries.set(entry.details.attemptId, entry);
      }
    }
    return entries;
  }
  snapshot(run?: SubagentRun) {
    const mailbox = this.read();
    const receipts = this.receipts();
    const associations = mailbox.messages.length ? this.associations() : new Map<string, { id: string; content: unknown; details: any }>();
    const exited = run ? writerExited(run) : false;
    const receiverFile = join(this.directory, "receiver.json");
    const receiver = existsSync(receiverFile) ? JSON.parse(readFileSync(receiverFile, "utf8")) : undefined;
    const messages = mailbox.messages.map((message) => {
      const attempts = receipts.filter((receipt) => receipt.messageId === message.id);
      // Receipt filenames are not ordering. Retry decisions are explicitly
      // serialized; an accepted-only abandoned receipt cannot hide that retry.
      const retried = mailbox.authorizations.filter((a) => a.decision === "retry" && attempts.some((r) => r.attemptId === a.actionId));
      const superseded = new Set(retried.map((a) => a.actionId));
      const active = attempts.find((r) => r.phase !== "accepted" && !superseded.has(r.attemptId))
        ?? attempts.find((r) => r.attemptId === retried.at(-1)?.actionId)
        ?? attempts.find((r) => r.phase === "accepted");
      const authorization = active && mailbox.authorizations.find((a) => a.actionId === active.attemptId);
      const association = active && associations.get(active.attemptId);
      const mismatched = association && (association.content !== message.content || association.details.messageId !== message.id || association.details.executionId !== active?.executionId || association.details.replyTo !== message.replyTo);
      const entryId = association && !mismatched ? association.id : undefined;
      const delivery = entryId ? "consumed" : active ? "accepted" : "queued";
      const uncertainReason = mismatched ? "Persisted instruction differs from the exact managed payload/context; reconcile before proceeding."
        : active?.uncertain ?? (receiver && active && receiver.receiverId !== active.receiverId ? "Child control runtime restarted after dispatch intent and before final settlement; reconcile or explicitly authorize this affected action."
          : exited && active?.executionId === run?.executionId ? "Writer exited before final settlement; consumption or external effects may be incomplete." : undefined);
      const uncertainty = active && !authorization && (mismatched || (active.phase === "dispatching" && uncertainReason))
        ? { actionId: active.attemptId, messageId: message.id, reason: uncertainReason!, entryId: entryId ?? null, activeTools: active.activeTools ?? [] } : undefined;
      const state = uncertainty ? "uncertain" : active?.phase === "suspended" ? "suspended" : active?.phase === "settled" || authorization?.decision === "confirm-completed" ? "settled" : delivery;
      return { ...message, state, delivery, evidence: { durableEnqueue: true, childAccepted: !!active, dispatchIntent: !!active && active.phase !== "accepted", transcriptEntryId: entryId ?? null, contextObserved: !!active?.contextSeen, settled: active?.phase === "settled" },
        ...(authorization ? { resolution: authorization } : {}), ...(uncertainty ? { uncertainty } : {}), attemptId: active?.attemptId, retry: authorization?.decision === "retry" };
    });
    const checkpoint = run && readCheckpoint(run);
    const interruption = checkpoint?.uncertainty ?? (run?.control?.kind === "suspend" && exited && !checkpoint
      ? { actionId: `subagent-action:${run.control.id}`, reason: "Writer exited without a verified suspension checkpoint; consumption/effects and active branch must be reconciled before continuation.", activeTools: [] } : undefined);
    const resolution = interruption && mailbox.authorizations.find((authorization) => authorization.actionId === interruption.actionId);
    const uncertainty = interruption && !resolution ? interruption : undefined;
    return { messages, ...(resolution ? { resolution } : {}), ...(uncertainty ? { uncertainty } : {}), paused: !!uncertainty || messages.some((message) => !!message.uncertainty) };
  }
  /** The same short cross-process lock allocates order, deduplicates, and reserves a writer before launch. */
  enqueue(run: SubagentRun, input: { message?: string; messageId?: string; deliverAs?: DeliveryMode; replyTo?: string; authorization?: Authorization }, prepare: () => { run: SubagentRun; launch: boolean; waitingForExit?: boolean }, restore = false) {
    return transaction(this.directory, () => {
      if (run.control?.kind === "stop") throw new Error("Subagent explicitly stopped or stopping; no message restart permitted. History retained; delegate a fresh named role.");
      const mailbox = this.read();
      const id = input.messageId ?? randomUUID();
      const existing = input.message === undefined ? undefined : mailbox.messages.find((message) => message.id === id);
      if (existing && (existing.content !== input.message || existing.deliverAs !== (input.deliverAs ?? "auto") || existing.replyTo !== input.replyTo)) throw new Error("Message ID conflict: the same id cannot identify different content or delivery mode");
      if (input.replyTo !== undefined) {
        if (input.message === undefined) throw new Error("A replyTo requires a message");
        const question = this.questions().find((q) => q.questionId === input.replyTo && (!q.subagentId || q.subagentId === run.id));
        if (!question) throw new Error("Unknown or invalid question replyTo for this child; no reply accepted");
        if (question.replyMessageId && question.replyMessageId !== existing?.id) throw new Error("Question already has a queued or answered reply; use the same messageId for a retry");
      }
      if (input.authorization) {
        const state = this.snapshot(run);
        const uncertainty = state.messages.find((message) => message.uncertainty?.actionId === input.authorization!.actionId)?.uncertainty
          ?? (state.uncertainty?.actionId === input.authorization.actionId ? state.uncertainty : undefined);
        if (!uncertainty) throw new Error("Authorization must name the exact current uncertain actionId; no uncertainty cleared");
        if (!input.authorization.reason.trim()) throw new Error("Explicit user authorization/reconciliation requires a reason");
        mailbox.authorizations.push(input.authorization);
        replace(join(this.directory, "messages.json"), mailbox);
      }
      const snapshot = this.snapshot(run);
      const paused = snapshot.paused;
      const safePending = snapshot.messages.some((m) => m.state === "queued" || m.retry || (m.state === "accepted" && !m.evidence.dispatchIntent));
      const target = paused || (existing && !safePending) || (input.message === undefined && !safePending && !restore) ? { run, launch: false } : prepare();
      // Rebind only never-dispatched input or an explicitly authorized retry.
      if (target.launch) for (const message of mailbox.messages) {
        const status = snapshot.messages.find((m) => m.id === message.id);
        if (status?.retry || !status?.evidence.dispatchIntent) {
          message.executionId = target.run.executionId;
          message.generation = target.run.generation;
        }
      }
      if (input.message !== undefined && !existing) mailbox.messages.push({ id, sequence: (mailbox.messages.at(-1)?.sequence ?? 0) + 1, content: input.message, deliverAs: input.deliverAs ?? "auto",
        subagentId: target.run.id, executionId: target.run.executionId, generation: target.run.generation, ...(restore ? { continuation: true } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}) });
      replace(join(this.directory, "messages.json"), mailbox);
      return { ...target, message: this.snapshot(target.run).messages.find((m) => m.id === id), paused };
    });
  }
  ask(input: Omit<Question, "questionId" | "eventId">) {
    return transaction(this.directory, () => {
      if (existsSync(writerFile(this.sessionFile)) && JSON.parse(readFileSync(writerFile(this.sessionFile), "utf8")).executionId !== input.executionId) throw new Error("Stale question writer; no question accepted");
      const questionId = randomUUID();
      const question = { ...input, questionId, eventId: `subagent-question:${questionId}` };
      replace(join(this.directory, `question-${questionId}.json`), question);
      return question;
    });
  }
  questions() {
    if (!existsSync(this.directory)) return [];
    const messages = this.snapshot().messages;
    return readdirSync(this.directory).filter((name) => name.startsWith("question-") && name.endsWith(".json")).map((name) => {
      const question: Question = JSON.parse(readFileSync(join(this.directory, name), "utf8"));
      if (!question.questionId || !question.question || !question.eventId) throw new Error(`Invalid retained question: ${name}`);
      const reply = messages.find((message) => message.replyTo === question.questionId);
      const answered = !!reply?.evidence.transcriptEntryId && reply.evidence.contextObserved;
      return { ...question, state: answered ? "answered" : reply ? "reply-queued" : "pending", replyMessageId: reply?.id };
    });
  }
  pending() {
    // A lifecycle continuation restores current work before queued followUp;
    // caller instructions retain their own publication order and stable IDs.
    return this.snapshot().messages.filter((message) => message.state === "queued" || message.retry || (message.state === "accepted" && !message.evidence.dispatchIntent))
      .sort((a, b) => Number(!!b.continuation) - Number(!!a.continuation) || a.sequence - b.sequence);
  }
}

/** One controlled receiver per fenced Pi writer. A void Pi call is only dispatch intent. */
export function createInboxReceiver(pi: ExtensionAPI, sessionFile: string, executionId: string) {
  const inbox = new SubagentInbox(sessionFile);
  const receiverId = randomUUID();
  const owned = new Map<string, Receipt>();
  let context: ExtensionContext;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let pumping = false;
  let preparing = false;
  let awaitingInitialRun = process.env.PI_SUBAGENT_INBOX_ONLY !== "1";
  function fenced() {
    const claim = JSON.parse(readFileSync(writerFile(sessionFile), "utf8"));
    return claim.executionId === executionId;
  }
  function paused() { return inbox.snapshot().paused; }
  function pump() {
    if (stopped || pumping || preparing || awaitingInitialRun || !context || !fenced() || readControl(sessionFile, executionId)) return;
    pumping = true;
    try {
      if (paused()) return;
      for (const message of inbox.pending()) {
        if (owned.has(message.id) && !message.retry) continue;
        const receipt: Receipt = { messageId: message.id, attemptId: randomUUID(), executionId, receiverId, phase: "accepted" };
        inbox.save(receipt); // Durable receiver acceptance; still demonstrably not dispatched.
        receipt.phase = "dispatching";
        inbox.save(receipt); // Crash after this point is NOT permission to replay.
        owned.set(message.id, receipt);
        pi.sendMessage({ customType: INSTRUCTION_TYPE, content: message.content, display: true,
          details: { messageId: message.id, attemptId: receipt.attemptId, subagentId: message.subagentId, executionId, generation: message.generation, sequence: message.sequence, ...(message.replyTo ? { replyTo: message.replyTo } : {}) } },
        { triggerTurn: true, deliverAs: message.deliverAs === "followUp" ? "followUp" : "steer" });
      }
    } finally { pumping = false; }
  }
  return {
    start(ctx: ExtensionContext, reloaded = false) {
      context = ctx;
      if (reloaded) awaitingInitialRun = false;
      // A replacement receiver records its own identity, never rewrites the
      // previous writer's facts. Old dispatch intent is now uncertain, whereas
      // accepted-but-never-dispatched input is safe to re-accept.
      if (!fenced()) throw new Error("Stale managed inbox receiver");
      mkdirSync(inbox.directory, { recursive: true });
      replace(join(inbox.directory, "receiver.json"), { executionId, receiverId });
      timer = setInterval(() => { try { pump(); } catch (error) { console.error("Subagent inbox failed:", error); } }, 100);
      timer.unref?.();
      // Don't race the CLI's initial prompt during session_start.
    },
    input(idle: boolean) { if (idle) preparing = true; },
    agentStart() { preparing = false; awaitingInitialRun = false; },
    context(messages: any[]) {
      let newlyObserved = false;
      for (const message of messages) {
        if (message.role !== "custom" || message.customType !== INSTRUCTION_TYPE) continue;
        const receipt = owned.get(message.details?.messageId);
        if (receipt && receipt.attemptId === message.details?.attemptId && !receipt.contextSeen) { receipt.contextSeen = true; inbox.save(receipt); newlyObserved = true; }
      }
      return newlyObserved;
    },
    toolStart(id: string) { for (const receipt of owned.values()) if (receipt.contextSeen && receipt.phase !== "settled") { receipt.activeTools = [...(receipt.activeTools ?? []), id]; inbox.save(receipt); } },
    toolEnd(id: string) { for (const receipt of owned.values()) if (receipt.activeTools?.includes(id)) { receipt.activeTools = receipt.activeTools.filter((tool) => tool !== id); inbox.save(receipt); } },
    beforeSettle() { pump(); },
    boundary(action: () => void) { transaction(inbox.directory, action); },
    closing() { replace(writerClosingFile(sessionFile, executionId), { executionId, receiverId }); },
    settled(outcome: "completed" | "aborted" | "error") {
      const snapshot = inbox.snapshot();
      for (const receipt of owned.values()) {
        if (!receipt.contextSeen || !snapshot.messages.find((m) => m.attemptId === receipt.attemptId)?.evidence.transcriptEntryId) continue;
        if (!receipt.activeTools?.length) receipt.phase = "settled";
        else receipt.uncertain = `Pi settled with ${outcome} without observing the active tool outcomes; reconcile effects before continuing this action.`;
        inbox.save(receipt);
      }
    },
    suspend() {
      const snapshot = inbox.snapshot();
      for (const receipt of owned.values()) {
        if (receipt.phase === "settled" || receipt.uncertain) continue;
        const message = snapshot.messages.find((message) => message.attemptId === receipt.attemptId);
        if (receipt.contextSeen && message?.evidence.transcriptEntryId && !receipt.activeTools?.length) receipt.phase = "suspended";
        else receipt.uncertain = "Suspension cannot establish consumption or tool effects; explicitly reconcile this action before continuation.";
        inbox.save(receipt);
      }
    },
    hasPending() { return paused() || inbox.pending().length > 0 || inbox.snapshot().messages.some((m) => m.state === "accepted"); },
    paused,
    stop() { stopped = true; if (timer) clearInterval(timer); },
  };
}
