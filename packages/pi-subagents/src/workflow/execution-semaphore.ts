/** FIFO invocation capacity. Callers release before entering workflow routing callbacks. */
export class ExecutionSemaphore {
  private active = 0;
  private queue: { signal: AbortSignal; grant(): void; cancel(): void }[] = [];

  constructor(private readonly limit: number, private readonly aborted: (signal: AbortSignal) => Error) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(this.aborted(signal));
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        grant: () => {
          signal.removeEventListener("abort", entry.cancel);
          this.active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            this.drain();
          });
        },
        cancel: () => {
          this.queue = this.queue.filter(candidate => candidate !== entry);
          signal.removeEventListener("abort", entry.cancel);
          reject(this.aborted(signal));
        },
      };
      if (this.active < this.limit) entry.grant();
      else {
        this.queue.push(entry);
        signal.addEventListener("abort", entry.cancel, { once: true });
      }
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.signal.aborted) entry.cancel();
      else entry.grant();
    }
  }
}
