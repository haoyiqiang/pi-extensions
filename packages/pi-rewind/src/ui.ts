/**
 * pi-rewind — UI helpers
 *
 * Footer status and notifications.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RewindState } from "./state.js";
import { i18n } from "./i18n.js";

/** 底部状态栏的键；同一键会被后续更新覆盖。 */
const STATUS_KEY = "rewind";

/** Update footer status with checkpoint count */
export function updateStatus(state: RewindState, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  if (!state.gitAvailable) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const theme = ctx.ui.theme;
  const count = state.checkpoints.size;
  const label = i18n.t(count === 1 ? "checkpointCount" : "checkpointCountPlural", { count });
  ctx.ui.setStatus(
    STATUS_KEY,
    theme.fg("dim", "◆ ") + theme.fg("muted", label),
  );
}

/** Clear status */
export function clearStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
}
