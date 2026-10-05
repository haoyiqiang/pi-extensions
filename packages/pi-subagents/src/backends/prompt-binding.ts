import { i18n } from "../i18n.js";

/** Resolver/resource identity only. Supporting assets remain live, not an immutable bundle. */
export interface PromptBinding {
  readonly resolverId: string;
  readonly resourceSetDigest: string;
  readonly assetMode: "live";
}

export function snapshotPromptBinding(value: PromptBinding): PromptBinding;
export function snapshotPromptBinding(value: unknown): PromptBinding | undefined;
/** Copy only credential-free identity fields before a caller can mutate them. */
export function snapshotPromptBinding(value: unknown): PromptBinding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const { resolverId, resourceSetDigest, assetMode } = value as PromptBinding;
  if (typeof resolverId !== "string" || !resolverId.trim() || resolverId.trim() !== resolverId
    || /[\u0000-\u001f\u007f]/.test(resolverId)
    || typeof resourceSetDigest !== "string" || resourceSetDigest.length !== 64 || !/^[a-f0-9]{64}$/.test(resourceSetDigest)
    || assetMode !== "live") invalid();
  return Object.freeze({ resolverId, resourceSetDigest, assetMode });
}

/** Presence is part of identity: a bound source cannot be restored by an unbound caller. */
export function assertPromptBindingMatches(actual: PromptBinding | undefined, expected: PromptBinding | undefined): void {
  const saved = snapshotPromptBinding(actual);
  const supplied = snapshotPromptBinding(expected);
  if (saved?.resolverId !== supplied?.resolverId || saved?.resourceSetDigest !== supplied?.resourceSetDigest
    || saved?.assetMode !== supplied?.assetMode) throw new Error(i18n.t("promptBinding.mismatch"));
}

function invalid(): never {
  throw new Error(i18n.t("promptBinding.invalid"));
}
