import { describe, expect, it } from 'vitest';
import { createActivityService, deriveWorkerScope } from '../../packages/core/src/index.ts';
import { FakeActivityLog, FixedClock, SequentialIds, id, standardWorld } from './fakes.ts';

function setup() {
  const log = new FakeActivityLog();
  const service = createActivityService({ log, clock: new FixedClock(), ids: new SequentialIds() });
  return { log, service, ...standardWorld() };
}

describe('activity records', () => {
  it('binds an activity to its source turn and audience', async () => {
    const { service, admit } = setup();
    const scope = await admit('primary-dm');
    const started = await service.start(scope, { purpose: 'draft a poem', sessionId: id('session-1'), turnId: id('turn-1') });
    expect(started.ok && started.value).toMatchObject({
      status: 'in_progress',
      visibility: scope.audience,
      source: { sessionId: 'session-1', turnId: 'turn-1', workerRunId: null },
    });
  });

  it('reads another audience activity as missing, and lets self turns see it', async () => {
    const { service, admit } = setup();
    const started = await service.start(await admit('primary-dm'), { purpose: 'private plan', sessionId: null, turnId: null });
    if (!started.ok) throw new Error('start');
    const fromFriend = await service.get(await admit('friend-dm'), started.value.id);
    expect(fromFriend.ok || fromFriend.error).toEqual({ kind: 'not_found', subject: `activity ${started.value.id}` });
    const update = await service.update(await admit('friend-dm'), { id: started.value.id, expectedRevision: 1, note: 'x' });
    expect(update.ok || update.error.kind).toBe('not_found');
    expect((await service.get(await admit('free-time'), started.value.id)).ok).toBe(true);
  });

  it('writes only from the activity\'s own conversation, even where another can read it', async () => {
    const { service, log, admit } = setup();
    const friend = await admit('friend-dm');
    const started = await service.start(friend, { purpose: 'plan a picnic', sessionId: null, turnId: null });
    if (!started.ok) throw new Error('start');
    // The primary conversation's admission covers the friend room's class, so it may read the record...
    const primary = await admit('primary-dm');
    expect((await service.get(primary, started.value.id)).ok).toBe(true);
    // ...but nothing admitted there may be written into a record the friend conversation reads back.
    const crossed = await service.update(primary, { id: started.value.id, expectedRevision: 1, note: 'primary secret: X', outcome: 'primary private detail', status: 'completed' });
    expect(crossed.ok || crossed.error).toEqual({ kind: 'not_found', subject: `activity ${started.value.id}` });
    const self = await service.update(await admit('free-time'), { id: started.value.id, expectedRevision: 1, note: 'x' });
    expect(self.ok || self.error.kind).toBe('not_found');
    expect(log.records.get(started.value.id)).toMatchObject({ status: 'in_progress', outcome: null, notes: [], revision: 1 });
    const own = await service.update(friend, { id: started.value.id, expectedRevision: 1, note: 'bring a blanket' });
    expect(own.ok && own.value.notes.map((n) => n.text)).toEqual(['bring a blanket']);
  });

  it('attributes notes from the scope: worker notes are machine output, not companion reflection', async () => {
    const { service, admit } = setup();
    const parent = await admit('primary-dm');
    const worker = deriveWorkerScope(parent, id('run-7'), { actions: [], maxTurns: 2, maxSensitivity: 'personal' });
    if (!worker.ok) throw new Error('worker');
    // The worker's own activity: bound to its run, so it reaches it under its narrower ceiling.
    const started = await service.start(worker.value, { purpose: 'research', sessionId: null, turnId: null });
    if (!started.ok) throw new Error('start');
    expect(started.value.source.workerRunId).toBe('run-7');

    const machine = await service.update(worker.value, { id: started.value.id, expectedRevision: 1, note: 'found 3 sources' });
    const companion = await service.update(parent, { id: started.value.id, expectedRevision: 2, note: 'this mattered to me', status: 'completed' });
    expect(machine.ok && machine.value.notes[0]?.author).toEqual({ kind: 'machine', producer: 'worker:run-7' });
    expect(companion.ok && companion.value.notes[1]?.author).toEqual({ kind: 'companion' });
  });

  it('holds a worker to its grant ceiling for any activity that is not its own run', async () => {
    const { service, admit } = setup();
    const parent = await admit('primary-dm');
    const started = await service.start(parent, { purpose: 'private plan', sessionId: null, turnId: null });
    if (!started.ok) throw new Error('start');
    const personal = deriveWorkerScope(parent, id('run-8'), { actions: [], maxTurns: 1, maxSensitivity: 'personal' });
    const confidential = deriveWorkerScope(parent, id('run-9'), { actions: [], maxTurns: 1, maxSensitivity: 'confidential' });
    if (!personal.ok || !confidential.ok) throw new Error('worker');
    // A direct room is confidential material: a personal-ceiling worker cannot read it, even in its own conversation.
    expect((await service.get(personal.value, started.value.id)).ok).toBe(false);
    expect((await service.update(personal.value, { id: started.value.id, expectedRevision: 1, note: 'x' })).ok).toBe(false);
    expect((await service.get(confidential.value, started.value.id)).ok).toBe(true);
    const recent = await service.recent(personal.value, { limit: 10 });
    expect(recent.ok && recent.value).toEqual([]);
  });

  it('rejects stale revisions and re-settling', async () => {
    const { service, admit } = setup();
    const scope = await admit('primary-dm');
    const started = await service.start(scope, { purpose: 'walk', sessionId: null, turnId: null });
    if (!started.ok) throw new Error('start');
    const settled = await service.update(scope, { id: started.value.id, expectedRevision: 1, status: 'interrupted' });
    expect(settled.ok).toBe(true);
    const stale = await service.update(scope, { id: started.value.id, expectedRevision: 1, outcome: 'x' });
    expect(stale.ok || stale.error).toMatchObject({ kind: 'conflict', reason: 'stale_revision', expectedRevision: 1, actualRevision: 2 });
    const resettle = await service.update(scope, { id: started.value.id, expectedRevision: 2, status: 'completed' });
    expect(resettle.ok || resettle.error.kind).toBe('invalid');
  });
});
