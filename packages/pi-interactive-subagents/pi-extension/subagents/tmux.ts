/** Compatibility imports for existing consumers; terminal ownership lives in mux. */
export {
  isMuxAvailable, muxSetupHint, createSurface, sendCommand, sendLongCommand,
  pollForExit, closeSurface, shellEscape, readScreen, readScreenAsync,
} from "@kevinhao/pi-terminal-mux";
