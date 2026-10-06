import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks resource loading/session construction performed for a subagent. This is
 * async-context-local so concurrent top-level extension work is unaffected.
 */
// Pi may evaluate the same package again while loading a child's extensions.
// Share the ALS instance across those module copies, not the per-request value.
const CONTEXT_KEY = Symbol.for("pi-subagents:child-context");
const contexts = globalThis as typeof globalThis & { [CONTEXT_KEY]?: AsyncLocalStorage<boolean> };
const childSessionContext = contexts[CONTEXT_KEY] ??= new AsyncLocalStorage<boolean>();

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

export function runInChildSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}
