/**
 * The scheduler timer. The next tick is scheduled only after the previous
 * one finished, so a slow tick never overlaps the next one from this
 * process (core still fences overlap across processes). `stop` cancels the
 * timer and waits for a tick in progress.
 */
export interface TickLoop {
  start(): void;
  stop(): Promise<void>;
}

export function createTickLoop(input: { readonly intervalMs: number; readonly tick: () => Promise<void> }): TickLoop {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      running = input.tick().finally(() => {
        running = null;
        schedule();
      });
    }, input.intervalMs);
    timer.unref();
  };
  return {
    start: schedule,
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}
