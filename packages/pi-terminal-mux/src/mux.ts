/** Shared API barrel; retains the ./mux subpath. */
export {
  type MuxBackend,
  getMuxBackend,
  isMuxAvailable,
  muxSetupHint,
  muxLog,
  isTmuxAvailable,
  isOrcaAvailable,
} from "./detection.ts";

export {
  createHeadlessSurface,
  spawnHeadlessProcess,
  closeHeadlessSurface,
  sendHeadlessEscape,
  readHeadlessScreen,
  readHeadlessScreenAsync,
  isHeadlessSurface,
  isHeadlessMode,
  cleanupHeadlessProcesses,
  getHeadlessProcessExit,
  drainHeadlessProcess,
} from "./headless.ts";

export { isFishShell, shellEscape, exitStatusVar } from "./shell.ts";

export {
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendEscape,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  surfaceState,
  renameSurface,
  getRenameCapability,
  renameCurrentTab,
  renameWorkspace,
  pollForExit,
  getLastSplitSource,
  clearLastSplitSource,
} from "./surface.ts";
export type {
  PollResult,
  CreateSurfaceOptions,
  CreateSurfaceSplitOptions,
  SendLongCommandOptions,
  RenameOperation,
  RenameTarget,
  RenameBackend,
  RenameCapability,
  RenameResult,
} from "./surface.ts";
export type { SurfaceState } from "./backends/types.ts";

export {
  TERMINAL_RENAME_CONTEXT_ENV,
  createSurfaceRenameContext,
  readSurfaceRenameContext,
  resolveTerminalRenameTargets,
  renameTerminalTarget,
} from "./rename.ts";
export type {
  SurfaceRenameContext,
  TerminalRenameTarget,
  TerminalRenameOutcome,
  ResolveRenameOptions,
  RenameCommandRunner,
} from "./rename.ts";
