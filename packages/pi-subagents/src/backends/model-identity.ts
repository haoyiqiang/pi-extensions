import { createHash } from "node:crypto";

/** Compare resolved model transports without persisting their endpoints or credentials. */
export function modelFingerprint(model: { provider: string; id: string; api?: unknown; baseUrl?: unknown }): string | undefined {
  if (typeof model.api !== "string" || typeof model.baseUrl !== "string") return undefined;
  return createHash("sha256").update(JSON.stringify([model.provider, model.id, model.api, model.baseUrl])).digest("hex");
}
