import type { BodyState } from "./body.ts";
import type { Field } from "./types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NOTICE_SOURCE } from "../../i18n.js";
import { notifyWithSource } from "pi-extensions-i18n";

export function notifyError(_state: BodyState, ctx: ExtensionContext, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  try {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "error", message });
  } catch {
    // Defensive: never let a bad notify call break the modal loop.
  }
}

export function extractInitialValue(field: Field): unknown {
  if (field.type === "action") return undefined;
  return (field as { value: unknown }).value;
}
