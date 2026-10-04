/**
 * Compatibility entrypoint for upstream callers and regression fixtures.
 * The actual Pi session implementation lives in the embedded backend.
 */
export * from "./backends/embedded.js";
