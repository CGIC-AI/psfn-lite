import { describe, expect, it } from 'vitest';
import { accessOf, deriveWorkerScope, mergeEpisodes, ok, unavailable, type Audience, type ContactId, type Episode, type SessionId } from '../../packages/core/src/index.ts';
import { id } from './fakes.ts';
import { ENDED_AFTER_MS, fakeMemoryWorld, kindOf } from './memory-world.ts';

type World = Awaited<ReturnType<typeof fakeMemoryWorld>>;
type EpisodeView = { id: string; form: string; rendering: string; lifecycle: string; meaning: { text: string; revision: number } | null };

const MAINTAIN = { sessionLimit: 20, maxEntries: 200 };
const MINUTE = 60_000;

async function formation(world: World) {
  const report = await world.maintenance.run(await world.admit('maintenance'), MAINTAIN);
  if (!report.ok) throw new Error(JSON.stringify(report.error));
  return report.value;
}

/** A stored episode fixture; only the fields a scenario varies are parameters. */
function fixture(
  episodeId: string,
  source: Audience,
  participants: readonly ContactId[],
  from: string,
  minutes: number,
  summary: string,
  lifecycle: Episode['lifecycle'] = 'candidate',
): Episode {
  const to = new Date(Date.parse(from) + minutes * MINUTE).toISOString();
  return {
    id: episodeId,
    lifecycle,
    form: 'conversation',
    source,
    segments: [{ sessionId: id<'session'>(`session-${episodeId}`), fromSeq: 1, toSeq: 4 }],
    participantContactIds: participants,
    sourceTurnIds: [id<'turn'>(`turn-${episodeId}`)],
    occurredFrom: from,
    occurredTo: to,
    machineSignals: { authoredBy: 'runtime', producer: 'episode_synthesis', summary, salience: 0.5, themes: summary.toLowerCase().split(' ') },
    meaning: null,
    mergedInto: null,
    revision: 1,
    createdAt: from,
    updatedAt: to,
  };
}

async function store(world: World, ...episodes: Episode[]): Promise<void> {
  for (const episode of episodes) {
    const created = await world.episodes.createIfAbsent(episode);
    if (!created.ok) throw new Error(JSON.stringify(created.error));
  }
}

describe('episode formation from ended conversations', () => {
  it('keeps a short ended exchange as a brief episode without a model call', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    const sessionId = await world.converse(robin, 'hi!', 'hello Robin', 'k1');

    const early = await formation(world);
    expect(early.formation.map((f) => f.outcome)).toEqual(['not_ended']);
    expect(world.episodes.episodes.size).toBe(0);

    world.clock.advance(ENDED_AFTER_MS);
    const report = await formation(world);
    expect(report.formation[0]).toMatchObject({ sessionId, outcome: 'formed', episodes: [{ form: 'brief', created: true }] });
    expect(world.model.purposes()).not.toContain('episode_synthesis');
    const [episode] = [...world.episodes.episodes.values()];
    expect(episode?.machineSignals).toMatchObject({ authoredBy: 'runtime', producer: 'brief_exchange', summary: 'Brief exchange: hi!' });
    expect(episode?.participantContactIds).toEqual([world.people.primary]);
    const shown = await world.must<{ episode: EpisodeView }>(robin, 'episode', 'get', { episodeId: episode?.id });
    expect(shown.episode).toMatchObject({ form: 'brief', rendering: 'machine_draft' });
  });

  it('summarizes a longer conversation as attributed machine inference and reports non-conversational ranges', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    const long = 'We talked through the whole plan for the garden, the hives, the new fence and what to plant in spring. '.repeat(3);
    const sessionId = await world.converse(robin, long, 'That sounds like a lovely plan for the spring garden.', 'k1');
    world.clock.advance(50 * MINUTE);
    await world.archive.append([
      { entryId: 'note-1', sessionId, turnId: id<'turn'>('turn-note'), origin: { kind: 'system_note', source: 'host' }, text: 'reconnected', at: world.clock.now().toISOString() },
    ]);
    world.clock.advance(ENDED_AFTER_MS);
    world.model.replies.set('episode_synthesis', () => 'Robin and the companion planned the spring garden.');

    const report = await formation(world);
    const formed = report.formation.find((f) => f.sessionId === sessionId);
    expect(formed?.episodes).toEqual([{ episodeId: `episode:${sessionId}:1`, form: 'conversation', created: true }]);
    expect(formed?.noConversation).toEqual([{ fromSeq: 3, toSeq: 3 }]);
    const shown = await world.must<{ episode: { machineSignals: unknown } }>(robin, 'episode', 'get', { episodeId: `episode:${sessionId}:1` });
    expect(shown.episode.machineSignals).toMatchObject({
      summary: 'Robin and the companion planned the spring garden.',
      origin: { kind: 'machine_inference', producer: 'episode_synthesis' },
    });
  });

  it('returns the same episodes when a run is retried after its watermark failed to advance', async () => {
    const world = await fakeMemoryWorld();
    const sessionId = await world.converse(await world.admit('primary-dm'), 'hi!', 'hello Robin', 'k1');
    world.clock.advance(ENDED_AFTER_MS);
    const advance = world.formationCursors.advance.bind(world.formationCursors);
    world.formationCursors.advance = () => Promise.resolve(unavailable('cursors', 'down'));
    const failed = await formation(world);
    expect(failed.failures.map((f) => f.step)).toContain('episode_formation');
    const before = structuredClone([...world.episodes.episodes.values()]);

    world.formationCursors.advance = advance;
    const retried = await formation(world);
    expect(retried.formation[0]?.episodes).toEqual([{ episodeId: `episode:${sessionId}:1`, form: 'brief', created: false }]);
    expect([...world.episodes.episodes.values()].map((e) => e.id)).toEqual(before.map((e) => e.id));
  });
});

describe('episode meaning is the companion\'s and survives consolidation', () => {
  it('freezes an episode with meaning while merging its unauthored neighbours', async () => {
    const world = await fakeMemoryWorld();
    const robin = await world.admit('primary-dm');
    await world.converse(robin, 'hi!', 'hello Robin', 'k1');
    const source: Audience = { kind: 'direct', channelId: id('dm-primary'), contactId: world.people.primary };
    const people = [world.people.primary];
    await store(
      world,
      fixture('ep-a', source, people, '2029-12-31T10:00:00.000Z', 5, 'garden hives talk'),
      fixture('ep-b', source, people, '2029-12-31T10:15:00.000Z', 5, 'fence planning talk'),
      fixture('ep-c', source, people, '2029-12-31T10:30:00.000Z', 5, 'spring planting talk'),
    );
    const self = await world.admit('reflection');
    const authored = await world.must<EpisodeView>(self, 'episode', 'author_meaning', {
      episodeId: 'ep-a',
      text: 'The morning Robin trusted me with the hives.',
      expectedRevision: 0,
    });
    expect(authored).toMatchObject({ rendering: 'companion_meaning', meaning: { revision: 1 } });
    const before = world.episodes.episodes.get('ep-a');

    const report = await formation(world);
    expect(report.consolidation[0]).toEqual({
      conversation: 'channel:dm-primary',
      merged: [{ survivorId: 'ep-b', absorbedIds: ['ep-c'] }],
      promoted: ['ep-a'],
      frozen: ['ep-a'],
    });
    const after = world.episodes.episodes.get('ep-a');
    expect(after?.meaning).toEqual(before?.meaning);
    expect(after?.segments).toEqual(before?.segments);
    expect(after?.machineSignals).toEqual(before?.machineSignals);
    expect(after?.lifecycle).toBe('canonical');
    expect(world.episodes.meanings.get('ep-a')).toHaveLength(1);
    expect(world.episodes.episodes.get('ep-b')?.machineSignals).toMatchObject({
      producer: 'episode_consolidation',
      summary: 'fence planning talk Then: spring planting talk',
    });
    expect(kindOf(await world.call(robin, 'episode', 'get', { episodeId: 'ep-c' }))).toBe('not_found');

    // A second run changes nothing the companion wrote.
    await formation(world);
    expect(world.episodes.episodes.get('ep-a')?.meaning).toEqual(before?.meaning);
  });

  it('accepts meaning only from the companion in a self turn and compare-and-set on its revision', async () => {
    const world = await fakeMemoryWorld();
    const source: Audience = { kind: 'direct', channelId: id('dm-primary'), contactId: world.people.primary };
    await store(world, fixture('ep-a', source, [world.people.primary], '2029-12-31T10:00:00.000Z', 5, 'garden hives talk'));
    const fromRobin = await world.call(await world.admit('primary-dm'), 'episode', 'author_meaning', { episodeId: 'ep-a', text: 'x', expectedRevision: 0 });
    expect(kindOf(fromRobin)).toBe('denied');
    const self = await world.admit('reflection');
    await world.must(self, 'episode', 'author_meaning', { episodeId: 'ep-a', text: 'first', expectedRevision: 0 });
    const stale = await world.call(self, 'episode', 'author_meaning', { episodeId: 'ep-a', text: 'second', expectedRevision: 0 });
    expect(stale.ok || stale.error).toMatchObject({ kind: 'conflict', reason: 'stale_revision' });
    expect(world.episodes.episodes.get('ep-a')?.meaning?.text).toBe('first');
  });
});

describe('consolidation races and retries', () => {
  async function sitting(world: World) {
    await world.converse(await world.admit('primary-dm'), 'hi!', 'hello Robin', 'k1');
    const source: Audience = { kind: 'direct', channelId: id('dm-primary'), contactId: world.people.primary };
    const people = [world.people.primary];
    await store(
      world,
      fixture('ep-b', source, people, '2029-12-31T10:15:00.000Z', 5, 'fence planning talk'),
      fixture('ep-c', source, people, '2029-12-31T10:30:00.000Z', 5, 'spring planting talk'),
    );
  }

  it('never absorbs an episode whose meaning the companion wrote after the merge was planned', async () => {
    const world = await fakeMemoryWorld();
    await sitting(world);
    const self = await world.admit('reflection');
    let raced = false;
    world.episodes.beforeMerge = async () => {
      if (raced) return ok(undefined);
      raced = true;
      await world.must(self, 'episode', 'author_meaning', { episodeId: 'ep-c', text: 'The day Robin planned spring with me.', expectedRevision: 0 });
      return ok(undefined);
    };

    const first = await formation(world);
    // Extraction is unscripted here and fails on its own; only consolidation matters.
    expect(first.failures.filter((f) => f.step === 'consolidation').map((f) => f.error.kind)).toEqual(['conflict']);
    expect(world.episodes.episodes.get('ep-c')).toMatchObject({ lifecycle: 'candidate', mergedInto: null });
    expect(world.episodes.episodes.get('ep-b')?.segments).toHaveLength(1);

    const second = await formation(world);
    expect(second.consolidation.find((c) => c.conversation === 'channel:dm-primary')).toMatchObject({ merged: [], frozen: ['ep-c'] });
    const shown = await world.must<{ episode: EpisodeView }>(self, 'episode', 'get', { episodeId: 'ep-c' });
    expect(shown.episode).toMatchObject({ lifecycle: 'canonical', rendering: 'companion_meaning', meaning: { text: 'The day Robin planned spring with me.' } });
    expect(world.episodes.episodes.get('ep-b')?.machineSignals.summary).toBe('fence planning talk');
  });

  it('refuses any machine change but promotion to an episode that carries meaning', async () => {
    const world = await fakeMemoryWorld();
    await sitting(world);
    await world.must(await world.admit('reflection'), 'episode', 'author_meaning', { episodeId: 'ep-c', text: 'mine', expectedRevision: 0 });
    const current = world.episodes.episodes.get('ep-c') as Episode;
    expect(current.revision).toBe(2);
    const absorb = await world.episodes.saveMachine({ ...current, lifecycle: 'merged', mergedInto: 'ep-b', revision: 3 }, 2);
    expect(absorb.ok || absorb.error).toMatchObject({ kind: 'conflict' });
    const resummarize = await world.episodes.saveMachine({ ...current, machineSignals: { ...current.machineSignals, summary: 'other' }, revision: 3 }, 2);
    expect(resummarize.ok || resummarize.error).toMatchObject({ kind: 'conflict' });
    const merged = await world.episodes.merge(world.episodes.episodes.get('ep-b') as Episode, 1, [{ id: 'ep-c', expectedRevision: 2 }], current.updatedAt);
    expect(merged.ok || merged.error).toMatchObject({ kind: 'conflict' });
    const promoted = await world.episodes.saveMachine({ ...current, lifecycle: 'canonical', revision: 3 }, 2);
    expect(promoted.ok && promoted.value.meaning?.text).toBe('mine');
  });

  it('merges once when a run is retried after the merge failed', async () => {
    const world = await fakeMemoryWorld();
    await sitting(world);
    let failures = 1;
    world.episodes.beforeMerge = () => Promise.resolve(failures-- > 0 ? unavailable('episodes', 'down') : ok(undefined));
    const failed = await formation(world);
    expect(failed.failures.filter((f) => f.step === 'consolidation').map((f) => f.error.kind)).toEqual(['unavailable']);
    expect(world.episodes.episodes.get('ep-b')?.segments).toHaveLength(1);
    expect(world.episodes.episodes.get('ep-c')?.lifecycle).toBe('candidate');

    await formation(world);
    await formation(world);
    const survivor = world.episodes.episodes.get('ep-b');
    expect(survivor?.segments.map((s) => s.sessionId)).toEqual(['session-ep-b', 'session-ep-c']);
    expect(survivor?.machineSignals.summary).toBe('fence planning talk Then: spring planting talk');
    expect(world.episodes.episodes.get('ep-c')).toMatchObject({ lifecycle: 'merged', mergedInto: 'ep-b' });
  });

  it('adds nothing twice when merging an episode the survivor already covers', async () => {
    const world = await fakeMemoryWorld();
    const source: Audience = { kind: 'direct', channelId: id('dm-primary'), contactId: world.people.primary };
    const b = fixture('ep-b', source, [world.people.primary], '2029-12-31T10:15:00.000Z', 5, 'fence planning talk');
    const c = fixture('ep-c', source, [world.people.primary], '2029-12-31T10:30:00.000Z', 5, 'spring planting talk');
    const once = mergeEpisodes(b, [c], c.updatedAt);
    const twice = mergeEpisodes(once, [c], c.updatedAt);
    expect(twice.segments).toEqual(once.segments);
    expect(twice.machineSignals.summary).toBe(once.machineSignals.summary);
  });
});

describe('episode meaning is companion-private', () => {
  it('shows meaning only to self readers and never lets it decide search results', async () => {
    const world = await fakeMemoryWorld();
    const room: Audience = { kind: 'group', channelId: id('room-a'), room: 'small_group' };
    await store(world, fixture('ep-g', room, [world.people.friend], '2029-12-27T10:00:00.000Z', 30, 'garden talk', 'canonical'));
    const self = await world.admit('reflection');
    await world.must(self, 'episode', 'author_meaning', { episodeId: 'ep-g', text: 'private worry about resentment', expectedRevision: 0 });
    await formation(world);
    const embedded = world.embeddings.calls.flatMap((c) => c.texts);
    expect(embedded).toContain('garden talk');
    expect(embedded.join('\n')).not.toContain('resentment');

    const samGroup = await world.admit('friend-group');
    const readers = {
      lee: await world.admit('acq-group'),
      samDm: await world.admit('friend-dm'),
      samGroup,
      groupWorker: must(
        deriveWorkerScope(samGroup, id('run-1'), {
          actions: [{ tool: 'episode', action: 'get' }, { tool: 'episode', action: 'search' }, { tool: 'episode', action: 'timeline' }],
          maxTurns: 2,
          maxSensitivity: 'personal',
        }),
      ),
      selfWorker: must(
        deriveWorkerScope(self, id('run-2'), {
          actions: [{ tool: 'episode', action: 'get' }, { tool: 'episode', action: 'search' }, { tool: 'episode', action: 'timeline' }],
          maxTurns: 2,
          maxSensitivity: 'personal',
        }),
      ),
    };
    const draft = { rendering: 'machine_draft', meaning: null };
    const read: string[] = [];
    for (const [name, scope] of Object.entries(readers)) {
      const got = await world.call(scope, 'episode', 'get', { episodeId: 'ep-g' });
      if (!got.ok) {
        expect(got.error.kind, name).toBe('not_found');
        continue;
      }
      read.push(name);
      expect((got.value.content as { episode: EpisodeView }).episode, name).toMatchObject(draft);
      const found = await world.must<{ episodes: EpisodeView[] }>(scope, 'episode', 'search', { query: 'garden' });
      for (const episode of found.episodes) expect(episode, name).toMatchObject(draft);
      const day = await world.must<EpisodeView[]>(scope, 'episode', 'timeline', { date: '2029-12-27' });
      for (const episode of day) expect(episode, name).toMatchObject(draft);
    }
    expect(read).toEqual(['lee', 'samDm', 'samGroup', 'groupWorker', 'selfWorker']);
    const background = await world.call(readers.samGroup, 'memory', 'shared_background', { contactId: world.people.friend });
    for (const episode of background.ok ? (background.value.content as { episodes: EpisodeView[] }).episodes : []) expect(episode).toMatchObject(draft);
    expect(background.ok && (background.value.content as { episodes: EpisodeView[] }).episodes.map((e) => e.id)).toEqual(['ep-g']);

    // Meaning is not indexed: even an unrestricted lexical search cannot match or rank on it.
    const byMeaning = await world.episodes.searchLexical(accessOf(self), 'resentment worry', 10);
    expect(byMeaning.ok && byMeaning.value).toEqual([]);

    const own = await world.must<{ episode: EpisodeView }>(self, 'episode', 'get', { episodeId: 'ep-g' });
    expect(own.episode).toMatchObject({ rendering: 'companion_meaning', meaning: { text: 'private worry about resentment' } });
    const ownBackground = await world.must<{ episodes: EpisodeView[] }>(self, 'memory', 'shared_background', { contactId: world.people.friend });
    expect(ownBackground.episodes[0]?.meaning?.text).toBe('private worry about resentment');
  });
});

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe('episode privacy', () => {
  it('withholds an arc whole when any member is unreadable, and filters search and timeline', async () => {
    const world = await fakeMemoryWorld();
    const sam = world.people.friend;
    const dm: Audience = { kind: 'direct', channelId: id('dm-friend'), contactId: sam };
    const room: Audience = { kind: 'group', channelId: id('room-a'), room: 'small_group' };
    await store(
      world,
      fixture('ep-dm', dm, [sam], '2029-12-27T10:00:00.000Z', 30, 'cello orchestra concert rehearsal', 'canonical'),
      fixture('ep-room', room, [sam], '2029-12-29T10:00:00.000Z', 30, 'cello orchestra concert tickets', 'canonical'),
    );
    const report = await formation(world);
    expect(report.arcs?.arcs).toEqual([{ arcId: 'arc:ep-dm', episodeIds: ['ep-dm', 'ep-room'], created: true }]);

    const arcsFor = async (token: string, episodeId: string) =>
      (await world.must<{ arcs: { id: string }[] }>(await world.admit(token), 'episode', 'get', { episodeId })).arcs.map((a) => a.id);
    expect(await arcsFor('friend-dm', 'ep-dm')).toEqual(['arc:ep-dm']);
    expect(await arcsFor('reflection', 'ep-room')).toEqual(['arc:ep-dm']);
    // Robin in the room reads the room episode but not Sam's DM, so the arc is withheld.
    expect(await arcsFor('primary-group', 'ep-room')).toEqual([]);

    const robinRoom = await world.admit('primary-group');
    const found = await world.must<{ episodes: EpisodeView[] }>(robinRoom, 'episode', 'search', { query: 'cello concert' });
    expect(found.episodes.map((e) => e.id)).toEqual(['ep-room']);
    expect(kindOf(await world.call(robinRoom, 'episode', 'get', { episodeId: 'ep-dm' }))).toBe('not_found');

    const samDay = await world.must<EpisodeView[]>(await world.admit('friend-dm'), 'episode', 'timeline', { date: '2029-12-27' });
    expect(samDay.map((e) => e.id)).toEqual(['ep-dm']);
    const robinDay = await world.must<EpisodeView[]>(await world.admit('primary-dm'), 'episode', 'timeline', { date: '2029-12-27' });
    expect(robinDay).toEqual([]);
  });

  it('shares an episode only with its participants or its room', async () => {
    const world = await fakeMemoryWorld();
    const dm: Audience = { kind: 'direct', channelId: id('dm-friend'), contactId: world.people.friend };
    await store(world, fixture('ep-dm', dm, [world.people.friend], '2029-12-27T10:00:00.000Z', 30, 'cello rehearsal', 'canonical'));
    const background = await world.must<{ episodes: EpisodeView[] }>(await world.admit('reflection'), 'memory', 'shared_background', {
      contactId: world.people.friend,
    });
    expect(background.episodes.map((e) => e.id)).toEqual(['ep-dm']);
    const fromLee = await world.must<{ episodes: EpisodeView[] }>(await world.admit('acq-dm'), 'episode', 'search', { query: 'cello' });
    expect(fromLee.episodes).toEqual([]);
  });
});

describe('maintenance composition', () => {
  it('runs the ordered passes without a wiki and reports each failure instead of hiding it', async () => {
    const world = await fakeMemoryWorld();
    await world.converse(await world.admit('friend-dm'), 'I moved to Lisbon and started a new job at the harbour office this month. '.repeat(4), 'Congratulations!', 'k1');
    world.clock.advance(ENDED_AFTER_MS);
    const report = await formation(world);
    expect(Object.keys(report).sort()).toEqual(['arcs', 'backfill', 'consolidation', 'extraction', 'failures', 'formation', 'usage']);
    // Neither extraction nor synthesis is scripted: both fail loudly and keep their watermarks.
    expect(report.failures.map((f) => [f.step, f.error.kind])).toEqual([
      ['extraction', 'unavailable'],
      ['episode_formation', 'unavailable'],
    ]);
    const sessionId = report.failures[0]?.subject as SessionId;
    const cursor = await world.formationCursors.get(sessionId);
    expect(cursor.ok && cursor.value.seq).toBe(0);
    expect(world.model.purposes()).toEqual(['memory_extraction', 'episode_synthesis']);
  });
});
