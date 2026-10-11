/** Terminal surface API for tmux, Orca, and headless processes. */
export * from "./mux.ts";

export {
  AGENT_ORCA_TERMINAL_HANDLE,
  isOrcaRuntimeAvailable,
  parseOrcaJson,
  extractOrcaCreateHandle,
  extractOrcaSplitHandle,
  extractOrcaReadTail,
  orcaSplitDirection,
  createOrcaSurface,
  splitOrcaTerminal,
  sendOrcaCommand,
  sendOrcaEscape,
  readOrcaScreen,
  parseOrcaTerminalTabInfo,
  decideOrcaCloseStep,
  closeOrcaSurface,
  renameOrcaTerminal,
} from "./orca.ts";
export type { OrcaEnvelope, OrcaTerminalState, OrcaCloseDecision } from "./orca.ts";

import { getMuxBackend, type MuxBackend } from "./mux.ts";
import { AGENT_ORCA_TERMINAL_HANDLE } from "./orca.ts";

export function backendAgentPaneEnvVar(backend: MuxBackend): string {
  return backend === "tmux" ? "TMUX_PANE" : "ORCA_TERMINAL_HANDLE";
}

/** Orca's caller handle is captured at module load, independently of UI focus. */
export function getAgentPaneId(backend?: MuxBackend | null): string | null {
  const resolved = backend === undefined ? getMuxBackend() : backend;
  if (resolved === "tmux") return process.env.TMUX_PANE ?? null;
  if (resolved === "orca") return AGENT_ORCA_TERMINAL_HANDLE ?? null;
  return null;
}
