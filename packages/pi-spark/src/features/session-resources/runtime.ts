import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, TUI } from "@earendil-works/pi-tui";
import { ResourceIndex } from "./collector.ts";
import { isFullscreenTui, SessionResourceEditor } from "./picker.ts";

/** Shared resource index used by the spark editor picker. */
export class SessionResourceRuntime {
  readonly index = new ResourceIndex();
  enabled = true;

  list() {
    return this.index.list();
  }
}

let runtime: SessionResourceRuntime | undefined;

/** Returns the runtime created when the feature registers. */
export function getSessionResourceRuntime(): SessionResourceRuntime | undefined {
  return runtime;
}

/** Creates the process-wide runtime once. Later calls return the same instance. */
export function ensureSessionResourceRuntime(): SessionResourceRuntime {
  runtime ??= new SessionResourceRuntime();
  return runtime;
}

/** Wraps spark's editor with the session-resource picker owned by the same package. */
export function wrapSessionResourceEditor(
  base: EditorComponent,
  ctx: ExtensionContext,
  tui: TUI,
  keybindings: KeybindingsManager,
): EditorComponent {
  const resources = getSessionResourceRuntime();
  if (!resources) return base;
  return new SessionResourceEditor(base, {
    theme: ctx.ui.theme,
    keybindings,
    getResources: () => resources.list(),
    isEnabled: () => resources.enabled,
    isMouseEnabled: () => isFullscreenTui(tui),
    requestRender: () => tui.requestRender(),
  });
}
