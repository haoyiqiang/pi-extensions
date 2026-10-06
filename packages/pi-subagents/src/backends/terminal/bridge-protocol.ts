export { modelFingerprint } from "../model-identity.js";
import { i18n } from "../../i18n.js";
import type { ExecutionSession, SessionViewEvent, TranscriptMessage } from "../session.js";
import type { RunReference } from "../session-reference.js";
import type { SessionStatsLike, LifetimeUsage } from "../../usage.js";
import type { SessionWitness } from "./session-witness.js";
import type { StandardTerminalPolicy } from "./standard-policy.js";

export const BRIDGE_VERSION = 1;
export const MAX_BRIDGE_FRAME_BYTES = 16 * 1024 * 1024;
export const TERMINAL_MANIFEST_ENV = "PI_SUBAGENTS_TERMINAL_MANIFEST";
export const STANDARD_TERMINAL_CONFIG_ENV = "PI_SUBAGENTS_STANDARD_TERMINAL_CONFIG";

export interface TerminalSnapshot {
  messages: readonly TranscriptMessage[];
  model?: ExecutionSession["model"];
  thinkingLevel?: ExecutionSession["thinkingLevel"];
  stats: SessionStatsLike;
}

/** Private, per-run capability file. Never contains provider credentials. */
export interface StandardTerminalChildConfig {
  version: 1;
  policy: StandardTerminalPolicy;
  promptFile: string;
  agentDir: string;
  providerExtensions: string[];
  outputMode: "text" | "json";
}

export interface TerminalChildManifest {
  version: 1;
  /** Omitted by older managed launchers; managed remains the compatibility default. */
  profile?: "managed" | "standard";
  run: RunReference<"terminal">;
  endpoint: { host: "127.0.0.1"; port: number; token: string };
  model?: { provider: string; id: string };
  /** Detect parent-only API/endpoint overrides without serializing their URLs or credentials. */
  modelFingerprint?: string;
  tools: string[];
  systemPrompt: string;
  structuredSchema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
  /** Standard product sessions may remain at the TUI after a turn settles. */
  interactive?: boolean;
  autoExit?: boolean;
  /** Standard profile preflight checks the actual post-extension active set. */
  requiredTools?: string[];
}

export interface ChildSettlement {
  snapshot: TerminalSnapshot;
  text: string;
  aborted: boolean;
  failure?: string;
  structuredJson?: string;
  structuredRetried?: boolean;
  steered?: boolean;
  witness?: SessionWitness;
}

export type ChildFeedback =
  | { type: "ready"; snapshot: TerminalSnapshot }
  | { type: "snapshot"; event: SessionViewEvent; snapshot: TerminalSnapshot }
  | { type: "text"; delta: string; fullText: string }
  | { type: "tool"; activity: { type: "start" | "end"; toolName: string } }
  | { type: "usage"; usage: LifetimeUsage }
  | { type: "turn"; count: number }
  | { type: "compaction"; info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number } }
  | ({ type: "idle" } & ChildSettlement)
  | ({ type: "settled" } & ChildSettlement)
  | { type: "ack"; id: string; error?: string }
  | { type: "failure"; error: string };

export type ParentControl =
  | { type: "accepted"; version: 1; runId: string; sessionId: string }
  | { type: "start" }
  | { type: "steer"; id: string; message: string }
  | { type: "abort" };
export type ChildPacket = ChildFeedback & { seq: number };
export interface ChildHello {
  type: "hello";
  version: 1;
  token: string;
  runId: string;
  sessionId: string;
}

/** Bounded UTF-8 NDJSON framing shared by the two ends; no transport side effects. */
export class BridgeFrames {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: unknown[] = [];
    let end: number;
    while ((end = this.pending.indexOf(10)) !== -1) {
      if (end > MAX_BRIDGE_FRAME_BYTES) throw new Error(i18n.t("bridge.frameTooLarge"));
      const line = this.pending.subarray(0, end);
      this.pending = this.pending.subarray(end + 1);
      if (line.length) {
        try { frames.push(JSON.parse(line.toString("utf8"))); }
        catch { throw new Error(i18n.t("bridge.protocol")); }
      }
    }
    if (this.pending.length > MAX_BRIDGE_FRAME_BYTES) throw new Error(i18n.t("bridge.frameTooLarge"));
    return frames;
  }
}

export function encodeBridgeFrame(value: unknown): string {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > MAX_BRIDGE_FRAME_BYTES) throw new Error(i18n.t("bridge.frameTooLarge"));
  return line + "\n";
}
