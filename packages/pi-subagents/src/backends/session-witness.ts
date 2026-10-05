import { createHash } from "node:crypto";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

export interface SessionWitness {
  leafId: string | null;
  entries: number;
  digest: string;
}

/** Finalized in-memory state must match the compact JSONL after its writer is idle. */
export function sessionWitness(manager: {
  getHeader(): SessionHeader | null;
  getEntries(): readonly SessionEntry[];
  getLeafId(): string | null;
}): SessionWitness {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(manager.getHeader()) + "\n");
  const entries = manager.getEntries();
  for (const entry of entries) hash.update(JSON.stringify(entry) + "\n");
  return { leafId: manager.getLeafId(), entries: entries.length, digest: hash.digest("hex") };
}
