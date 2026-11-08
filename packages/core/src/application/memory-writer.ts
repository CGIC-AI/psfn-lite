import {
  DEDUP_THRESHOLD,
  RELATED_OFFSET,
  memoryReadable,
  chooseOutcome,
  classifyEvolution,
  normalizeContent,
  similarity,
  subjectKey,
  type EvolutionDecision,
  type MemoryAttribution,
  type MemoryEvent,
  type MemoryKind,
  type MemoryLink,
  type MemoryProvenance,
  type MemoryRecord,
  type MemoryStorePort,
  type MemorySubject,
  type MemoryWriteOutcome,
  type MemoryWriteReceipt,
  type SourceAccess,
} from '../memory/index.ts';
import { conflict, invalid, ok, type Author, type Clock, type CoreError, type IdSource, type Result, type Sensitivity } from '../shared/index.ts';
import { embedTexts, emptyUsage, type Embeddings, type InferenceUsage } from './memory-scope.ts';
import { digest } from './turn-history.ts';

const CANDIDATE_LIMIT = 200;
const CONTENT_MAX = 2_000;

export interface MemoryWriteRequest {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sensitivity: Sensitivity;
  readonly subject: MemorySubject;
  readonly confidence: number;
  readonly occurredAt: string | null;
  readonly provenance: Omit<MemoryProvenance, 'recordedAt'>;
  /** Worker writes of restricted material are stored for review, never read until approved. */
  readonly staged: boolean;
  /**
   * The writer's own read access. Only memories it may read take part in
   * deduplication and evolution, so a write outcome never reveals, merges
   * into or supersedes a memory the writing conversation cannot see.
   */
  readonly access: SourceAccess;
}

export interface MemoryWriteResult {
  readonly memoryId: string;
  readonly outcome: MemoryWriteOutcome;
  /** True when this is a retry of a write already recorded under the same key. */
  readonly replayed: boolean;
  readonly related: readonly { readonly memoryId: string; readonly relation: MemoryLink['relation'] }[];
  /** `pending`: the embedding call failed; the maintenance backfill embeds it later. */
  readonly embedding: 'stored' | 'pending';
  readonly usage: InferenceUsage;
}

export interface MemoryWriter {
  write(request: MemoryWriteRequest): Promise<Result<MemoryWriteResult>>;
}

/**
 * The single memory writer for tool writes, imports and extraction. It is
 * idempotent by key (`MemoryWriteReceipt`) and evolves memory against
 * current memories of the same subject and kind (`classifyEvolution`).
 */
export function createMemoryWriter(deps: {
  readonly store: MemoryStorePort;
  readonly embeddings: Embeddings;
  readonly clock: Clock;
  readonly ids: IdSource;
}): MemoryWriter {
  return {
    async write(request) {
      const content = request.content.trim();
      if (content.length === 0 || content.length > CONTENT_MAX) return invalid(`memory content must be 1-${CONTENT_MAX} characters`);
      if (!(request.confidence >= 0 && request.confidence <= 1)) return invalid('memory confidence must be 0..1');
      const requestDigest = digest({
        kind: request.kind,
        content: normalizeContent(content),
        sensitivity: request.sensitivity,
        subject: subjectKey(request.subject),
        attribution: request.provenance.attribution,
        occurredAt: request.occurredAt,
      });
      const key = request.provenance.idempotencyKey;
      const prior = await deps.store.receipt(key);
      if (!prior.ok) return prior;
      if (prior.value !== null) return replay(prior.value, requestDigest);

      const usage = emptyUsage();
      const embedded = await embedTexts(deps.embeddings, [content], 'memory_write');
      usage.embeddingCalls += 1;
      usage.embeddedTexts += 1;
      const vector = embedded.ok ? (embedded.value[0] ?? null) : null;
      const at = deps.clock.now().toISOString();
      const id = deps.ids.next('memory');
      const record: MemoryRecord = {
        id,
        kind: request.kind,
        content,
        sensitivity: request.sensitivity,
        subject: request.subject,
        confidence: request.confidence,
        occurredAt: request.occurredAt,
        provenance: { ...request.provenance, recordedAt: at },
        state: request.staged ? 'staged' : 'current',
        supersededBy: null,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      const author = request.provenance.author;
      const embedding = vector === null ? 'pending' : 'stored';
      const vectorInput = vector === null ? null : { space: deps.embeddings.space, values: vector };
      const receipt = (memoryId: string, outcome: MemoryWriteOutcome): MemoryWriteReceipt => ({ idempotencyKey: key, requestDigest, memoryId, outcome, at });

      if (request.staged) {
        const inserted = await deps.store.insert({
          receipt: receipt(id, 'staged'),
          record,
          vector: vectorInput,
          links: [],
          events: [event(id, 'staged', author, at, {})],
          supersede: [],
        });
        return inserted.ok ? ok({ memoryId: id, outcome: 'staged', replayed: false, related: [], embedding, usage }) : retryRace(inserted, deps.store, key, requestDigest);
      }

      const candidates = await deps.store.candidates(request.subject, request.kind, deps.embeddings.space, CANDIDATE_LIMIT);
      if (!candidates.ok) return candidates;
      const scored = candidates.value
        .filter((c) => memoryReadable(request.access, c.record))
        .map((c) => ({ record: c.record, score: similarity({ content, vector }, { content: c.record.content, vector: c.vector }) }))
        .sort((a, b) => b.score - a.score);
      const threshold = DEDUP_THRESHOLD[request.kind];
      const best = scored[0];
      if (best !== undefined && best.score >= threshold) {
        const reinforced = await deps.store.reinforce(
          receipt(best.record.id, 'deduplicated'),
          event(best.record.id, 'reinforced', author, at, { similarity: round(best.score), provenance: record.provenance }),
        );
        if (!reinforced.ok) return retryRace(reinforced, deps.store, key, requestDigest);
        return ok({ memoryId: best.record.id, outcome: 'deduplicated', replayed: false, related: [], embedding: 'stored', usage });
      }

      const decisions: EvolutionDecision[] = [];
      for (const candidate of scored) {
        if (candidate.score < threshold - RELATED_OFFSET) break;
        const decision = classifyEvolution({
          content,
          kind: request.kind,
          confidence: request.confidence,
          attribution: request.provenance.attribution,
          existing: candidate.record,
          similarity: candidate.score,
        });
        if (decision !== null) decisions.push(decision);
      }
      const outcome = chooseOutcome(decisions);
      const destructive = decisions.filter((d) => d.destructive);
      const inserted = await deps.store.insert({
        receipt: receipt(id, outcome),
        record,
        vector: vectorInput,
        links: decisions.map((d) => ({ fromId: id, toId: d.existing.id, relation: d.relation, reason: d.reason, at })),
        events: [
          event(id, 'created', author, at, { outcome }),
          ...destructive.map((d) => event(d.existing.id, 'superseded', author, at, { by: id, reason: d.reason })),
        ],
        supersede: destructive.map((d) => ({ id: d.existing.id, expectedRevision: d.existing.revision })),
      });
      if (!inserted.ok) return retryRace(inserted, deps.store, key, requestDigest);
      return ok({
        memoryId: id,
        outcome,
        replayed: false,
        related: decisions.map((d) => ({ memoryId: d.existing.id, relation: d.relation })),
        embedding,
        usage,
      });
    },
  };
}

function replay(receipt: MemoryWriteReceipt, requestDigest: string): Result<MemoryWriteResult> {
  if (receipt.requestDigest !== requestDigest) {
    return conflict('idempotency_mismatch', 'this write key was already used for a different memory');
  }
  return ok({ memoryId: receipt.memoryId, outcome: receipt.outcome, replayed: true, related: [], embedding: 'stored', usage: emptyUsage() });
}

/** A concurrent writer recorded the same key first: replay its receipt instead of failing. */
async function retryRace(
  failed: { readonly ok: false; readonly error: CoreError },
  store: MemoryStorePort,
  key: MemoryWriteReceipt['idempotencyKey'],
  requestDigest: string,
): Promise<Result<MemoryWriteResult>> {
  if (failed.error.kind !== 'conflict' || failed.error.reason !== 'idempotency_mismatch') return failed;
  const winner = await store.receipt(key);
  if (!winner.ok) return winner;
  return winner.value === null ? failed : replay(winner.value, requestDigest);
}

function event(memoryId: string, kind: MemoryEvent['kind'], author: Author, at: string, detail: Readonly<Record<string, unknown>>): MemoryEvent {
  return { memoryId, kind, author, at, detail };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Attribution of a write made under a scope; worker output is always machine inference. */
export function attributionFor(author: Author, requested: MemoryAttribution): MemoryAttribution {
  return author.kind === 'machine' ? { kind: 'inferred', producer: author.producer } : requested;
}
