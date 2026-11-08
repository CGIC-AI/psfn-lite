/**
 * Internal activity through the Pi host ports: free time in companion-
 * internal turns (`InternalTurnPort`) and bounded workers (`WorkerHostPort`),
 * each over the real core lifecycle and the faux model.
 */
import { describe, expect, it } from 'vitest';
import type { FreeTimeLaneStatus, WorkerRun } from '../../packages/core/src/index.ts';
import { callTool, say, withDefaults, type BrainCall } from './faux-brain.ts';
import { history, piWorld } from './pi-world.ts';

/** The companion's free-time script: choose reflection when invited, write it when the time comes. */
function freeTime(call: BrainCall) {
  const invitation = /Free time is open[\s\S]*blockId (\S+)\)/.exec(call.lastUser);
  if (invitation !== null) return call.afterTool ? say('I will reflect.') : callTool('free_time', 'choose', { blockId: invitation[1], optionId: 'reflect' });
  if (call.lastUser.includes('Your free time (block')) return say('Today felt unhurried; I kept returning to the tide pools.');
  return say('ok');
}

describe('internal activity through the Pi harness', () => {
  it('runs free time in internal turns: the companion chooses to reflect and the reflection is its own record', async () => {
    const w = await piWorld(withDefaults(freeTime));
    const self = await w.admit('free-time');
    const tick = await w.stack.scheduler.tick(self);
    if (!tick.ok) throw new Error(JSON.stringify(tick.error));
    const ran = tick.value.freeTime.find((r) => r.ok && r.value.kind === 'ran');
    expect(ran?.ok && ran.value.kind === 'ran' && ran.value.block).toMatchObject({ lane: 'idle', state: 'completed', choice: { optionId: 'reflect' } });

    const reflections = await w.must<{ id: string; text: string; kind: string }[]>(self, 'journal', 'reflections_list', { limit: 5 });
    expect(reflections).toMatchObject([{ kind: 'companion_reflection', text: 'Today felt unhurried; I kept returning to the tide pools.' }]);

    // Both internal turns are in the self session, with system-note triggers and the companion's replies.
    const session = await w.sessions.current(self);
    if (!session.ok) throw new Error('session');
    const entries = await history(w, session.value.sessionId);
    expect(entries.map((e) => e.origin)).toEqual(['system_note', 'companion_speech', 'system_note', 'companion_speech']);
    expect(entries[0]?.text).toContain('Free time is open');
    expect(entries[3]?.text).toBe('Today felt unhurried; I kept returning to the tide pools.');

    const status = await w.must<FreeTimeLaneStatus[]>(self, 'free_time', 'status');
    expect(status.find((s) => s.lane === 'idle')?.recent.map((b) => b.state)).toEqual(['completed']);
    // The invitation turn was a self turn: its tools ran under the internal scope, so free_time.choose was admitted.
    const invitation = w.model.calls.find((c) => c.kind === 'companion' && c.afterTool);
    expect(invitation?.toolResults[0]).toContain('"state":"chosen"');
  });

  it('runs a worker through the Pi worker host with only its granted tools, and binds the summary to the run', async () => {
    const w = await piWorld(
      withDefaults((call) => {
        if (call.kind === 'worker') return call.afterTool ? say('Searched memory: nothing about tide pools yet.') : callTool('memory', 'search', { query: 'tide pools' });
        if (call.afterTool) return say('I asked a worker to look.');
        return callTool('automata', 'spawn', { spawnId: 'look-1', label: 'look', task: 'Look for tide pool memories', actions: ['memory.search'], maxTurns: 3, maxSensitivity: 'personal' });
      }),
    );
    const report = await w.harness.converse({ evidence: 'primary-dm', text: 'ask a worker', idempotencyKey: 'k-1' });
    if (!report.ok) throw new Error(JSON.stringify(report.error));
    expect(report.value.reply).toBe('I asked a worker to look.');

    const worker = w.model.calls.filter((c) => c.kind === 'worker');
    expect(worker).toHaveLength(2);
    expect(worker[0]?.context.tools?.map((t) => t.name)).toEqual(['memory']);
    expect(JSON.stringify(worker[0]?.context.tools?.[0]?.parameters)).not.toContain('"write"');
    expect(worker[0]?.lastUser).toContain('[system note: worker task]\nLook for tide pool memories');

    const [run] = [...w.activity.workerRuns.runs.values()] as WorkerRun[];
    expect(run).toMatchObject({
      status: 'completed',
      outcome: 'completed',
      result: { summary: 'Searched memory: nothing about tide pools yet.', author: { kind: 'machine' } },
      accounting: { turnsUsed: 2, modelCalls: 2 },
    });
    const activity = await w.activity.activities.get(run?.activityId as never);
    expect(activity.ok && activity.value).toMatchObject({ status: 'completed', outcome: 'Searched memory: nothing about tide pools yet.' });
    expect(w.diagnostics).toEqual([]);
  });

  it('ends a worker at its turn budget and reports it as budget limited', async () => {
    const w = await piWorld(
      withDefaults((call) => {
        if (call.kind === 'worker') return callTool('memory', 'search', { query: 'more' });
        if (call.afterTool) return say('spawned');
        return callTool('automata', 'spawn', { spawnId: 'loop-1', label: 'loop', task: 'Search forever', actions: ['memory.search'], maxTurns: 2, maxSensitivity: 'personal' });
      }),
    );
    const report = await w.harness.converse({ evidence: 'primary-dm', text: 'go', idempotencyKey: 'k-1' });
    expect(report.ok && report.value.status).toBe('completed');
    const [run] = [...w.activity.workerRuns.runs.values()];
    expect(run).toMatchObject({ status: 'failed', outcome: 'budget_limited', accounting: { turnsUsed: 2 } });
  });
});
