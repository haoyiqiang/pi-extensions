import type { AgentSession } from "@earendil-works/pi-coding-agent";

const CHILD_SHUTDOWN_TIMEOUT_MS = 3_000;
const shutdowns = new WeakMap<AgentSession, Promise<void>>();

/** Delivery stays awaitable for tools; UI callers may deliberately swallow errors. */
export async function steerEmbeddedSession(session: AgentSession, message: string): Promise<void> {
  await session.steer(message);
}

/** Emit shutdown before invalidating the extension runtime; eviction and quit share this path. */
export function shutdownEmbeddedSession(session: AgentSession | undefined): Promise<void> {
  if (!session) return Promise.resolve();
  const existing = shutdowns.get(session);
  if (existing) return existing;
  // Store before invoking handlers, which can re-enter cleanup synchronously.
  // Start immediately: sessions without handlers have always disposed synchronously.
  let complete!: () => void;
  const shutdown = new Promise<void>((resolve) => { complete = resolve; });
  shutdowns.set(session, shutdown);
  void closeSession(session).then(complete, complete);
  return shutdown;
}

async function closeSession(session: AgentSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const runner = session.extensionRunner;
    if (runner?.hasHandlers?.("session_shutdown")) {
      await Promise.race([
        runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    }
  } catch {
    // Partial sessions and failing handlers must not block teardown.
  } finally {
    if (timer) clearTimeout(timer);
    try { session.dispose?.(); } catch { /* best-effort teardown */ }
  }
}
