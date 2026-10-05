import { createHash } from "node:crypto";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

export interface SessionWitness {
  leafId: string | null;
  entries: number;
  digest: string;
}

/** The child's finalized in-memory tree must match the compact JSONL that actually retired. */
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
