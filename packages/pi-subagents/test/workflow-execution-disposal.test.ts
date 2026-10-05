import { expect, it } from "vitest";
import { ConsumerCancellation, executionFixture, flush } from "./helpers/workflow-execution.js";

it.each(["backend shutdown", "child abort listener"] as const)("publishes one awaited disposal barrier before reentrant %s", async path => {
  const f = executionFixture();
  const ready = f.gate();
  const callback = f.gate();
  const shutdown = f.gate();
  const host = f.host();
  let reentered: Promise<void> | undefined;
  let completed = false;
  f.backend.shutdown.mockImplementationOnce(() => {
    if (path === "backend shutdown") reentered = host.dispose();
    return shutdown.promise;
  });
  const task = host.spawnChild({ prompt: "work", withSession: async child => {
    if (path === "child abort listener") child.signal!.addEventListener("abort", () => { reentered = host.dispose(); }, { once: true });
    ready.resolve();
    await callback.promise;
  } });
  const cancelled = expect(task).rejects.toBeInstanceOf(ConsumerCancellation);
  try {
    await ready.promise;
    const closing = host.dispose();
    expect(reentered).toBe(closing);
    expect(host.dispose()).toBe(closing);
    void closing.then(() => { completed = true; });
    await cancelled;
    await flush();
    expect(completed).toBe(false);
    expect(f.backend.shutdown).toHaveBeenCalledExactlyOnceWith(f.handles[0]);
    shutdown.resolve();
    await closing;
    expect(completed).toBe(true);
  } finally {
    shutdown.resolve();
    callback.resolve();
    await f.close();
    await cancelled;
  }
});
