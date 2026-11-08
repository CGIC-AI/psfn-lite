import { describe, expect, it } from 'vitest';
import {
  BASELINE_FREE_TIME_POLICY,
  createSelfStateContext,
  evaluateFreeTimeGate,
  ok,
  parseFreeTimePolicy,
  unavailable,
  type ActivityRecord,
  type FreeTimeBlock,
  type FreeTimeLaneStatus,
  type InternalTurnRequest,
  type TrustedTurnScope,
} from '../../packages/core/src/index.ts';
import { fakeActivityWorld } from './activity-world.ts';
import { kindOf } from './memory-world.ts';

type World = Awaited<ReturnType<typeof fakeActivityWorld>>;
const HOUR = 3_600_000;

/** Inference the stack asked for: companion turns, template model calls and worker attempts. */
const inference = (w: World) => w.internalTurns.requests.length + w.templateModel.calls.length + w.workerHost.sessions.length;

/** The companion, in its invitation turn, does `act` with the block it was offered. */
function companionDoes(w: World, act: (scope: TrustedTurnScope, blockId: string, request: InternalTurnRequest) => Promise<unknown>, reply: string | null = null) {
  w.internalTurns.script = async (request) => {
    if (request.prompt.startsWith('Free time is open')) await act(request.scope, request.reference.id, request);
    return ok({ status: 'completed', reply });
  };
}

async function tickTimes(w: World, scope: TrustedTurnScope, times: number, stepMs: number) {
  for (let i = 0; i < times; i += 1) {
    const tick = await w.scheduler.tick(scope);
    if (!tick.ok) throw new Error(JSON.stringify(tick.error));
    w.clock.advance(stepMs);
  }
}

const blocks = (w: World): FreeTimeBlock[] => [...w.freeTimeBlocks.blocks.values()];

describe('free time', () => {
  it('invites once, respects a decline durably and makes no model call while quiet', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    companionDoes(w, (scope, blockId) => w.must(scope, 'free_time', 'rest', { blockId }));
    await tickTimes(w, self, 1, 0);
    expect(w.internalTurns.requests).toHaveLength(1);
    expect(blocks(w).map((b) => b.state)).toEqual(['rested']);
    expect(w.restState.lanes.get('idle')?.kind).toBe('companion_rested');
    expect(w.restState.lanes.get('quiet_hours')?.kind).toBe('companion_rested');

    // Twelve ticks over the next five hours, through quiet hours: no invitation and no inference at all.
    await tickTimes(w, self, 12, 25 * 60_000);
    expect(inference(w)).toBe(1);
    const status = await w.must<FreeTimeLaneStatus[]>(self, 'free_time', 'status');
    expect(status.map((s) => [s.lane, s.gate])).toEqual([
      ['quiet_hours', { kind: 'ineligible', reason: 'silenced' }],
      ['idle', { kind: 'ineligible', reason: 'silenced' }],
    ]);
    expect(status[0]?.rest).toMatchObject({ madeBy: 'companion', active: true });

    // Once the rest has run out, the next tick may invite again, exactly once.
    w.clock.advance(2 * HOUR);
    companionDoes(w, (scope, blockId) => w.must(scope, 'free_time', 'defer', { blockId, minutes: 60 }));
    await tickTimes(w, self, 3, 60_000);
    expect(w.internalTurns.requests).toHaveLength(2);
    expect(blocks(w).filter((b) => b.state === 'deferred')).toHaveLength(1);
  });

  it('invites once when two scheduler passes overlap', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    const [a, b] = await Promise.all([w.scheduler.tick(self), w.scheduler.tick(self)]);
    if (!a.ok || !b.ok) throw new Error('tick');
    expect(blocks(w)).toHaveLength(1);
    expect(w.internalTurns.requests).toHaveLength(1);
    const reports = [...a.value.freeTime, ...b.value.freeTime].flatMap((r) => (r.ok ? [r.value] : []));
    expect(reports.filter((r) => r.kind === 'ran')).toHaveLength(1);
    expect(reports.filter((r) => r.kind === 'skipped' && r.reason === 'invitation_open').length).toBeGreaterThan(0);
    // The store refuses a second open block directly as well.
    const open = blocks(w)[0] as FreeTimeBlock;
    w.freeTimeBlocks.blocks.set(open.id, { ...open, state: 'invited' });
    const second = await w.freeTimeBlocks.create({ ...open, id: 'free_time_block:other', state: 'invited' });
    expect(second.ok || second.error).toMatchObject({ kind: 'conflict', reason: 'turn_already_open' });
  });

  it('lets an unanswered invitation lapse without inventing a decision and without re-asking', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    await tickTimes(w, self, 1, 0);
    expect(blocks(w)[0]).toMatchObject({ state: 'lapsed', choice: null });
    expect(w.restState.lanes.size).toBe(0);
    await tickTimes(w, self, 10, 10 * 60_000);
    expect(w.internalTurns.requests).toHaveLength(1);
  });

  it('records a failed invitation as a system failure, never as rest the companion chose', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    w.internalTurns.script = () => Promise.resolve(unavailable('harness', 'model provider down'));
    await tickTimes(w, self, 1, 0);
    expect(blocks(w)[0]).toMatchObject({ state: 'failed', failure: 'invitation turn could not run: unavailable', choice: null });
    expect(w.restState.lanes.get('idle')).toMatchObject({ kind: 'system_failure', reason: 'invitation turn could not run: unavailable' });
    const status = await w.must<FreeTimeLaneStatus[]>(self, 'free_time', 'status');
    expect(status.find((s) => s.lane === 'idle')?.rest).toMatchObject({ madeBy: 'system_failure' });
    await tickTimes(w, self, 5, 10 * 60_000);
    expect(w.internalTurns.requests).toHaveLength(1);
  });

  it('runs the chosen activity in the companion turn and keeps its reflection as the companion’s own', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    companionDoes(w, async (scope, blockId) => {
      const invented = await w.call(scope, 'free_time', 'choose', { blockId, optionId: 'resume:somewhere-else' });
      expect(kindOf(invented)).toBe('invalid');
      await w.must(scope, 'free_time', 'choose', { blockId, optionId: 'reflect' });
    }, 'The quiet made it easier to notice what I care about.');
    await tickTimes(w, self, 1, 0);
    const [first, second] = w.internalTurns.requests;
    expect(first?.prompt.startsWith('Free time is open')).toBe(true);
    expect(second?.prompt.startsWith('Your free time')).toBe(true);
    expect(second?.reference).toEqual(first?.reference);
    const [block] = blocks(w);
    expect(block).toMatchObject({ state: 'completed', choice: { optionId: 'reflect' } });
    const activity = w.activities.records.get(block?.activityId ?? ('' as never)) as ActivityRecord;
    expect(activity).toMatchObject({ status: 'completed', visibility: { kind: 'self' }, artifacts: [{ kind: 'reflection', ref: `free_time:${block?.id ?? ''}` }] });
    expect(activity.notes).toEqual([{ author: { kind: 'companion' }, text: 'The quiet made it easier to notice what I care about.' }]);

    // The reflection store backs the self-model's reflection port: it returns as authored reflection in a self turn.
    const context = createSelfStateContext({ emotion: w.emotion, concerns: w.concerns, followUps: w.followUps, values: w.values, reflections: w.reflections });
    const built = await context.build(self, { limit: 5 });
    expect(built.ok && built.value.filter((e) => e.origin.kind === 'authored_reflection').map((e) => e.text)).toEqual([
      'The quiet made it easier to notice what I care about.',
    ]);
    const primary = await context.build(await w.admit('primary-dm'), { limit: 5 });
    expect(primary.ok && primary.value.some((e) => e.text.includes('quiet made it easier'))).toBe(false);
  });

  it('keeps choice and rest to companion-internal turns and status to confidential admission', async () => {
    const w = await fakeActivityWorld();
    const primary = await w.admit('primary-dm');
    const friend = await w.admit('friend-dm');
    expect((await w.call(primary, 'free_time', 'rest', {})).ok || (await w.call(primary, 'free_time', 'rest', {}))).toMatchObject({
      error: { kind: 'denied', reason: 'requires_self_audience' },
    });
    expect(kindOf(await w.call(primary, 'free_time', 'status'))).toBe('ok');
    expect((await w.call(friend, 'free_time', 'status')).ok).toBe(false);
  });

  it('fails closed when rest state cannot be read, and holds back during partner activity', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    w.restState.unavailable = true;
    const blocked = await w.freeTime.runLane(self, 'idle');
    expect(blocked.ok && blocked.value).toEqual({ lane: 'idle', kind: 'skipped', reason: 'rest_state_unavailable' });
    w.restState.unavailable = false;
    await w.converse(await w.admit('primary-dm'), 'hi', 'hello', 'k-1');
    const busy = await w.freeTime.runLane(self, 'idle');
    expect(busy.ok && busy.value).toEqual({ lane: 'idle', kind: 'skipped', reason: 'recent_partner_activity' });
    expect(w.internalTurns.requests).toHaveLength(0);
  });

  it('marks an activity a crash cut off as interrupted, never re-runs it, and offers to resume it', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    companionDoes(w, (scope, blockId) => w.must(scope, 'free_time', 'choose', { blockId, optionId: 'wander' }));
    // The activity turn never returns: the process dies while it runs.
    const original = w.internalTurns.script;
    w.internalTurns.script = async (request) => {
      if (request.prompt.startsWith('Your free time')) throw new Error('crash');
      return original(request);
    };
    await expect(w.freeTime.runLane(self, 'idle')).rejects.toThrow('crash');
    expect(blocks(w)[0]?.state).toBe('executing');

    w.internalTurns.script = () => Promise.resolve(ok({ status: 'completed', reply: null }));
    // Past the block lease (so the block is stale) and past the minimum interval (so a new invitation may open).
    w.clock.advance(Math.max(BASELINE_FREE_TIME_POLICY.blockLeaseMinutes, BASELINE_FREE_TIME_POLICY.minIntervalMinutes) * 60_000 + 1);
    const before = w.internalTurns.requests.length;
    const after = await w.freeTime.runLane(self, 'idle');
    expect(blocks(w).find((b) => b.choice?.optionId === 'wander')?.state).toBe('interrupted');
    const wander = blocks(w).find((b) => b.choice?.optionId === 'wander');
    expect(w.activities.records.get(wander?.activityId ?? ('' as never))?.status).toBe('interrupted');
    expect(w.internalTurns.requests.length - before).toBe(1);
    // That one new turn was an invitation, and the interrupted activity is on its menu.
    expect(after.ok && after.value.kind === 'ran' && after.value.block.options.some((o) => o.kind === 'resume_project')).toBe(true);
  });
});

describe('free-time gate and policy', () => {
  const at = Date.parse('2030-01-01T03:00:00.000Z');
  const input = { lane: 'quiet_hours' as const, nowMs: at, policy: BASELINE_FREE_TIME_POLICY, rest: null, latest: null, blocksToday: 0, partnerActiveAtMs: null, resumable: [] };

  it('closes in order and offers only the fixed menu', () => {
    expect(evaluateFreeTimeGate(input)).toMatchObject({ kind: 'eligible', options: [{ optionId: 'rest' }, { optionId: 'reflect' }, { optionId: 'wander' }, { optionId: 'begin_new' }] });
    expect(evaluateFreeTimeGate({ ...input, nowMs: Date.parse('2030-01-01T12:00:00.000Z') })).toEqual({ kind: 'ineligible', reason: 'outside_quiet_hours' });
    expect(evaluateFreeTimeGate({ ...input, blocksToday: 3 })).toEqual({ kind: 'ineligible', reason: 'daily_cap' });
    expect(evaluateFreeTimeGate({ ...input, partnerActiveAtMs: at - 60_000 })).toEqual({ kind: 'ineligible', reason: 'recent_partner_activity' });
    expect(evaluateFreeTimeGate({ ...input, rest: 'unavailable' })).toEqual({ kind: 'ineligible', reason: 'rest_state_unavailable' });
  });

  it('validates owner policy strictly', () => {
    expect(parseFreeTimePolicy(BASELINE_FREE_TIME_POLICY).ok).toBe(true);
    const bad = parseFreeTimePolicy({ ...BASELINE_FREE_TIME_POLICY, timeZone: 'Mars/Olympus', maxBlocksPerDay: 0, extra: 1 });
    expect(bad.ok || bad.error).toMatchObject({ kind: 'invalid' });
    expect(!bad.ok && bad.error.kind === 'invalid' && bad.error.issues.length).toBe(3);
    expect(kindOf(parseFreeTimePolicy({ ...BASELINE_FREE_TIME_POLICY, quietHours: { start: '02:00', end: '02:00' } }))).toBe('invalid');
  });
});
