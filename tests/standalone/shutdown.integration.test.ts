/**
 * Closing the standalone runtime while its own scheduler is running a
 * companion-internal turn: the turn is interrupted and recorded as
 * interrupted by shutdown. Close does not wait for the model to finish.
 */
import { describe, expect, it } from 'vitest';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { say, withDefaults } from '../pi/faux-brain.ts';
import { archived, selfScope, unwrap, useStandalone } from './standalone-world.ts';

describe.skipIf(dockerTestsOptedOut('standalone'))('standalone shutdown over Postgres', () => {
  const lite = useStandalone();

  it('interrupts a free-time turn the scheduler loop is running, and records it as shutdown', async () => {
    const install = await lite.install();
    (install.document as { scheduler: { tickIntervalMs: number } }).scheduler.tickIntervalMs = 1_000;
    let started: () => void = () => undefined;
    const thinking = new Promise<void>((resolve) => {
      started = resolve;
    });
    // Streams for well over a minute at this rate, so only an interruption ends it in time.
    const slow = 'Let me think slowly about the options. '.repeat(20_000);
    const brain = withDefaults((call) => {
      if (/Free time is open/.test(call.lastUser)) {
        started();
        return say(slow);
      }
      return say('ok');
    });
    const { runtime } = await lite.start(install, brain, 'process-a', { tokensPerSecond: 2_000 });
    runtime.startScheduler();
    await thinking;
    expect(runtime.harness.activeTurns()).toBe(1);
    await lite.stop(runtime);
    expect(runtime.harness.activeTurns()).toBe(0);

    const { runtime: after } = await lite.start(install, withDefaults(() => say('ok')), 'process-b');
    const self = await selfScope(after);
    const session = unwrap(await after.stacks.sessions.current(self));
    const history = await archived(after, session.sessionId);
    expect(history[0]).toMatchObject({ origin: 'system_note', text: expect.stringContaining('Free time is open') as unknown });
    expect(history.at(-1)).toEqual({ origin: 'system_note', text: 'turn interrupted by shutdown' });
    const partial = history.find((e) => e.origin === 'companion_speech');
    expect(partial === undefined || partial.text.length < slow.trim().length).toBe(true);
  }, 60_000);
});
