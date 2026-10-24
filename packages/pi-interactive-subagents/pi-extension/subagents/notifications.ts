import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { projectRun, replace, transaction, writerFile, type SubagentRuns } from "./runs.ts";

export interface Notification {
  customType: string;
  content: string;
  display: boolean;
  details: { eventId: string; [key: string]: unknown };
}

// Pi retains its queues across extension reload. Remember dispatches across that
// reload too, but never treat this process-local set as a persistence receipt.
const ATTEMPTS = Symbol.for("pi-subagents/notification-attempts");
const attempts: Map<string, Set<string>> = (globalThis as any)[ATTEMPTS] ??= new Map();

/** Immutable outbox + read-only reconciliation; Pi remains the only history writer. */
export class SubagentNotifications {
  private readonly directory: string;
  private readonly attempted: Set<string>;
  private readonly token = randomUUID();
  private readonly ownerFile: string;
  private preparing = false;
  constructor(private readonly runs: SubagentRuns) {
    this.directory = join(runs.directory, "notifications");
    this.ownerFile = join(runs.directory, "observer.json");
    this.attempted = attempts.get(runs.parentSessionFile) ?? new Set();
    attempts.set(runs.parentSessionFile, this.attempted);
  }
  owns(): boolean {
    return existsSync(this.ownerFile) && JSON.parse(readFileSync(this.ownerFile, "utf8")).token === this.token;
  }
  acquire(): boolean {
    if (this.owns()) return true;
    return transaction(this.runs.directory, () => {
      if (existsSync(this.ownerFile)) {
        const owner = JSON.parse(readFileSync(this.ownerFile, "utf8"));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Subagent observer ownership is unknown; records retained");
        try { process.kill(owner.pid, 0); return false; }
        catch (error: any) { if (error.code !== "ESRCH") return false; }
        // Positive process absence only. Age, heartbeat loss, permission errors
        // and a reused/live PID all retain the old ownership claim.
      }
      replace(this.ownerFile, { pid: process.pid, token: this.token });
      return true;
    });
  }
  release(preserveQueued: boolean): void {
    if (!preserveQueued) this.attempted.clear();
    if (!this.owns()) return;
    transaction(this.runs.directory, () => { if (this.owns()) unlinkSync(this.ownerFile); });
  }
  publish(message: Notification): void {
    if (!this.owns()) throw new Error("Subagent observer no longer owns notification publication");
    mkdirSync(this.directory, { recursive: true });
    const file = join(this.directory, `${createHash("sha256").update(message.details.eventId).digest("hex")}.json`);
    // Identity, not a new timestamp/preview on recovery, selects the first event.
    if (!existsSync(file)) replace(file, message);
  }
  private history(): Set<string> {
    const ids = new Set<string>();
    if (!existsSync(this.runs.parentSessionFile)) return ids;
    const lines = readFileSync(this.runs.parentSessionFile, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let entry;
      try { entry = JSON.parse(lines[i]); }
      catch (error) { if (i === lines.length - 1) break; throw error; }
      if (entry.type === "session" && entry.id !== this.runs.parentSessionId) throw new Error("Notification parent history ownership mismatch");
      // History-wide dedup includes abandoned branches, even if context edits or
      // compaction hide that event from the model's current branch.
      if (entry.type === "custom_message" && typeof entry.details?.eventId === "string") ids.add(entry.details.eventId);
    }
    return ids;
  }
  list() {
    const persisted = this.history();
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter((file) => file.endsWith(".json")).map((file) => {
      const message: Notification = JSON.parse(readFileSync(join(this.directory, file), "utf8"));
      return { message, state: persisted.has(message.details.eventId) ? "persisted" : this.attempted.has(message.details.eventId) ? "dispatched-unconfirmed" : "pending" };
    });
  }
  /** Pi's boundary preview exposes its real custom queues, unlike the user
   * queue display/hasPendingMessages in 0.87. Only an empty preview proves a
   * discarded attempt cannot still be queued behind another message. */
  reconcile(ctx: ExtensionContext, pendingMessages: unknown[]): void {
    if (!this.owns() || pendingMessages.length) return;
    const memory = new Set(ctx.sessionManager.getEntries().flatMap((entry) =>
      entry.type === "custom_message" && typeof (entry.details as any)?.eventId === "string" ? [(entry.details as any).eventId] : []));
    const persisted = this.history();
    for (const id of this.attempted) {
      // Memory inclusion prevents duplicate dispatch, but never upgrades the
      // event to persisted: only actual parent-history bytes do that.
      if (!memory.has(id) && !persisted.has(id)) this.attempted.delete(id);
    }
  }
  prepareInput(): void { this.preparing = true; }
  agentStart(): void { this.preparing = false; }
  private assertReceiver(executionId: string): void {
    const file = writerFile(this.runs.parentSessionFile);
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).executionId !== executionId) throw new Error("Stale descendant-result receiver");
  }
  /** Model exposure is separate from both void dispatch and history persistence. */
  observeResults(messages: any[], executionId: string): void {
    this.assertReceiver(executionId);
    const events = this.list();
    for (const message of messages) {
      if (message.role !== "custom" || message.customType !== "subagent_result") continue;
      const event = events.find((event) => event.message.details.eventId === message.details?.eventId && event.message.content === message.content);
      if (!event) continue;
      const file = this.incorporationFile(event.message.details.eventId);
      const receipt = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
      if (!receipt || (!receipt.incorporated && receipt.executionId !== executionId)) replace(file, { eventId: event.message.details.eventId, executionId, observed: true });
    }
  }
  private incorporationFile(eventId: string): string {
    const directory = join(this.directory, "incorporation");
    mkdirSync(directory, { recursive: true });
    return join(directory, `${createHash("sha256").update(eventId).digest("hex")}.json`);
  }
  /** A completed child still owes its parent a persisted, model-observed result. */
  pendingResults(ctx: ExtensionContext, executionId: string): boolean {
    this.assertReceiver(executionId);
    const events = this.list();
    const branch = ctx.sessionManager.getBranch();
    const projected = ctx.sessionManager.buildSessionProjection().entries;
    return this.runs.list().some((record) => {
      const run = projectRun(record);
      if (run.state === "stopped") return false;
      if (["starting", "running", "suspending", "suspended", "stopping"].includes(run.state) || !run.latestResult) return true;
      const event = events.find(({ message }) => message.customType === "subagent_result" && message.details.id === run.id && message.details.generation === run.generation && message.details.resultFile === run.latestResult!.resultFile);
      if (!event || event.state !== "persisted") return true;
      const file = this.incorporationFile(event.message.details.eventId);
      if (!existsSync(file)) return true;
      const receipt = JSON.parse(readFileSync(file, "utf8"));
      if (receipt.incorporated) return false;
      if (receipt.executionId !== executionId) return true;
      // Compaction/context edits can hide an already-observed event. Its raw
      // active-branch ancestry still binds the effective subsequent response;
      // an event on an abandoned branch cannot complete this wait.
      const index = branch.findIndex((entry) => entry.type === "custom_message" && entry.customType === "subagent_result" && (entry.details as any)?.eventId === event.message.details.eventId);
      const after = new Set(index < 0 ? [] : branch.slice(index + 1).map((entry) => entry.id));
      const response = projected.findLast(({ sourceEntry, messages }) => after.has(sourceEntry.id) && messages.some((message) => message.role === "assistant"));
      if (!response) return true;
      replace(file, { ...receipt, incorporated: true, entryId: response.sourceEntry.id, leafId: ctx.sessionManager.getLeafId() });
      return false;
    });
  }
  deliver(pi: ExtensionAPI): void {
    if (!this.owns() || this.preparing) return;
    for (const event of this.list()) {
      if (event.state !== "pending") continue;
      const id = event.message.details.eventId;
      this.attempted.add(id);
      try { pi.sendMessage(event.message, { triggerTurn: true, deliverAs: "steer" }); }
      catch (error) { this.attempted.delete(id); throw error; }
      // The API returns void; neither this return nor getEntries acknowledges
      // disk inclusion. Retain the event even after history proves delivery.
    }
  }
}
