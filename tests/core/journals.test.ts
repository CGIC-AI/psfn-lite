import { describe, expect, it } from 'vitest';
import { deriveWorkerScope } from '../../packages/core/src/index.ts';
import { id } from './fakes.ts';
import { fakeMemoryWorld, kindOf } from './memory-world.ts';

type Note = { path: string; provenance: { scope: string }; body: string; revision: number; author: unknown };
type Letter = { id: string; state: string; author: string; body: string };

describe('journal provenance', () => {
  it('stamps notes with their source conversation and hides them where that source is not readable', async () => {
    const world = await fakeMemoryWorld();
    const sam = await world.admit('friend-dm');
    const note = await world.must<Note>(sam, 'journal', 'write', { path: 'people/sam.md', body: 'Sam is learning the cello.' });
    expect(note.provenance).toEqual({ scope: 'conversation', source: { kind: 'direct', channelId: 'dm-friend', contactId: world.people.friend } });
    expect(note.author).toEqual({ kind: 'companion' });

    for (const token of ['acq-dm', 'friend-group']) {
      const scope = await world.admit(token);
      expect(kindOf(await world.call(scope, 'journal', 'read', { path: 'people/sam.md' })), token).toBe('not_found');
      expect(await world.must(scope, 'journal', 'list'), token).toEqual([]);
      expect(await world.must(scope, 'journal', 'search', { query: 'cello' }), token).toEqual([]);
      expect(kindOf(await world.call(scope, 'journal', 'append', { path: 'people/sam.md', text: 'probe' })), token).toBe('not_found');
      expect(kindOf(await world.call(scope, 'journal', 'write', { path: 'people/sam.md', body: 'x', expectedRevision: 1 })), token).toBe('not_found');
    }
    expect(world.journalNotes.notes.get('people/sam.md')?.body).toBe('Sam is learning the cello.');
  });

  it('overwrites only with the current revision and rejects paths outside the journal', async () => {
    const world = await fakeMemoryWorld();
    const sam = await world.admit('friend-dm');
    await world.must(sam, 'journal', 'write', { path: 'people/sam.md', body: 'first' });
    const blind = await world.call(sam, 'journal', 'write', { path: 'people/sam.md', body: 'second' });
    expect(blind.ok || blind.error).toMatchObject({ kind: 'conflict', reason: 'stale_revision' });
    const next = await world.must<Note>(sam, 'journal', 'write', { path: 'people/sam.md', body: 'second', expectedRevision: 1 });
    expect(next.revision).toBe(2);
    for (const path of ['../secrets', '/etc/passwd', 'People/Sam.md', 'a//b']) {
      expect(kindOf(await world.call(sam, 'journal', 'write', { path, body: 'x' })), path).toBe('invalid');
    }
  });

  it('makes self-turn notes restricted, and a note merged across conversations restricted', async () => {
    const world = await fakeMemoryWorld();
    const self = await world.admit('reflection');
    const own = await world.must<Note>(self, 'journal', 'write', { path: 'self/today.md', body: 'A quiet day.' });
    expect(own.provenance).toEqual({ scope: 'restricted' });
    const sam = await world.admit('friend-dm');
    expect(kindOf(await world.call(sam, 'journal', 'read', { path: 'self/today.md' }))).toBe('not_found');
    expect((await world.must<Note>(await world.admit('primary-dm'), 'journal', 'read', { path: 'self/today.md' })).body).toBe('A quiet day.');

    await world.must(sam, 'journal', 'write', { path: 'people/sam.md', body: 'Sam is learning the cello.' });
    const sameRoom = await world.must<Note>(sam, 'journal', 'append', { path: 'people/sam.md', text: 'Lessons on Tuesdays.' });
    expect(sameRoom.provenance.scope).toBe('conversation');
    const merged = await world.must<Note>(self, 'journal', 'append', { path: 'people/sam.md', text: 'I want to hear a recital.' });
    expect(merged).toMatchObject({ provenance: { scope: 'restricted' }, body: 'Sam is learning the cello.\nLessons on Tuesdays.\nI want to hear a recital.' });
    expect(kindOf(await world.call(sam, 'journal', 'read', { path: 'people/sam.md' }))).toBe('not_found');
  });
});

describe('reflections keep authorship', () => {
  it('records the companion\'s own reflection only from its internal turn and process output as a process log', async () => {
    const world = await fakeMemoryWorld();
    const self = await world.admit('reflection');
    const own = await world.journal.recordReflection(self, { reflectionId: 'r1', templateId: 'evening', kind: 'companion_reflection', text: 'I felt close to Robin.' });
    expect(own.ok && own.value.author).toEqual({ kind: 'companion' });
    const log = await world.journal.recordReflection(self, { reflectionId: 'r2', templateId: 'evening', kind: 'process_log', text: 'pass ran' });
    expect(log.ok && log.value.author).toEqual({ kind: 'machine', producer: 'reflection:evening' });

    const fromRobin = await world.journal.recordReflection(await world.admit('primary-dm'), {
      reflectionId: 'r3',
      templateId: 'evening',
      kind: 'companion_reflection',
      text: 'x',
    });
    expect(fromRobin.ok || fromRobin.error).toMatchObject({ kind: 'denied', reason: 'requires_self_audience' });
    const worker = deriveWorkerScope(self, id('run-1'), { actions: [], maxTurns: 1, maxSensitivity: 'confidential' });
    if (!worker.ok) throw new Error('worker');
    const fromWorker = await world.journal.recordReflection(worker.value, { reflectionId: 'r4', templateId: 'evening', kind: 'companion_reflection', text: 'x' });
    expect(fromWorker.ok || fromWorker.error).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });

    const listed = await world.must<{ id: string; kind: string }[]>(self, 'journal', 'reflections_list');
    expect(listed.map((r) => [r.id, r.kind]).sort()).toEqual([
      ['r1', 'companion_reflection'],
      ['r2', 'process_log'],
    ]);
    expect(kindOf(await world.call(await world.admit('friend-dm'), 'journal', 'reflections_list'))).toBe('denied');
  });
});

describe('letters', () => {
  it('composes idempotently, records reading as lived history and never shows the Partner\'s drafts', async () => {
    const world = await fakeMemoryWorld();
    const self = await world.admit('reflection');
    const draft = await world.must<{ letter: Letter; created: boolean }>(self, 'journal', 'letter_compose', {
      letterId: 'l1',
      subject: 'Spring',
      body: 'The hives are waking up.',
      draft: true,
    });
    expect(draft).toMatchObject({ created: true, letter: { state: 'draft', author: 'companion' } });
    const again = await world.must<{ created: boolean }>(self, 'journal', 'letter_compose', { letterId: 'l1', subject: 'Spring', body: 'The hives are waking up.', draft: true });
    expect(again.created).toBe(false);
    const reused = await world.call(self, 'journal', 'letter_compose', { letterId: 'l1', subject: 'Spring', body: 'Different', draft: true });
    expect(reused.ok || reused.error).toMatchObject({ kind: 'conflict', reason: 'idempotency_mismatch' });
    expect((await world.must<Letter>(self, 'journal', 'letter_place', { letterId: 'l1' })).state).toBe('placed');

    const delivered = await world.letterAdministration.deliverFromPartner({ letterId: 'p1', subject: 'Hello', body: 'Thinking of you.' });
    expect(delivered.ok).toBe(true);
    const partnerDraft = { ...(delivered.ok ? delivered.value : ({} as never)), id: 'p2', state: 'draft' as const, placedAt: null, body: 'unfinished' };
    await world.letters.create(partnerDraft, { letterId: 'p2', kind: 'composed', by: 'partner', at: partnerDraft.createdAt });

    const inbox = await world.must<Letter[]>(self, 'journal', 'letter_list', { direction: 'inbox' });
    expect(inbox.map((l) => l.id)).toEqual(['p1']);
    expect(kindOf(await world.call(self, 'journal', 'letter_read', { letterId: 'p2' }))).toBe('not_found');
    const read = await world.must<Letter>(self, 'journal', 'letter_read', { letterId: 'p1' });
    expect(read.state).toBe('read');
    const history = await world.letters.events('p1', 10);
    expect(history.ok && history.value.map((e) => [e.kind, e.by])).toEqual([
      ['composed', 'partner'],
      ['read', 'companion'],
    ]);
    expect((await world.must<Letter>(self, 'journal', 'letter_archive', { letterId: 'p1' })).state).toBe('archived');
    expect(kindOf(await world.call(await world.admit('friend-dm'), 'journal', 'letter_list'))).toBe('denied');
  });
});
