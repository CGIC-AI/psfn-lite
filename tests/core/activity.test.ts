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

  it('attributes notes from the scope: worker notes are machine output, not companion reflection', async () => {
    const { service, admit } = setup();
    const parent = await admit('primary-dm');
    const started = await service.start(parent, { purpose: 'research', sessionId: null, turnId: null });
    if (!started.ok) throw new Error('start');
    const worker = deriveWorkerScope(parent, id('run-7'), { actions: [], maxTurns: 2, maxSensitivity: 'personal' });
    if (!worker.ok) throw new Error('worker');

    const machine = await service.update(worker.value, { id: started.value.id, expectedRevision: 1, note: 'found 3 sources' });
    const companion = await service.update(parent, { id: started.value.id, expectedRevision: 2, note: 'this mattered to me', status: 'completed' });
    expect(machine.ok && machine.value.notes[0]?.author).toEqual({ kind: 'machine', producer: 'worker:run-7' });
    expect(companion.ok && companion.value.notes[1]?.author).toEqual({ kind: 'companion' });
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
