import type { EffectiveThinkingLevel } from "../types.js";
import type { SessionStatsLike } from "../usage.js";
import type { SessionReference } from "./session-reference.js";

/** Read-only projection of message content. Extra provider/custom fields are retained at runtime. */
export interface TranscriptBlock {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly toolName?: string;
}

export interface TranscriptMessage {
  readonly role: string;
  readonly content?: string | readonly TranscriptBlock[];
  readonly toolName?: string;
}

/** Raw active-branch envelope. Extra entry/message fields are retained at runtime. */
export interface SessionBranchEntry {
  readonly type: string;
  readonly id?: string;
  readonly parentId?: string | null;
  readonly message?: TranscriptMessage;
}

/** Only observation semantics needed by the viewer and append-only output writer. */
export type SessionViewEvent =
  | { readonly type: "changed" | "turn_end" | "compaction_start" }
  | { readonly type: "compaction_end"; readonly aborted: boolean; readonly result?: boolean };

export interface SessionView {
  /** Live getters preserve message identity for render caches and observe compaction replacements. */
  readonly messages: readonly TranscriptMessage[];
  getSessionStats(): SessionStatsLike;
  subscribe(listener: (event: SessionViewEvent) => void): () => void;
}

/** Opaque execution identity plus observations. No prompt, steer, abort, dispose or SDK manager. */
export interface ExecutionSession extends SessionView {
  readonly reference: SessionReference;
  /** Raw active branch, including compaction and metadata; never projected context messages. */
  getBranch?(): readonly SessionBranchEntry[];
  readonly model?: { readonly provider: string; readonly id: string; readonly name?: string };
  readonly thinkingLevel?: EffectiveThinkingLevel;
}
