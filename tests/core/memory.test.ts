import { describe, expect, it } from 'vitest';
import { deriveWorkerScope, unavailable, type ModelPort } from '../../packages/core/src/index.ts';
import { OPERATOR } from './continuity-world.ts';
import { id } from './fakes.ts';
import { fakeMemoryWorld, kindOf } from './memory-world.ts';

type World = Awaited<ReturnType<typeof fakeMemoryWorld>>;
type Written = { memoryId: string; outcome: string; replayed: boolean; embedding: string };
type View = { id: string; content: string; subject: unknown; attribution: unknown; author: unknown };

const MAINTAIN = { sessionLimit: 20, maxEntries: 200 };

const write = (world: World, scope: Parameters<World['call']>[0], writeId: string, content: string, extra: Record<string, unknown> = {}) =>
  world.call(scope, 'memory', 'write', { writeId, kind: 'fact', content, sensitivity: 'personal', ...extra });

const mustWrite = async (world: World, scope: Parameters<World['call']>[0], writeId: string, content: string, extra: Record<string, unknown> = {}) => {
  const result = await write(world, scope, writeId, content, extra);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value.content as Written;
};

/** Transcript turns as the extraction prompt labels them. */
function turnsOf(request: Parameters<ModelPort['complete']>[0]): { turnId: string; speaker: string | null }[] {
  return request.messages.flatMap((m) => {
    const match = m.role === 'labelled_context' ? /^transcript turn (\S+) \((?:participant (\S+)|companion)\)$/.exec(m.label ?? '') : null;
    return match?.[1] === undefined ? [] : [{ turnId: match[1], speaker: match[2] ?? null }];
  });
}

function scriptExtraction(world: World, items: (turns: ReturnType<typeof turnsOf>) => Record<string, unknown>[]): void {
  world.model.replies.set('memory_extraction', (request) => JSON.stringify({ memories: items(turnsOf(request)) }));
}

describe('memory privacy', () => {
  it('withholds memories about another person from search, get, census and every write path', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    const sam = await world.admit('friend-dm');
    const written = await mustWrite(world, robin, 'w1', 'Robin keeps three beehives on the roof garden');
    expect(world.memories.records.get(written.memoryId)?.subject).toEqual({ kind: 'contacts', contactIds: [world.people.primary] });

    const seen = await world.must<{ memories: View[] }>(sam, 'memory', 'search', { query: 'beehives roof garden' });
    expect(seen.memories).toEqual([]);
    for (const [action, args] of [
      ['get', {}],
      ['patch', { content: 'Robin keeps no bees', reason: 'probe' }],
      ['propose_delete', { justification: 'inaccurate', explanation: 'probe' }],
      ['restore', {}],
    ] as const) {
      const probed = await world.call(sam, 'memory', action, { memoryId: written.memoryId, ...args });
      expect(probed.ok || probed.error, action).toEqual({ kind: 'not_found', subject: `memory ${written.memoryId}` });
    }
    const unknown = await world.call(sam, 'memory', 'get', { memoryId: 'memory-404' });
    expect(unknown.ok || unknown.error).toEqual({ kind: 'not_found', subject: 'memory memory-404' });
    expect((await world.must<{ total: number }>(sam, 'memory', 'census')).total).toBe(0);
    expect((await world.must<{ total: number }>(robin, 'memory', 'census')).total).toBe(1);
    expect(world.approvals.submitted).toEqual([]);
  });

  it('fills a search limit from visible memories only and returns no vectors', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    const sam = await world.admit('friend-dm');
    for (let i = 0; i < 6; i += 1) await mustWrite(world, robin, `r${i}`, `Robin tends tomato garden bed ${i}`);
    const own = await mustWrite(world, sam, 's1', 'Sam waters the tomato garden');
    const found = await world.must<{ memories: View[]; mode: unknown }>(sam, 'memory', 'search', { query: 'tomato garden', limit: 1 });
    expect(found.memories.map((m) => m.id)).toEqual([own.memoryId]);
    expect(found.mode).toEqual({ lexical: 'ok', semantic: 'ok' });
    expect(JSON.stringify(found.memories)).not.toMatch(/vector|embedding|values/);
  });

  it('shows a contact\'s background only to conversations that may read it', async () => {
    const world = await fakeMemoryWorld();
    const sam = await world.admit('friend-dm');
    await mustWrite(world, sam, 's1', 'Sam plays cello in a community orchestra');
    const fromSelf = await world.must<{ memories: View[] }>(await world.admit('reflection'), 'memory', 'shared_background', {
      contactId: world.people.friend,
    });
    expect(fromSelf.memories.map((m) => m.content)).toEqual(['Sam plays cello in a community orchestra']);
    const fromRobin = await world.must<{ memories: View[] }>(await world.admit('primary-dm'), 'memory', 'shared_background', {
      contactId: world.people.friend,
    });
    expect(fromRobin.memories).toEqual([]);
  });

  it('refuses a sensitivity the conversation is not admitted to', async () => {
    const world = await fakeMemoryWorld();
    const sam = await world.admit('friend-dm');
    const refused = await write(world, sam, 'w1', 'Sam has a private diagnosis', { sensitivity: 'confidential' });
    expect(refused.ok || refused.error).toMatchObject({ kind: 'denied', reason: 'audience_not_admitted' });
    expect(world.memories.records.size).toBe(0);
  });

  it('stamps authorship: companion-authored by default, participant-attributed to the caller on request', async () => {
    const world = await fakeMemoryWorld();
    const sam = await world.admit('friend-dm');
    const own = await mustWrite(world, sam, 'w1', 'Sam seemed tired today');
    const said = await mustWrite(world, sam, 'w2', 'Sam said the new job starts in May', { attribution: 'participant_attributed' });
    expect(world.memories.records.get(own.memoryId)?.provenance).toMatchObject({
      author: { kind: 'companion' },
      attribution: { kind: 'companion_authored' },
      via: 'tool_write',
    });
    expect(world.memories.records.get(said.memoryId)?.provenance.attribution).toEqual({ kind: 'participant_attributed', contactId: world.people.friend });
    const selfSaid = await write(world, await world.admit('reflection'), 'w3', 'Something said', { attribution: 'participant_attributed' });
    expect(kindOf(selfSaid)).toBe('invalid');
  });

  it('stages restricted worker writes until an operator approves them', async () => {
    const world = await fakeMemoryWorld();
    const parent = await world.admit('primary-dm');
    const worker = deriveWorkerScope(parent, id('run-1'), { actions: [{ tool: 'memory', action: 'write' }], maxTurns: 2, maxSensitivity: 'personal' });
    if (!worker.ok) throw new Error('worker');
    const staged = await mustWrite(world, worker.value, 'w1', 'Robin asked not to be called after ten', { kind: 'boundary' });
    expect(staged.outcome).toBe('staged');
    expect(world.memories.records.get(staged.memoryId)?.provenance.attribution).toEqual({ kind: 'inferred', producer: 'worker:run-1' });
    expect((await world.must<{ memories: View[] }>(parent, 'memory', 'search', { query: 'called after ten' })).memories).toEqual([]);

    const queue = await world.administration.listStaged(10);
    expect(queue.ok && queue.value.map((r) => r.id)).toEqual([staged.memoryId]);
    const approved = await world.administration.reviewStaged(OPERATOR, { memoryId: staged.memoryId, approve: true });
    expect(approved.ok && approved.value.state).toBe('current');
    const visible = await world.must<{ memories: View[] }>(parent, 'memory', 'search', { query: 'called after ten' });
    expect(visible.memories.map((m) => m.id)).toEqual([staged.memoryId]);
  });
});

describe('memory writes are idempotent and evolve by authority', () => {
  it('replays a retried write with identical provenance and rejects a reused key with different content', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    const first = await mustWrite(world, robin, 'w1', 'Robin keeps three beehives on the roof garden');
    const before = world.memories.records.get(first.memoryId);
    world.clock.advance(60_000);
    const retry = await mustWrite(world, robin, 'w1', 'Robin keeps three beehives on the roof garden');
    expect(retry).toMatchObject({ memoryId: first.memoryId, outcome: 'created', replayed: true });
    expect(world.memories.records.get(first.memoryId)).toEqual(before);
    expect(world.memories.records.size).toBe(1);

    const reused = await write(world, robin, 'w1', 'Robin keeps goats');
    expect(reused.ok || reused.error).toMatchObject({ kind: 'conflict', reason: 'idempotency_mismatch' });
    // Keys are namespaced by conversation: the same key elsewhere is a different write.
    const elsewhere = await mustWrite(world, await world.admit('friend-dm'), 'w1', 'Sam keeps goats');
    expect(elsewhere.replayed).toBe(false);
    expect(world.memories.records.size).toBe(2);
  });

  it('deduplicates the same memory and supersedes a current-state change of equal authority', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    const first = await mustWrite(world, robin, 'w1', 'Robin keeps three beehives on the roof garden');
    const again = await mustWrite(world, robin, 'w2', 'Robin keeps three beehives on the roof garden');
    expect(again).toMatchObject({ memoryId: first.memoryId, outcome: 'deduplicated' });
    const changed = await mustWrite(world, robin, 'w3', 'Robin now keeps five beehives on the roof garden');
    expect(changed.outcome).toBe('superseded');
    expect(world.memories.records.get(first.memoryId)).toMatchObject({ state: 'superseded', supersededBy: changed.memoryId });
    const got = await world.must<{ events: { kind: string }[] }>(robin, 'memory', 'get', { memoryId: changed.memoryId });
    expect(got.events.map((e) => e.kind)).toEqual(['created']);
  });

  it('never lets an inferred memory supersede what the companion wrote', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    const own = await mustWrite(world, robin, 'w1', 'Robin keeps three beehives on the roof garden');
    await world.converse(robin, 'The hives are doing great', 'Glad to hear it', 'k1');
    scriptExtraction(world, (turns) => [
      {
        turnId: turns[0]?.turnId,
        kind: 'fact',
        content: 'Robin now keeps five beehives on the roof garden',
        sensitivity: 'personal',
        about: 'speaker',
        attribution: 'inferred',
        confidence: 0.95,
      },
    ]);
    const report = await world.maintenance.run(await world.admit('maintenance'), MAINTAIN);
    expect(report.ok && report.value.extraction[0]?.written[0]?.outcome).toBe('conflict');
    expect(world.memories.records.get(own.memoryId)?.state).toBe('current');
    const inferred = [...world.memories.records.values()].find((r) => r.id !== own.memoryId);
    expect(inferred?.provenance).toMatchObject({ author: { kind: 'machine', producer: 'memory_extraction' }, attribution: { kind: 'inferred' } });
  });

  it('never absorbs the companion\'s write into a machine inference of the same text', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    const worker = deriveWorkerScope(robin, id('run-1'), { actions: [{ tool: 'memory', action: 'write' }], maxTurns: 3, maxSensitivity: 'personal' });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const inferred = await mustWrite(world, worker.value, 'w1', 'Robin likes green tea');
    expect(world.memories.records.get(inferred.memoryId)?.provenance.attribution).toEqual({ kind: 'inferred', producer: 'worker:run-1' });

    const own = await mustWrite(world, robin, 'w2', 'Robin likes green tea');
    expect(own.outcome).toBe('superseded');
    expect(own.memoryId).not.toBe(inferred.memoryId);
    expect(world.memories.records.get(own.memoryId)?.provenance).toMatchObject({ attribution: { kind: 'companion_authored' }, author: { kind: 'companion' } });
    // The inference is kept, unchanged, as superseded history.
    expect(world.memories.records.get(inferred.memoryId)).toMatchObject({
      state: 'superseded',
      supersededBy: own.memoryId,
      provenance: { attribution: { kind: 'inferred', producer: 'worker:run-1' } },
    });
    const shown = await world.must<{ memories: View[] }>(robin, 'memory', 'search', { query: 'green tea' });
    expect(shown.memories.map((m) => [m.id, m.attribution])).toEqual([[own.memoryId, { kind: 'companion_authored' }]]);

    // A later extracted inference of the same text reinforces the companion's record; a changed one cannot replace it.
    await world.converse(robin, 'Green tea again today', 'Of course', 'k1');
    scriptExtraction(world, (turns) =>
      ['Robin likes green tea', 'Robin now likes green tea'].map((content) => ({
        turnId: turns[0]?.turnId,
        kind: 'fact',
        content,
        sensitivity: 'personal',
        about: 'speaker',
        attribution: 'inferred',
        confidence: 1,
      })),
    );
    const report = await world.maintenance.run(await world.admit('maintenance'), MAINTAIN);
    expect(report.ok && report.value.extraction[0]?.written.map((w) => [w.memoryId === own.memoryId, w.outcome])).toEqual([
      [true, 'deduplicated'],
      [false, 'conflict'],
    ]);
    expect(world.memories.records.get(own.memoryId)).toMatchObject({ state: 'current', provenance: { attribution: { kind: 'companion_authored' } } });
  });

  it('never deduplicates into, supersedes or reveals a memory the writer cannot read', async () => {
    const world = await fakeMemoryWorld();
    const sam = await world.admit('friend-dm');
    const own = await mustWrite(world, sam, 'w1', 'Sam keeps three beehives on the roof garden');
    const hidden = world.memories.records.get(own.memoryId);
    if (hidden === undefined) throw new Error('memory');
    // Same subject and kind, but recorded in a self turn: Sam's conversation cannot read it.
    world.memories.records.set(own.memoryId, { ...hidden, provenance: { ...hidden.provenance, source: { kind: 'self' } } });
    const again = await mustWrite(world, sam, 'w2', 'Sam keeps three beehives on the roof garden');
    expect(again).toMatchObject({ outcome: 'created', replayed: false });
    expect(again.memoryId).not.toBe(own.memoryId);
    const changed = await mustWrite(world, sam, 'w3', 'Sam now keeps five beehives on the roof garden');
    expect(world.memories.records.get(own.memoryId)?.state).toBe('current');
    expect(changed.outcome).toBe('superseded');
    expect(world.memories.records.get(again.memoryId)?.state).toBe('superseded');
  });
});

describe('memory import', () => {
  const records = (...items: { kind?: string; sensitivity?: string; content: string }[]) =>
    items.map((r) => ({ kind: r.kind ?? 'fact', sensitivity: r.sensitivity ?? 'personal', content: r.content, occurredAt: '2029-06-01' }));

  it('imports with validated occurrence times, idempotently by batch, and refuses unadmitted or malformed batches', async () => {
    const world = await fakeMemoryWorld();
    const sam = await world.admit('friend-dm');
    const imported = await world.must<{ staged: boolean; results: Written[] }>(sam, 'memory', 'import', {
      batchId: 'b1',
      records: records({ content: 'Sam ran a marathon' }, { content: 'Sam learned the cello' }),
    });
    expect(imported.staged).toBe(false);
    expect(imported.results.map((r) => r.outcome)).toEqual(['created', 'created']);
    const stored = world.memories.records.get(imported.results[0]?.memoryId ?? '');
    expect(stored).toMatchObject({ occurredAt: '2029-06-01T00:00:00.000Z', provenance: { via: 'import', sourceConversationAt: null } });
    const retried = await world.must<{ results: Written[] }>(sam, 'memory', 'import', {
      batchId: 'b1',
      records: records({ content: 'Sam ran a marathon' }, { content: 'Sam learned the cello' }),
    });
    expect(retried.results.map((r) => r.replayed)).toEqual([true, true]);

    const unadmitted = await world.call(sam, 'memory', 'import', {
      batchId: 'b2',
      records: records({ content: 'Sam is fine' }, { content: 'Sam has a diagnosis', sensitivity: 'confidential' }),
    });
    expect(unadmitted.ok || unadmitted.error).toMatchObject({ kind: 'denied', reason: 'audience_not_admitted' });
    expect(kindOf(await world.call(sam, 'memory', 'import', { batchId: 'b3', records: [] }))).toBe('invalid');
    const tooMany = records(...Array.from({ length: 101 }, (_, i) => ({ content: `item ${String(i)}` })));
    expect(kindOf(await world.call(sam, 'memory', 'import', { batchId: 'b4', records: tooMany }))).toBe('invalid');
    const future = [{ kind: 'fact', sensitivity: 'personal', content: 'later', occurredAt: '2031-01-01' }];
    expect(kindOf(await world.call(sam, 'memory', 'import', { batchId: 'b5', records: future }))).toBe('invalid');
    expect(world.memories.records.size).toBe(2);
  });

  it('stages a whole worker batch when any record is restricted, hidden until an operator approves', async () => {
    const world = await fakeMemoryWorld();
    const parent = await world.admit('primary-dm');
    const worker = deriveWorkerScope(parent, id('run-1'), { actions: [{ tool: 'memory', action: 'import' }], maxTurns: 2, maxSensitivity: 'personal' });
    if (!worker.ok) throw new Error('worker');
    const batch = await world.must<{ staged: boolean; results: Written[] }>(worker.value, 'memory', 'import', {
      batchId: 'b1',
      records: records({ content: 'Robin likes quiet mornings' }, { kind: 'boundary', content: 'Robin asked not to be called after ten' }),
    });
    expect(batch.staged).toBe(true);
    expect(batch.results.map((r) => r.outcome)).toEqual(['staged', 'staged']);
    expect((await world.must<{ memories: View[] }>(parent, 'memory', 'search', { query: 'quiet mornings' })).memories).toEqual([]);
    expect((await world.must<{ total: number }>(parent, 'memory', 'census')).total).toBe(0);
    await world.administration.reviewStaged(OPERATOR, { memoryId: batch.results[0]?.memoryId ?? '', approve: true });
    await world.administration.reviewStaged(OPERATOR, { memoryId: batch.results[1]?.memoryId ?? '', approve: false });
    const visible = await world.must<{ memories: View[] }>(parent, 'memory', 'search', { query: 'quiet mornings called after ten' });
    expect(visible.memories.map((m) => m.content)).toEqual(['Robin likes quiet mornings']);
  });
});

describe('memory deletion is an operator decision and reversible', () => {
  it('proposes, applies on approval, hides and restores', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    const written = await mustWrite(world, robin, 'w1', 'Robin keeps three beehives on the roof garden');
    const proposal = await world.must<{ proposalId: string; status: string }>(robin, 'memory', 'propose_delete', {
      memoryId: written.memoryId,
      justification: 'inaccurate',
      explanation: 'Robin said this was wrong',
    });
    expect(proposal.status).toBe('pending');
    const repeated = await world.must<{ proposalId: string }>(robin, 'memory', 'propose_delete', {
      memoryId: written.memoryId,
      justification: 'inaccurate',
      explanation: 'again',
    });
    expect(repeated.proposalId).toBe(proposal.proposalId);
    expect(world.approvals.submitted).toHaveLength(1);
    expect(world.memories.records.get(written.memoryId)?.state).toBe('current');

    const decided = await world.administration.decideDeletion(OPERATOR, { proposalId: proposal.proposalId, approve: true });
    expect(decided.ok && decided.value.status).toBe('approved');
    expect((await world.must<{ memories: View[] }>(robin, 'memory', 'search', { query: 'beehives' })).memories).toEqual([]);
    expect(kindOf(await world.call(robin, 'memory', 'get', { memoryId: written.memoryId }))).toBe('not_found');

    const restored = await world.must<View>(robin, 'memory', 'restore', { memoryId: written.memoryId });
    expect(restored.id).toBe(written.memoryId);
    expect(world.memories.records.get(written.memoryId)?.state).toBe('current');
    expect(world.deletions.proposals.get(proposal.proposalId)?.status).toBe('restored');
  });

  it('records a patch with its reason and previous text, rewording to companion authorship', async () => {
    const world = await fakeMemoryWorld();
    const sam = await world.admit('friend-dm');
    const said = await mustWrite(world, sam, 'w1', 'Sam said the job starts in May', { attribution: 'participant_attributed' });
    const patched = await world.must<View & { revision: number }>(sam, 'memory', 'patch', {
      memoryId: said.memoryId,
      content: 'Sam starts the new job in June',
      reason: 'Sam corrected the month',
      expectedRevision: 1,
    });
    expect(patched).toMatchObject({ revision: 2, attribution: { kind: 'companion_authored' } });
    const stale = await world.call(sam, 'memory', 'patch', { memoryId: said.memoryId, content: 'x', reason: 'y', expectedRevision: 1 });
    expect(stale.ok || stale.error).toMatchObject({ kind: 'conflict', reason: 'stale_revision' });
    const events = world.memories.eventRows.filter((e) => e.memoryId === said.memoryId && e.kind === 'patched');
    expect(events[0]?.detail).toMatchObject({ reason: 'Sam corrected the month', previousContent: 'Sam said the job starts in May' });
  });
});

describe('memory extraction', () => {
  it('binds the subject to the attributed speaker, and a rerun records nothing new', async () => {
    const world = await fakeMemoryWorld();
    const sam = await world.admit('friend-dm');
    await world.converse(sam, 'Robin told me she hates cilantro, and I moved to Lisbon', 'Noted', 'k1');
    scriptExtraction(world, (turns) => [
      {
        turnId: turns.find((t) => t.speaker !== null)?.turnId,
        kind: 'fact',
        content: 'Sam moved to Lisbon',
        sensitivity: 'personal',
        about: 'speaker',
        attribution: 'participant_attributed',
        confidence: 0.8,
      },
    ]);
    const maintenance = await world.admit('maintenance');
    const first = await world.maintenance.run(maintenance, MAINTAIN);
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(first.value.failures.filter((f) => f.step === 'extraction')).toEqual([]);
    const [record] = [...world.memories.records.values()];
    expect(record?.subject).toEqual({ kind: 'contacts', contactIds: [world.people.friend] });
    expect(record?.provenance).toMatchObject({
      author: { kind: 'machine', producer: 'memory_extraction' },
      attribution: { kind: 'participant_attributed', contactId: world.people.friend },
      via: 'extraction',
    });
    expect(record?.provenance.sourceTurnIds).toHaveLength(1);

    const second = await world.maintenance.run(maintenance, MAINTAIN);
    expect(second.ok && second.value.extraction.map((r) => r.outcome)).toEqual(['up_to_date']);
    expect(world.memories.records.size).toBe(1);
  });

  it('replays writes without duplicates or changed provenance when the watermark failed to advance', async () => {
    const world = await fakeMemoryWorld();
    const sam = await world.admit('friend-dm');
    const sessionId = await world.converse(sam, 'I moved to Lisbon', 'Noted', 'k1');
    scriptExtraction(world, (turns) => [
      { turnId: turns[0]?.turnId, kind: 'fact', content: 'Sam moved to Lisbon', sensitivity: 'personal', about: 'speaker', attribution: 'participant_attributed', confidence: 0.8 },
    ]);
    const maintenance = await world.admit('maintenance');
    const advance = world.extractionCursors.advance.bind(world.extractionCursors);
    world.extractionCursors.advance = () => Promise.resolve(unavailable('cursors', 'down'));
    const failed = await world.maintenance.run(maintenance, MAINTAIN);
    expect(failed.ok && failed.value.failures.map((f) => f.step)).toContain('extraction');
    const before = structuredClone([...world.memories.records.values()]);
    expect(before).toHaveLength(1);

    world.extractionCursors.advance = advance;
    world.clock.advance(60_000);
    const retried = await world.maintenance.run(maintenance, MAINTAIN);
    expect(retried.ok && retried.value.extraction[0]?.written.map((w) => w.replayed)).toEqual([true]);
    expect([...world.memories.records.values()]).toEqual(before);
    expect((await world.extractionCursors.get(sessionId)).ok).toBe(true);
  });

  it('advances the watermark when a rerun relabels an item written by a failed run', async () => {
    const world = await fakeMemoryWorld();
    const sam = await world.admit('friend-dm');
    const sessionId = await world.converse(sam, 'I moved to Lisbon', 'Noted', 'k1');
    let sensitivity = 'personal';
    scriptExtraction(world, (turns) => [
      { turnId: turns[0]?.turnId, kind: 'fact', content: 'Sam moved to Lisbon', sensitivity, about: 'speaker', attribution: 'participant_attributed', confidence: 0.8 },
    ]);
    const maintenance = await world.admit('maintenance');
    const advance = world.extractionCursors.advance.bind(world.extractionCursors);
    world.extractionCursors.advance = () => Promise.resolve(unavailable('cursors', 'down'));
    await world.maintenance.run(maintenance, MAINTAIN);
    expect(world.memories.records.size).toBe(1);

    world.extractionCursors.advance = advance;
    sensitivity = 'intimate';
    const retried = await world.maintenance.run(maintenance, MAINTAIN);
    expect(retried.ok && retried.value.failures.filter((f) => f.step === 'extraction')).toEqual([]);
    expect(retried.ok && retried.value.extraction[0]?.written.map((w) => w.outcome)).toEqual(['deduplicated']);
    expect(world.memories.records.size).toBe(1);
    const cursor = await world.extractionCursors.get(sessionId);
    expect(cursor.ok && cursor.value.seq).toBeGreaterThan(0);
  });

  it('fails closed on malformed output and keeps the watermark', async () => {
    const world = await fakeMemoryWorld();
    const sessionId = await world.converse(await world.admit('friend-dm'), 'I moved to Lisbon', 'Noted', 'k1');
    world.model.replies.set('memory_extraction', () => '{"memories":[{"turnId":"turn-x","kind":"fact"}]}');
    const report = await world.maintenance.run(await world.admit('maintenance'), MAINTAIN);
    expect(report.ok && report.value.failures.find((f) => f.step === 'extraction')?.error.kind).toBe('invalid');
    expect(world.memories.records.size).toBe(0);
    const cursor = await world.extractionCursors.get(sessionId);
    expect(cursor.ok && cursor.value.seq).toBe(0);
  });

  it('records nothing about a contact without tracking consent', async () => {
    const world = await fakeMemoryWorld();
    await world.converse(await world.admit('friend-dm'), 'I moved to Lisbon', 'Noted', 'k1');
    const sam = world.contactStore.records.get(world.people.friend);
    if (sam === undefined) throw new Error('friend');
    world.contactStore.records.set(world.people.friend, { ...sam, consent: 'revoked' });
    scriptExtraction(world, (turns) => [
      { turnId: turns[0]?.turnId, kind: 'fact', content: 'Sam moved to Lisbon', sensitivity: 'personal', about: 'speaker', attribution: 'participant_attributed', confidence: 0.8 },
    ]);
    const report = await world.maintenance.run(await world.admit('maintenance'), MAINTAIN);
    expect(report.ok && report.value.extraction[0]?.withheld).toEqual([{ turnId: expect.any(String), reason: 'untracked_contact' }]);
    expect(world.memories.records.size).toBe(0);
  });

  it('records nothing drawn from an untracked speaker\'s turn in a group, whatever the subject', async () => {
    const world = await fakeMemoryWorld();
    await world.converse(await world.admit('friend-group'), 'I moved to Lisbon and I am in recovery', 'Thanks for sharing', 'k1');
    const sam = world.contactStore.records.get(world.people.friend);
    if (sam === undefined) throw new Error('friend');
    world.contactStore.records.set(world.people.friend, { ...sam, consent: 'revoked' });
    scriptExtraction(world, (turns) =>
      ['participant_attributed', 'inferred'].map((attribution) => ({
        turnId: turns.find((t) => t.speaker !== null)?.turnId,
        kind: 'fact',
        content: `The room heard about Lisbon (${attribution})`,
        sensitivity: 'personal',
        about: 'room',
        attribution,
        confidence: 0.8,
      })),
    );
    const report = await world.maintenance.run(await world.admit('maintenance'), MAINTAIN);
    expect(report.ok && report.value.extraction[0]?.withheld.map((w) => w.reason)).toEqual(['untracked_contact', 'untracked_contact']);
    expect(world.memories.records.size).toBe(0);
  });

  it('runs only in a companion-internal maintenance turn', async () => {
    const world = await fakeMemoryWorld();
    const refused = await world.maintenance.run(await world.admit('primary-dm'), MAINTAIN);
    expect(kindOf(refused)).toBe('denied');
  });
});

describe('embeddings', () => {
  it('marks a write pending when embedding fails, reports semantic search unavailable, then backfills', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    world.embeddings.failing = true;
    const written = await mustWrite(world, robin, 'w1', 'Robin keeps three beehives on the roof garden');
    expect(written.embedding).toBe('pending');
    const degraded = await world.must<{ memories: View[]; mode: unknown }>(robin, 'memory', 'search', { query: 'beehives' });
    expect(degraded.mode).toEqual({ lexical: 'ok', semantic: 'unavailable' });
    expect(degraded.memories.map((m) => m.id)).toEqual([written.memoryId]);

    const stillDown = await world.maintenance.run(await world.admit('maintenance'), MAINTAIN);
    expect(stillDown.ok && stillDown.value.failures.map((f) => f.step)).toContain('embedding_backfill');
    world.embeddings.failing = false;
    const backfilled = await world.maintenance.run(await world.admit('maintenance'), MAINTAIN);
    expect(backfilled.ok && backfilled.value.backfill?.memories).toBe(1);
    expect(world.memories.vectors.size).toBe(1);
  });

  it('rejects vectors of the wrong dimension instead of storing them', async () => {
    const world = await fakeMemoryWorld();
    world.embeddings.wrongDimensions = true;
    const written = await mustWrite(world, await world.admit('primary-dm'), 'w1', 'Robin keeps three beehives on the roof garden');
    expect(written.embedding).toBe('pending');
    expect(world.memories.vectors.size).toBe(0);
  });
});

describe('scratchpad', () => {
  it('keeps notes to their conversation until the end of the UTC day; globals are written only in self turns', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    const sam = await world.admit('friend-dm');
    const note = await world.must<{ id: string; expiresAt: string }>(robin, 'memory', 'scratchpad_add', { text: 'ask about the hives' });
    expect(note.expiresAt).toBe('2030-01-01T23:59:59.999Z');
    expect(await world.must(sam, 'memory', 'scratchpad_list')).toEqual([]);
    expect(kindOf(await world.call(sam, 'memory', 'scratchpad_remove', { noteId: note.id }))).toBe('not_found');
    const refused = await world.call(sam, 'memory', 'scratchpad_add', { text: 'tell everyone', global: true });
    expect(refused.ok || refused.error).toMatchObject({ kind: 'denied', reason: 'requires_self_audience' });
    await world.must(await world.admit('reflection'), 'memory', 'scratchpad_add', { text: 'be gentle today', global: true });
    expect((await world.must<{ text: string }[]>(sam, 'memory', 'scratchpad_list')).map((n) => n.text)).toEqual(['be gentle today']);
    world.clock.advance(24 * 60 * 60_000);
    expect(await world.must(robin, 'memory', 'scratchpad_list')).toEqual([]);
  });
});
