import { describe, expect, it } from 'vitest';
import type { ActivityRecord, WorkerRun, WorkerRunId, WorkerSession } from '../../packages/core/src/index.ts';
import { WORKER_LEASE_MS, fakeActivityWorld } from './activity-world.ts';
import { kindOf } from './memory-world.ts';

type World = Awaited<ReturnType<typeof fakeActivityWorld>>;

const RESEARCH = {
  spawnId: 'spawn-1',
  label: 'research',
  task: 'Collect three sources on tide pools',
  actions: ['memory.write', 'memory.search', 'memory.scratchpad_add', 'activity.update'],
  maxTurns: 3,
  maxSensitivity: 'personal',
};

async function spawn(w: World, token = 'primary-dm', args: Record<string, unknown> = RESEARCH) {
  const scope = await w.admit(token);
  const spawned = await w.must<{ run: WorkerRun; created: boolean }>(scope, 'automata', 'spawn', args);
  return { scope, run: spawned.run, created: spawned.created, session: w.workerHost.latest() };
}

const write = (writeId: string, extra: Record<string, unknown> = {}) => ({
  tool: 'memory',
  action: 'write',
  args: { writeId, kind: 'fact', content: 'Tide pools hold anemones', sensitivity: 'personal', ...extra },
});

const usage = { modelCalls: 1, inputTokens: 10, outputTokens: 5 };

async function finish(session: WorkerSession, outcome: 'completed' | 'blocked' | 'cancelled' | 'budget_limited' = 'completed') {
  const done = await session.finish({ outcome, summary: 'Found three sources', artifacts: [{ kind: 'note', ref: 'sources-1' }], reason: null, usage });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  return done.value;
}

describe('bounded workers', () => {
  it('narrows the grant to the parent turn and refuses rather than trims a wider one', async () => {
    const w = await fakeActivityWorld();
    const primary = await w.admit('primary-dm');
    const friend = await w.admit('friend-dm');
    const deletion = await w.call(primary, 'automata', 'spawn', { ...RESEARCH, spawnId: 's-del', actions: ['memory.propose_delete'] });
    expect(deletion.ok || deletion.error).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });
    const nested = await w.call(primary, 'automata', 'spawn', { ...RESEARCH, spawnId: 's-nest', actions: ['automata.spawn'] });
    expect(kindOf(nested)).toBe('denied');
    // A trusted friend's DM admits public and personal only; an intimate ceiling is wider than the parent.
    const wider = await w.call(friend, 'automata', 'spawn', { ...RESEARCH, spawnId: 's-wide', maxSensitivity: 'intimate' });
    expect(wider.ok || wider.error).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });
    expect(w.workerRuns.runs.size).toBe(0);

    const { session, run } = await spawn(w);
    expect(run.status).toBe('running');
    expect(session.scope.admitted).toEqual(['public', 'personal']);
    expect(session.scope.audience).toEqual(primary.audience);
    expect(session.scope.caller).toMatchObject({ kind: 'worker', runId: run.id, parent: { kind: 'participant' } });
    const outside = await session.call('c-1', { tool: 'memory', action: 'restore', args: { memoryId: 'memory-1' } });
    expect(outside.ok || outside.error).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });
    const notGranted = await session.call('c-2', { tool: 'session', action: 'list', args: {} });
    expect(notGranted.ok || notGranted.error).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });
  });

  it('replays a duplicate spawn, refuses a reused key and namespaces keys by conversation', async () => {
    const w = await fakeActivityWorld();
    const first = await spawn(w);
    const again = await spawn(w);
    expect(again.created).toBe(false);
    expect(again.run.id).toBe(first.run.id);
    expect(w.workerHost.sessions).toHaveLength(1);
    const reused = await w.call(first.scope, 'automata', 'spawn', { ...RESEARCH, task: 'something else' });
    expect(reused.ok || reused.error).toMatchObject({ kind: 'conflict', reason: 'idempotency_mismatch' });
    const elsewhere = await spawn(w, 'friend-dm');
    expect(elsewhere.run.id).not.toBe(first.run.id);
  });

  it('binds the result and its activity to the source turn, and reports completion', async () => {
    const w = await fakeActivityWorld();
    const { scope, run, session } = await spawn(w);
    expect(run.source).toMatchObject({ audience: scope.audience, principal: { kind: 'participant', contactId: w.people.primary }, trigger: 'request' });
    const pending = await w.must<{ settled: boolean }>(scope, 'automata', 'wait', { runId: run.id });
    expect(pending.settled).toBe(false);
    const turn = await session.beginTurn();
    expect(turn.ok && turn.value).toMatchObject({ kind: 'turn', turn: 1 });

    const settled = await finish(session);
    expect(settled).toMatchObject({ status: 'completed', outcome: 'completed', result: { summary: 'Found three sources', author: { kind: 'machine', producer: `worker:${run.id}` } } });
    expect(settled.accounting).toMatchObject({ turnsUsed: 1, modelCalls: 1, inputTokens: 10, outputTokens: 5 });
    const waited = await w.must<{ settled: boolean; run: WorkerRun }>(scope, 'automata', 'wait', { runId: run.id });
    expect(waited.settled).toBe(true);

    // What happened is answerable at once from the activity record, with no extraction pass.
    const activity = await w.must<ActivityRecord>(scope, 'activity', 'get', { activityId: run.activityId });
    expect(activity).toMatchObject({
      status: 'completed',
      outcome: 'Found three sources',
      artifacts: [{ kind: 'note', ref: 'sources-1' }],
      source: { workerRunId: run.id },
      visibility: scope.audience,
    });
    const recent = await w.must<ActivityRecord[]>(scope, 'activity', 'recent', {});
    expect(recent.map((a) => a.id)).toContain(run.activityId);

    // A late or repeated finish replays instead of settling twice.
    const replay = await session.finish({ outcome: 'completed', summary: 'Found three sources', artifacts: [], reason: null, usage });
    expect(replay.ok && replay.value.revision).toBe(settled.revision);
    const different = await session.finish({ outcome: 'blocked', summary: 'other', artifacts: [], reason: null, usage });
    expect(different.ok || different.error).toMatchObject({ kind: 'conflict', reason: 'turn_already_settled' });
    const late = await session.beginTurn();
    expect(late.ok || late.error).toMatchObject({ kind: 'conflict', reason: 'turn_ownership' });
  });

  it('withholds a run from other conversations and shows it to companion turns', async () => {
    const w = await fakeActivityWorld();
    const { run } = await spawn(w);
    const friend = await w.admit('friend-dm');
    for (const action of ['wait', 'inspect', 'cancel', 'status']) {
      const result = await w.call(friend, 'automata', action, { runId: run.id });
      expect(result.ok || result.error, action).toEqual({ kind: 'not_found', subject: `worker run ${run.id}` });
    }
    const listed = await w.must<{ active: WorkerRun[] }>(friend, 'automata', 'status', {});
    expect(listed.active).toEqual([]);
    const found = await w.must<WorkerRun[]>(friend, 'automata', 'discover', { query: 'research' });
    expect(found).toEqual([]);
    expect(kindOf(await w.call(friend, 'activity', 'get', { activityId: run.activityId }))).toBe('not_found');
    const self = await w.admit('free-time');
    expect((await w.must<{ active: WorkerRun[] }>(self, 'automata', 'status', {})).active.map((r) => r.id)).toEqual([run.id]);
  });

  it('stages restricted memory writes for review and keeps deletion out of reach', async () => {
    const w = await fakeActivityWorld();
    const { session, run } = await spawn(w);
    const plain = await session.call('w-plain', write('plain'));
    expect(plain.ok && plain.value.content).toMatchObject({ outcome: 'created' });
    const restricted = await session.call('w-rel', write('rel', { kind: 'relational', content: 'Robin and Sam are close' }));
    expect(restricted.ok && restricted.value.content).toMatchObject({ outcome: 'staged' });
    const memoryId = restricted.ok ? (restricted.value.content as { memoryId: string }).memoryId : '';
    const deletion = await session.call('w-del', { tool: 'memory', action: 'propose_delete', args: { memoryId, justification: 'user_requested', explanation: 'x' } });
    expect(deletion.ok || deletion.error).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });

    const pending = await w.review.pending(10);
    expect(pending.ok && pending.value.map((p) => [p.memory.id, p.run?.id])).toEqual([[memoryId, run.id]]);
    const approved = await w.review.decide('operator:test', { memoryId, approve: true });
    expect(approved.ok && approved.value.state).toBe('current');
    expect((await w.review.pending(10)).ok && (await w.review.pending(10))).toMatchObject({ value: [] });
  });

  it('replays a duplicate effect and never repeats an ambiguous one', async () => {
    const w = await fakeActivityWorld();
    const { session } = await spawn(w);
    const first = await session.call('w-1', write('one'));
    const again = await session.call('w-1', write('one'));
    expect(first.ok && again.ok && (again.value.content as { memoryId: string }).memoryId).toBe(first.ok && (first.value.content as { memoryId: string }).memoryId);
    expect(w.memories.records.size).toBe(1);
    const mismatch = await session.call('w-1', write('one', { content: 'different' }));
    expect(mismatch.ok || mismatch.error).toMatchObject({ kind: 'conflict', reason: 'idempotency_mismatch' });

    // The note is written, then the outcome cannot be recorded: the retry must not write it again.
    w.workerEffects.failNextSettle = true;
    const note = { tool: 'memory', action: 'scratchpad_add', args: { text: 'remember the anemones' } };
    expect(kindOf(await session.call('n-1', note))).toBe('unavailable');
    expect(w.scratchpad.notes.size).toBe(1);
    const retried = await session.call('n-1', note);
    expect(retried.ok || retried.error).toMatchObject({ kind: 'conflict', reason: 'outcome_unknown' });
    expect(w.scratchpad.notes.size).toBe(1);

    // Finishing with an unresolved effect reports the run as blocked, not completed.
    const settled = await finish(session);
    expect(settled).toMatchObject({ status: 'failed', outcome: 'blocked', reason: 'effect_outcome_unknown' });
  });

  it('recovers an expired attempt: requeues pre-boundary work, blocks ambiguous work and fences the old session', async () => {
    const w = await fakeActivityWorld();
    const clean = await spawn(w);
    const dirty = await spawn(w, 'primary-dm', { ...RESEARCH, spawnId: 'spawn-2' });
    await clean.session.beginTurn();
    // The dirty attempt crashes between starting an effect and recording it.
    w.workerEffects.failNextSettle = true;
    await dirty.session.call('n-1', { tool: 'memory', action: 'scratchpad_add', args: { text: 'half-done' } });

    w.clock.advance(WORKER_LEASE_MS + 1);
    const swept = await w.workers.sweep();
    expect(swept.ok && swept.value).toMatchObject({ requeued: [clean.run.id], blocked: [dirty.run.id] });
    expect(w.workerRuns.runs.get(dirty.run.id)).toMatchObject({ status: 'failed', outcome: 'blocked', reason: 'effect_outcome_unknown' });
    expect(w.activities.records.get(dirty.run.activityId)?.status).toBe('failed');
    expect(w.workerEffects.effects.find((e) => e.runId === dirty.run.id)?.phase).toBe('outcome_unknown');

    const stale = await clean.session.call('w-9', write('late'));
    expect(stale.ok || stale.error).toMatchObject({ kind: 'conflict', reason: 'turn_ownership' });
    const resumed = await w.workers.resume(clean.scope);
    expect(resumed.ok && resumed.value.map((r) => [r.id, r.attempts, r.status])).toEqual([[clean.run.id, 2, 'running']]);
    expect(kindOf(await w.workers.resume(await w.admit('friend-dm')))).toBe('ok');
    expect(w.workerHost.sessions).toHaveLength(3);

    // The second attempt also dies; with attempts exhausted the run fails as lease_expired.
    w.clock.advance(WORKER_LEASE_MS + 1);
    const again = await w.workers.sweep();
    expect(again.ok && again.value.failed).toEqual([clean.run.id]);
    expect(w.workerRuns.runs.get(clean.run.id)).toMatchObject({ status: 'failed', outcome: 'failed', reason: 'lease_expired' });
  });

  it('enforces the turn budget and honours cancellation', async () => {
    const w = await fakeActivityWorld();
    const { session, run, scope } = await spawn(w, 'primary-dm', { ...RESEARCH, maxTurns: 1 });
    expect((await session.beginTurn()).ok).toBe(true);
    const over = await session.beginTurn();
    expect(over.ok && over.value).toEqual({ kind: 'budget_exhausted' });
    const limited = await finish(session, 'budget_limited');
    expect(limited).toMatchObject({ status: 'failed', outcome: 'budget_limited' });
    expect(w.activities.records.get(run.activityId)?.status).toBe('interrupted');

    const second = await spawn(w, 'primary-dm', { ...RESEARCH, spawnId: 'spawn-c' });
    const cancelled = await w.must<WorkerRun>(scope, 'automata', 'cancel', { runId: second.run.id });
    expect(cancelled.cancelRequested).toBe(true);
    expect(w.workerHost.cancelled).toEqual([second.run.id]);
    const gate = await second.session.beginTurn();
    expect(gate.ok && gate.value).toEqual({ kind: 'cancel_requested' });
    expect(await finish(second.session, 'cancelled')).toMatchObject({ status: 'cancelled', outcome: 'cancelled' });

    // A run the host never took is cancelled at once.
    w.workerHost.refuse = true;
    const refused = await w.call(scope, 'automata', 'spawn', { ...RESEARCH, spawnId: 'spawn-q' });
    expect(kindOf(refused)).toBe('unavailable');
    const queued = [...w.workerRuns.runs.values()].find((r) => r.spawnKey !== run.spawnKey && r.status === 'queued');
    expect(queued?.attempts).toBe(0);
    const stopped = await w.must<WorkerRun>(scope, 'automata', 'cancel', { runId: queued?.id ?? '' });
    expect(stopped).toMatchObject({ status: 'cancelled', reason: 'cancelled_before_start' });
    expect(w.activities.records.get(stopped.activityId)?.status).toBe('abandoned');
  });

  it('runs per-turn and scheduled workers through the same runner, and inspects lineage without transcripts', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    w.workerHost.refuse = true;
    const scheduled = await w.workers.spawn(self, {
      key: 'nightly-index',
      label: 'index',
      task: 'Index the week',
      grant: { actions: [{ tool: 'memory', action: 'search' }], maxTurns: 2, maxSensitivity: 'confidential' },
      trigger: 'schedule',
    });
    expect(scheduled.ok && scheduled.value.run.source).toMatchObject({ trigger: 'schedule', principal: { kind: 'companion_internal' }, audience: { kind: 'self' } });
    const primary = await w.admit('primary-dm');
    const perTurn = await w.workers.spawn(primary, {
      key: 'after-turn-1',
      label: 'follow-up research',
      task: 'Look up the bus times',
      grant: { actions: [], maxTurns: 1, maxSensitivity: 'public' },
      trigger: 'turn',
    });
    expect(perTurn.ok && perTurn.value.run.status).toBe('queued');
    w.workerHost.refuse = false;
    w.workerHost.autoRun = async (session) => {
      await session.beginTurn();
      await session.finish({ outcome: 'completed', summary: 'indexed', artifacts: [], reason: null, usage });
    };
    const tick = await w.scheduler.tick(self);
    expect(tick.ok && tick.value.resumedWorkers).toEqual({ ok: true, value: 1 });
    const runId = (scheduled.ok ? scheduled.value.run.id : '') as WorkerRunId;
    expect(w.workerRuns.runs.get(runId)?.status).toBe('completed');
    // The participant's per-turn worker waits for a scope of its own conversation.
    expect(w.workerRuns.runs.get((perTurn.ok ? perTurn.value.run.id : '') as WorkerRunId)?.status).toBe('queued');
    const resumed = await w.workers.resume(primary);
    expect(resumed.ok && resumed.value.map((r) => r.status)).toEqual(['completed']);

    const inspected = await w.must<{ run: WorkerRun; effects: unknown[] }>(self, 'automata', 'inspect', { runId });
    expect(inspected.run.source.trigger).toBe('schedule');
    expect(JSON.stringify(inspected)).not.toMatch(/transcript|reasoning/);
  });
});
