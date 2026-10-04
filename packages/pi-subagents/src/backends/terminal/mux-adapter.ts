import * as mux from "pi-terminal-mux";
import { i18n } from "../../i18n.js";
import { createTerminalArtifacts } from "./artifacts.js";
import type { TerminalDependencies, TerminalTransport } from "./types.js";

export type TerminalMuxApi = Pick<typeof mux,
  "createSurface" | "clearLastSplitSource" | "sendLongCommand" | "sendEscape" | "closeSurface" | "pollForExit"
>;

/** The foundation owns backend detection, shell scripts, exit sidecars and headless fallback. */
export function createTerminalTransport(api: TerminalMuxApi = mux): TerminalTransport {
  return {
    createSurface(name) {
      const surface = api.createSurface(name);
      api.clearLastSplitSource();
      return surface;
    },
    sendCommand(surface, command, scriptPath, interpreter) {
      api.sendLongCommand(surface, command, { scriptPath, ...(interpreter ? { interpreter } : {}) });
    },
    sendEscape: (surface) => api.sendEscape(surface),
    closeSurface: (surface) => api.closeSurface(surface),
    waitForExit: (surface, signal, options) => api.pollForExit(surface, signal, {
      interval: 1_000,
      sessionFile: options.sessionFile,
      onTick: options.onTick,
    }),
  };
}

export function waitForShellReady(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException(i18n.t("terminal.cancelled"), "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException(i18n.t("terminal.cancelled"), "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Does not create a surface, process, watcher or timer until a run is explicitly launched. */
export function createTerminalDependencies(): TerminalDependencies {
  return {
    transport: createTerminalTransport(),
    artifacts: createTerminalArtifacts(),
    now: Date.now,
    delay: waitForShellReady,
  };
}
