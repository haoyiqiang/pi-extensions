import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { replace, transaction, type SubagentRuns } from "./runs.ts";

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
  deliver(pi: ExtensionAPI): void {
    if (!this.owns()) return;
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
