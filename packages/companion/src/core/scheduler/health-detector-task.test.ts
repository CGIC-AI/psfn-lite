import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { createRuntimeHealthDetectorScheduler } from './health-detector-task.js';

afterEach(() => vi.useRealTimers());

describe('runtime health watchdog scheduling', () => {
  it('never overlaps detector runs and drains the active run before stopping', async () => {
    vi.useFakeTimers();
    let release = (): void => undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const run = vi.fn(() => pending);
    const watchdog = createRuntimeHealthDetectorScheduler({
      eventBus: new EventBus(),
      source: { owner: { kind: 'system' }, process: 'agent' },
      intervalMs: 1_000,
      cycle: { run },
    });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = watchdog.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });
});
