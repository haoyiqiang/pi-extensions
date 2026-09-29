import type { ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { createExtensionApiDouble, type ExtensionApiDoubleOptions } from "./pi-extension-api.js";

// Compile-only contract. Never execute the intentionally invalid calls below.
export function checkHandlerReplay(event: TurnEndEvent, ctx: ExtensionContext): void {
  const handlers: NonNullable<ExtensionApiDoubleOptions["turnEndHandlers"]> = [];
  const pi = createExtensionApiDouble({ turnEndHandlers: handlers });
  pi.on("turn_end", (received, context) => {
    received.type satisfies "turn_end";
    context satisfies ExtensionContext;
  });
  const handler = handlers[0];
  if (!handler) throw new Error("turn_end handler missing");
  handler(event, ctx);
  // @ts-expect-error Replay must reject null events.
  handler(null, ctx);
  // @ts-expect-error Replay must reject a different event type.
  handler({ type: "agent_start" }, ctx);
  // @ts-expect-error Replay requires a complete host context.
  handler(event, { signal: undefined });
}
