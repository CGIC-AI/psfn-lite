/**
 * Test-only in-memory fakes of the memory, episode and journal ports. Filtered
 * reads apply the same core access predicates the Postgres stores implement
 * in SQL, before limits, and compare-and-set and idempotency follow the
 * documented contracts. Embeddings are deterministic hashed bags of words.
 */
import { createHash } from 'node:crypto';
import {
  conflict,
  cosine,
  episodeReadable,
  journalReadable,
  lexicalTokens,
  memoryReadable,
  notFound,
  ok,
  subjectKey,
  unavailable,
  type ContactId,
  type EmbeddingPort,
  type EmbeddingSpace,
  type Episode,
  type EpisodeArc,
  type EpisodeHit,
  type EpisodeMeaning,
  type EpisodeStorePort,
  type IdempotencyKey,
  type JournalNote,
  type JournalNotePort,
  type Letter,
  type LetterEvent,
  type LetterPort,
  type MemoryCandidate,
  type MemoryDeletionPort,
  type MemoryDeletionProposal,
  type MemoryEvent,
  type MemoryHit,
  type MemoryInsert,
  type MemoryKind,
  type MemoryLink,
  type MemoryRecord,
  type MemoryStorePort,
  type MemorySubject,
  type MemoryWriteReceipt,
  type ModelPort,
  type ReflectionEntry,
  type ReflectionPort,
  type Result,
  type ScratchpadNote,
  type ScratchpadPort,
  type SessionCursorPort,
  type SessionId,
  type SourceAccess,
} from '../../packages/core/src/index.ts';

export const SPACE: EmbeddingSpace = { name: 'test-hash', dimensions: 16 };

/** Hashed bag of words, L2-normalised: texts sharing words are close. */
export function hashEmbedding(text: string, dimensions = SPACE.dimensions): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of lexicalTokens(text)) {
    const bucket = createHash('sha256').update(token).digest().readUInt32BE(0) % dimensions;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((n, x) => n + x * x, 0)) || 1;
  return vector.map((x) => x / norm);
}

export class FakeEmbeddings implements EmbeddingPort {
  readonly calls: { texts: readonly string[]; purpose: string }[] = [];
  failing = false;
  wrongDimensions = false;
  embed(texts: readonly string[], attribution: Parameters<EmbeddingPort['embed']>[1]): ReturnType<EmbeddingPort['embed']> {
    this.calls.push({ texts, purpose: attribution.purpose });
    if (this.failing) return Promise.resolve(unavailable('embeddings', 'embedding provider is down'));
    return Promise.resolve(ok(texts.map((t) => hashEmbedding(t, this.wrongDimensions ? SPACE.dimensions + 1 : SPACE.dimensions))));
  }
}

/** A model that answers by purpose; unscripted purposes fail loudly. */
export class ScriptedModel implements ModelPort {
  readonly calls: Parameters<ModelPort['complete']>[0][] = [];
  readonly replies = new Map<string, (request: Parameters<ModelPort['complete']>[0]) => string>();
  complete(request: Parameters<ModelPort['complete']>[0]): ReturnType<ModelPort['complete']> {
    this.calls.push(request);
    const reply = this.replies.get(request.attribution.purpose);
    if (reply === undefined) return Promise.resolve(unavailable('model', `no scripted reply for ${request.attribution.purpose}`));
    return Promise.resolve(ok({ text: reply(request), inputTokens: 10, outputTokens: 5 }));
  }
  purposes(): string[] {
    return this.calls.map((c) => c.attribution.purpose);
  }
}

function lexicalScore(text: string, query: string): number {
  const tokens = lexicalTokens(query);
  const haystack = text.toLowerCase();
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  return tokens.length === 0 ? 0 : hits / tokens.length;
}

export class FakeMemoryStore implements MemoryStorePort {
  readonly records = new Map<string, MemoryRecord>();
  readonly vectors = new Map<string, number[]>();
  readonly receipts = new Map<string, MemoryWriteReceipt>();
  readonly linkRows: MemoryLink[] = [];
  readonly eventRows: MemoryEvent[] = [];

  get(id: string): Promise<Result<MemoryRecord>> {
    const found = this.records.get(id);
    return Promise.resolve(found === undefined ? notFound(`memory ${id}`) : ok(found));
  }
  receipt(key: IdempotencyKey): Promise<Result<MemoryWriteReceipt | null>> {
    return Promise.resolve(ok(this.receipts.get(key) ?? null));
  }
  candidates(subject: MemorySubject, kind: MemoryKind, space: EmbeddingSpace): Promise<Result<readonly MemoryCandidate[]>> {
    const key = subjectKey(subject);
    const out = [...this.records.values()]
      .filter((r) => r.state === 'current' && r.kind === kind && subjectKey(r.subject) === key)
      .reverse()
      .map((record) => ({ record, vector: this.vectors.get(`${record.id}|${space.name}`) ?? null }));
    return Promise.resolve(ok(out));
  }
  private visible(access: SourceAccess): MemoryRecord[] {
    return [...this.records.values()].filter((r) => memoryReadable(access, r));
  }
  searchLexical(access: SourceAccess, query: string, limit: number): Promise<Result<readonly MemoryHit[]>> {
    const hits = this.visible(access)
      .map((record) => ({ record, score: lexicalScore(record.content, query) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score);
    return Promise.resolve(ok(hits.slice(0, limit)));
  }
  searchSemantic(access: SourceAccess, space: EmbeddingSpace, vector: readonly number[], limit: number): Promise<Result<readonly MemoryHit[]>> {
    const hits = this.visible(access)
      .flatMap((record) => {
        const stored = this.vectors.get(`${record.id}|${space.name}`);
        return stored === undefined ? [] : [{ record, score: cosine(stored, vector) }];
      })
      .sort((a, b) => b.score - a.score);
    return Promise.resolve(ok(hits.slice(0, limit)));
  }
  aboutContact(access: SourceAccess, contactId: ContactId, limit: number): Promise<Result<readonly MemoryRecord[]>> {
    return Promise.resolve(
      ok(this.visible(access).filter((r) => r.subject.kind === 'contacts' && r.subject.contactIds.includes(contactId)).reverse().slice(0, limit)),
    );
  }
  census(access: SourceAccess): Promise<Result<Readonly<Partial<Record<MemoryKind, number>>>>> {
    const counts: Partial<Record<MemoryKind, number>> = {};
    for (const r of this.visible(access)) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    return Promise.resolve(ok(counts));
  }
  insert(input: MemoryInsert): Promise<Result<MemoryRecord>> {
    if (this.receipts.has(input.receipt.idempotencyKey)) return Promise.resolve(conflict('idempotency_mismatch', 'key used'));
    for (const s of input.supersede) {
      if (this.records.get(s.id)?.revision !== s.expectedRevision) return Promise.resolve(conflict('stale_revision', `memory ${s.id} moved`));
    }
    for (const s of input.supersede) {
      const old = this.records.get(s.id) as MemoryRecord;
      this.records.set(s.id, { ...old, state: 'superseded', supersededBy: input.record.id, revision: old.revision + 1, updatedAt: input.record.createdAt });
    }
    this.records.set(input.record.id, input.record);
    if (input.vector !== null) this.vectors.set(`${input.record.id}|${input.vector.space.name}`, [...input.vector.values]);
    this.receipts.set(input.receipt.idempotencyKey, input.receipt);
    this.linkRows.push(...input.links);
    this.eventRows.push(...input.events);
    return Promise.resolve(ok(input.record));
  }
  reinforce(receipt: MemoryWriteReceipt, event: MemoryEvent): Promise<Result<void>> {
    if (this.receipts.has(receipt.idempotencyKey)) return Promise.resolve(conflict('idempotency_mismatch', 'key used'));
    this.receipts.set(receipt.idempotencyKey, receipt);
    this.eventRows.push(event);
    return Promise.resolve(ok(undefined));
  }
  update(record: MemoryRecord, expectedRevision: number, event: MemoryEvent): Promise<Result<MemoryRecord>> {
    const current = this.records.get(record.id);
    if (current === undefined) return Promise.resolve(notFound(`memory ${record.id}`));
    if (current.revision !== expectedRevision) return Promise.resolve(conflict('stale_revision', 'memory moved'));
    if (current.content !== record.content) for (const key of [...this.vectors.keys()]) if (key.startsWith(`${record.id}|`)) this.vectors.delete(key);
    this.records.set(record.id, record);
    this.eventRows.push(event);
    return Promise.resolve(ok(record));
  }
  putEmbedding(memoryId: string, space: EmbeddingSpace, vector: readonly number[]): Promise<Result<void>> {
    this.vectors.set(`${memoryId}|${space.name}`, [...vector]);
    return Promise.resolve(ok(undefined));
  }
  pendingEmbeddings(space: EmbeddingSpace, limit: number): Promise<Result<readonly MemoryRecord[]>> {
    return Promise.resolve(ok([...this.records.values()].filter((r) => r.state === 'current' && !this.vectors.has(`${r.id}|${space.name}`)).slice(0, limit)));
  }
  links(memoryId: string): Promise<Result<readonly MemoryLink[]>> {
    return Promise.resolve(ok(this.linkRows.filter((l) => l.fromId === memoryId || l.toId === memoryId)));
  }
  events(memoryId: string, limit: number): Promise<Result<readonly MemoryEvent[]>> {
    return Promise.resolve(ok(this.eventRows.filter((e) => e.memoryId === memoryId).slice(-limit)));
  }
  staged(limit: number): Promise<Result<readonly MemoryRecord[]>> {
    return Promise.resolve(ok([...this.records.values()].filter((r) => r.state === 'staged').slice(0, limit)));
  }
}

export class FakeDeletions implements MemoryDeletionPort {
  readonly proposals = new Map<string, MemoryDeletionProposal>();
  create(proposal: MemoryDeletionProposal): Promise<Result<MemoryDeletionProposal>> {
    if (this.proposals.has(proposal.proposalId)) return Promise.resolve(conflict('already_exists', 'proposal exists'));
    this.proposals.set(proposal.proposalId, proposal);
    return Promise.resolve(ok(proposal));
  }
  get(proposalId: string): Promise<Result<MemoryDeletionProposal>> {
    const found = this.proposals.get(proposalId);
    return Promise.resolve(found === undefined ? notFound(`proposal ${proposalId}`) : ok(found));
  }
  latestFor(memoryId: string, status: MemoryDeletionProposal['status']): Promise<Result<MemoryDeletionProposal | null>> {
    return Promise.resolve(ok([...this.proposals.values()].filter((p) => p.memoryId === memoryId && p.status === status).at(-1) ?? null));
  }
  save(proposal: MemoryDeletionProposal, expectedRevision: number): Promise<Result<MemoryDeletionProposal>> {
    if (this.proposals.get(proposal.proposalId)?.revision !== expectedRevision) return Promise.resolve(conflict('stale_revision', 'proposal moved'));
    this.proposals.set(proposal.proposalId, proposal);
    return Promise.resolve(ok(proposal));
  }
}

export class FakeScratchpad implements ScratchpadPort {
  readonly notes = new Map<string, ScratchpadNote>();
  list(conversation: string, now: string, limit: number): Promise<Result<readonly ScratchpadNote[]>> {
    return Promise.resolve(
      ok(
        [...this.notes.values()]
          .filter((n) => n.expiresAt >= now && (n.scope.kind === 'companion_global' || n.scope.conversation === conversation))
          .slice(0, limit),
      ),
    );
  }
  get(id: string): Promise<Result<ScratchpadNote>> {
    const found = this.notes.get(id);
    return Promise.resolve(found === undefined ? notFound(`note ${id}`) : ok(found));
  }
  put(note: ScratchpadNote, expectedRevision: number | null): Promise<Result<ScratchpadNote>> {
    const current = this.notes.get(note.id);
    if ((current?.revision ?? null) !== expectedRevision) return Promise.resolve(conflict('stale_revision', 'note moved'));
    this.notes.set(note.id, note);
    return Promise.resolve(ok(note));
  }
  remove(id: string, expectedRevision: number): Promise<Result<void>> {
    if (this.notes.get(id)?.revision !== expectedRevision) return Promise.resolve(conflict('stale_revision', 'note moved'));
    this.notes.delete(id);
    return Promise.resolve(ok(undefined));
  }
}

export class FakeCursors implements SessionCursorPort {
  readonly cursors = new Map<SessionId, { seq: number; revision: number }>();
  get(sessionId: SessionId): Promise<Result<{ readonly seq: number; readonly revision: number }>> {
    return Promise.resolve(ok(this.cursors.get(sessionId) ?? { seq: 0, revision: 0 }));
  }
  advance(sessionId: SessionId, seq: number, expectedRevision: number): Promise<Result<void>> {
    const current = this.cursors.get(sessionId) ?? { seq: 0, revision: 0 };
    if (current.revision !== expectedRevision) return Promise.resolve(conflict('stale_revision', 'cursor moved'));
    this.cursors.set(sessionId, { seq, revision: expectedRevision + 1 });
    return Promise.resolve(ok(undefined));
  }
}

export class FakeEpisodes implements EpisodeStorePort {
  readonly episodes = new Map<string, Episode>();
  readonly meanings = new Map<string, EpisodeMeaning[]>();
  readonly vectors = new Map<string, number[]>();
  readonly arcs = new Map<string, EpisodeArc>();

  get(id: string): Promise<Result<Episode>> {
    const found = this.episodes.get(id);
    return Promise.resolve(found === undefined ? notFound(`episode ${id}`) : ok(found));
  }
  createIfAbsent(episode: Episode): Promise<Result<{ readonly episode: Episode; readonly created: boolean }>> {
    const existing = this.episodes.get(episode.id);
    if (existing !== undefined) return Promise.resolve(ok({ episode: existing, created: false }));
    this.episodes.set(episode.id, { ...episode, meaning: null });
    return Promise.resolve(ok({ episode: { ...episode, meaning: null }, created: true }));
  }
  saveMachine(episode: Episode, expectedRevision: number): Promise<Result<Episode>> {
    const current = this.episodes.get(episode.id);
    if (current === undefined) return Promise.resolve(notFound(`episode ${episode.id}`));
    if (current.revision !== expectedRevision) return Promise.resolve(conflict('stale_revision', 'episode moved'));
    const saved = { ...episode, meaning: current.meaning };
    this.episodes.set(episode.id, saved);
    for (const key of [...this.vectors.keys()]) if (key.startsWith(`${episode.id}|`)) this.vectors.delete(key);
    return Promise.resolve(ok(saved));
  }
  setMeaning(episodeId: string, meaning: EpisodeMeaning, expectedMeaningRevision: number): Promise<Result<Episode>> {
    const current = this.episodes.get(episodeId);
    if (current === undefined) return Promise.resolve(notFound(`episode ${episodeId}`));
    if ((current.meaning?.revision ?? 0) !== expectedMeaningRevision) return Promise.resolve(conflict('stale_revision', 'meaning moved'));
    const saved = { ...current, meaning };
    this.episodes.set(episodeId, saved);
    this.meanings.set(episodeId, [...(this.meanings.get(episodeId) ?? []), meaning]);
    for (const key of [...this.vectors.keys()]) if (key.startsWith(`${episodeId}|`)) this.vectors.delete(key);
    return Promise.resolve(ok(saved));
  }
  meaningHistory(episodeId: string): Promise<Result<readonly EpisodeMeaning[]>> {
    return Promise.resolve(ok(this.meanings.get(episodeId) ?? []));
  }
  private visible(access: SourceAccess): Episode[] {
    return [...this.episodes.values()].filter((e) => episodeReadable(access, e));
  }
  searchLexical(access: SourceAccess, query: string, limit: number): Promise<Result<readonly EpisodeHit[]>> {
    const hits = this.visible(access)
      .map((episode) => ({ episode, score: lexicalScore(`${episode.machineSignals.summary} ${episode.meaning?.text ?? ''}`, query) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score);
    return Promise.resolve(ok(hits.slice(0, limit)));
  }
  searchSemantic(access: SourceAccess, space: EmbeddingSpace, vector: readonly number[], limit: number): Promise<Result<readonly EpisodeHit[]>> {
    const hits = this.visible(access)
      .flatMap((episode) => {
        const stored = this.vectors.get(`${episode.id}|${space.name}`);
        return stored === undefined ? [] : [{ episode, score: cosine(stored, vector) }];
      })
      .sort((a, b) => b.score - a.score);
    return Promise.resolve(ok(hits.slice(0, limit)));
  }
  timeline(access: SourceAccess, from: string, to: string, limit: number): Promise<Result<readonly Episode[]>> {
    return Promise.resolve(
      ok(this.visible(access).filter((e) => e.occurredTo >= from && e.occurredFrom <= to).sort((a, b) => (a.occurredFrom < b.occurredFrom ? -1 : 1)).slice(0, limit)),
    );
  }
  withParticipant(access: SourceAccess, contactId: ContactId, limit: number): Promise<Result<readonly Episode[]>> {
    return Promise.resolve(ok(this.visible(access).filter((e) => e.participantContactIds.includes(contactId)).slice(0, limit)));
  }
  inConversation(conversation: string, limit: number): Promise<Result<readonly Episode[]>> {
    const key = (e: Episode) => (e.source.kind === 'self' ? 'self' : `channel:${e.source.channelId}`);
    return Promise.resolve(
      ok([...this.episodes.values()].filter((e) => e.lifecycle !== 'merged' && key(e) === conversation).sort((a, b) => (a.occurredFrom < b.occurredFrom ? -1 : 1)).slice(0, limit)),
    );
  }
  canonicalSince(since: string, limit: number): Promise<Result<readonly Episode[]>> {
    return Promise.resolve(
      ok([...this.episodes.values()].filter((e) => e.lifecycle === 'canonical' && e.occurredTo >= since).sort((a, b) => (a.occurredFrom < b.occurredFrom ? -1 : 1)).slice(0, limit)),
    );
  }
  putEmbedding(episodeId: string, space: EmbeddingSpace, vector: readonly number[]): Promise<Result<void>> {
    this.vectors.set(`${episodeId}|${space.name}`, [...vector]);
    return Promise.resolve(ok(undefined));
  }
  pendingEmbeddings(space: EmbeddingSpace, limit: number): Promise<Result<readonly Episode[]>> {
    return Promise.resolve(ok([...this.episodes.values()].filter((e) => e.lifecycle !== 'merged' && !this.vectors.has(`${e.id}|${space.name}`)).slice(0, limit)));
  }
  arcsContaining(episodeId: string): Promise<Result<readonly EpisodeArc[]>> {
    return Promise.resolve(ok([...this.arcs.values()].filter((a) => a.episodeIds.includes(episodeId))));
  }
  getArc(arcId: string): Promise<Result<EpisodeArc>> {
    const found = this.arcs.get(arcId);
    return Promise.resolve(found === undefined ? notFound(`arc ${arcId}`) : ok(found));
  }
  saveArc(arc: EpisodeArc, expectedRevision: number | null): Promise<Result<EpisodeArc>> {
    if ((this.arcs.get(arc.id)?.revision ?? null) !== expectedRevision) return Promise.resolve(conflict('stale_revision', 'arc moved'));
    this.arcs.set(arc.id, arc);
    return Promise.resolve(ok(arc));
  }
}

export class FakeJournal implements JournalNotePort {
  readonly notes = new Map<string, JournalNote>();
  get(path: string): Promise<Result<JournalNote>> {
    const found = this.notes.get(path);
    return Promise.resolve(found === undefined ? notFound(`journal note ${path}`) : ok(found));
  }
  list(access: SourceAccess, limit: number): Promise<Result<readonly JournalNote[]>> {
    return Promise.resolve(ok([...this.notes.values()].filter((n) => journalReadable(access, n.provenance)).slice(0, limit)));
  }
  search(access: SourceAccess, query: string, limit: number): Promise<Result<readonly JournalNote[]>> {
    return Promise.resolve(
      ok([...this.notes.values()].filter((n) => journalReadable(access, n.provenance) && lexicalScore(n.body, query) > 0).slice(0, limit)),
    );
  }
  put(note: JournalNote, expectedRevision: number | null): Promise<Result<JournalNote>> {
    if ((this.notes.get(note.path)?.revision ?? null) !== expectedRevision) return Promise.resolve(conflict('stale_revision', 'note moved'));
    this.notes.set(note.path, note);
    return Promise.resolve(ok(note));
  }
}

export class FakeReflections implements ReflectionPort {
  readonly entries: ReflectionEntry[] = [];
  append(entry: ReflectionEntry): Promise<Result<ReflectionEntry>> {
    const existing = this.entries.find((e) => e.id === entry.id);
    if (existing !== undefined) {
      return Promise.resolve(existing.text === entry.text && existing.kind === entry.kind ? ok(existing) : conflict('idempotency_mismatch', 'reflection id reused'));
    }
    this.entries.push(entry);
    return Promise.resolve(ok(entry));
  }
  list(limit: number): Promise<Result<readonly ReflectionEntry[]>> {
    return Promise.resolve(ok([...this.entries].reverse().slice(0, limit)));
  }
  get(id: string): Promise<Result<ReflectionEntry>> {
    const found = this.entries.find((e) => e.id === id);
    return Promise.resolve(found === undefined ? notFound(`reflection ${id}`) : ok(found));
  }
}

export class FakeLetters implements LetterPort {
  readonly letters = new Map<string, Letter>();
  readonly eventRows: LetterEvent[] = [];
  create(letter: Letter, event: LetterEvent): Promise<Result<{ readonly letter: Letter; readonly created: boolean }>> {
    const existing = this.letters.get(letter.id);
    if (existing !== undefined) return Promise.resolve(ok({ letter: existing, created: false }));
    this.letters.set(letter.id, letter);
    this.eventRows.push(event);
    return Promise.resolve(ok({ letter, created: true }));
  }
  get(id: string): Promise<Result<Letter>> {
    const found = this.letters.get(id);
    return Promise.resolve(found === undefined ? notFound(`letter ${id}`) : ok(found));
  }
  list(filter: Parameters<LetterPort['list']>[0]): Promise<Result<readonly Letter[]>> {
    return Promise.resolve(
      ok(
        [...this.letters.values()]
          .filter((l) => (filter.author === null || l.author === filter.author) && (filter.recipient === null || l.recipient === filter.recipient))
          .filter((l) => filter.states.includes(l.state))
          .slice(0, filter.limit),
      ),
    );
  }
  record(next: Letter, expectedRevision: number, event: LetterEvent): Promise<Result<Letter>> {
    const current = this.letters.get(next.id);
    if (current === undefined) return Promise.resolve(notFound(`letter ${next.id}`));
    if (current.revision !== expectedRevision) return Promise.resolve(conflict('stale_revision', 'letter moved'));
    this.letters.set(next.id, next);
    this.eventRows.push(event);
    return Promise.resolve(ok(next));
  }
  events(letterId: string, limit: number): Promise<Result<readonly LetterEvent[]>> {
    return Promise.resolve(ok(this.eventRows.filter((e) => e.letterId === letterId).slice(-limit)));
  }
}
