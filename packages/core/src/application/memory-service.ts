import { contactVisibleTo, type ContactStorePort } from '../contacts/index.ts';
import type { EpisodeStorePort } from '../episodes/index.ts';
import { episodeReadable } from '../episodes/index.ts';
import {
  MEMORY_KINDS,
  memoryReadable,
  memoryReadableInAnyState,
  sourceKeys,
  sourceReadable,
  type DeletionJustification,
  type MemoryAttribution,
  type MemoryDeletionPort,
  type MemoryDeletionProposal,
  type MemoryEvent,
  type MemoryKind,
  type MemoryLink,
  type MemoryRecord,
  type MemoryStorePort,
  type MemorySubject,
  type SourceAccess,
} from '../memory/index.ts';
import type { SessionCatalogPort } from '../sessions/index.ts';
import {
  conflict,
  conversationKey,
  denied,
  invalid,
  isRecord,
  notFound,
  ok,
  type Author,
  type Clock,
  type ContactId,
  type IdSource,
  type IdempotencyKey,
  type Result,
  type Sensitivity,
} from '../shared/index.ts';
import type { ApprovalPort } from './host-ports.ts';
import { renderEpisode, type EpisodeView } from './episode-service.ts';
import {
  accessOf,
  boundedText,
  callerContactOf,
  embedTexts,
  emptyUsage,
  fuseRankings,
  requireTrusted,
  writeSubjectOf,
  type Embeddings,
  type InferenceUsage,
} from './memory-scope.ts';
import { attributionFor, type MemoryWriter, type MemoryWriteResult } from './memory-writer.ts';
import { digest } from './turn-history.ts';
import { authorOf, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';

const COMPANION_CONFIDENCE = 0.9;
const IMPORT_MAX = 100;
const EVENTS_IN_GET = 20;
const CONTENT_MAX = 2_000;

/** What a reader sees of a memory. Vectors and withheld co-subjects are never included. */
export interface MemoryView {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sensitivity: Sensitivity;
  readonly subject: MemorySubject;
  readonly attribution: MemoryAttribution;
  readonly author: Author;
  readonly confidence: number;
  readonly occurredAt: string | null;
  readonly recordedAt: string;
  readonly via: MemoryRecord['provenance']['via'];
  readonly revision: number;
}

export interface SearchMode {
  readonly lexical: 'ok' | 'unavailable';
  readonly semantic: 'ok' | 'unavailable';
}

export interface MemoryService {
  search(
    scope: TrustedTurnScope,
    input: { readonly query: string; readonly limit: number },
  ): Promise<Result<{ readonly memories: readonly MemoryView[]; readonly mode: SearchMode; readonly usage: InferenceUsage }>>;
  get(
    scope: TrustedTurnScope,
    input: { readonly memoryId: string },
  ): Promise<Result<{ readonly memory: MemoryView; readonly links: readonly MemoryLink[]; readonly events: readonly MemoryEvent[] }>>;
  sharedBackground(
    scope: TrustedTurnScope,
    input: { readonly contactId: ContactId; readonly limit: number },
  ): Promise<Result<{ readonly memories: readonly MemoryView[]; readonly episodes: readonly EpisodeView[] }>>;
  census(scope: TrustedTurnScope): Promise<Result<{ readonly total: number; readonly byKind: Readonly<Record<MemoryKind, number>> }>>;
  write(
    scope: TrustedTurnScope,
    input: {
      readonly writeId: string;
      readonly kind: MemoryKind;
      readonly content: string;
      readonly sensitivity: Sensitivity;
      readonly attribution: 'companion_authored' | 'participant_attributed';
      readonly occurredAt: string | null;
    },
  ): Promise<Result<MemoryWriteResult>>;
  import(
    scope: TrustedTurnScope,
    input: {
      readonly batchId: string;
      readonly records: readonly { readonly kind: MemoryKind; readonly content: string; readonly sensitivity: Sensitivity; readonly occurredAt: string }[];
    },
  ): Promise<Result<{ readonly staged: boolean; readonly results: readonly MemoryWriteResult[] }>>;
  patch(
    scope: TrustedTurnScope,
    input: { readonly memoryId: string; readonly content: string; readonly reason: string; readonly expectedRevision: number | null },
  ): Promise<Result<MemoryView>>;
  proposeDelete(
    scope: TrustedTurnScope,
    input: { readonly memoryId: string; readonly justification: DeletionJustification; readonly explanation: string },
  ): Promise<Result<MemoryDeletionProposal>>;
  restore(scope: TrustedTurnScope, input: { readonly memoryId: string }): Promise<Result<MemoryView>>;
}

export interface MemoryServiceDeps {
  readonly store: MemoryStorePort;
  readonly deletions: MemoryDeletionPort;
  readonly writer: MemoryWriter;
  readonly embeddings: Embeddings;
  readonly episodes: EpisodeStorePort;
  readonly contacts: ContactStorePort;
  readonly catalog: SessionCatalogPort;
  readonly approvals: ApprovalPort;
  readonly clock: Clock;
  readonly ids: IdSource;
}

/** Restricted material a worker may only stage, following the donor's worker memory governance. */
export function isRestrictedForWorkers(kind: MemoryKind, sensitivity: Sensitivity): boolean {
  return kind === 'boundary' || kind === 'relational' || sensitivity === 'intimate' || sensitivity === 'confidential';
}

/**
 * The `memory` tool over typed memory. Every read is filtered by the scope's
 * access before ranking, so withheld memories affect neither results, ids,
 * counts nor similarity neighbours; a withheld id reads as missing. Writes
 * stamp subject, source and attribution from the scope and refuse a
 * sensitivity the scope is not admitted to.
 */
export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const visible = async (scope: TrustedTurnScope, memoryId: string, anyState = false): Promise<Result<MemoryRecord>> => {
    const found = await deps.store.get(memoryId);
    if (!found.ok) return found.error.kind === 'not_found' ? notFound(`memory ${memoryId}`) : found;
    const access = accessOf(scope);
    const readable = anyState ? memoryReadableInAnyState(access, found.value) : memoryReadable(access, found.value);
    return readable ? found : notFound(`memory ${memoryId}`);
  };

  const sourceSession = async (scope: TrustedTurnScope) => {
    const head = await deps.catalog.active(conversationKey(scope.audience));
    return head.ok ? ok(head.value?.sessionId ?? null) : head;
  };

  const writeOne = async (
    scope: TrustedTurnScope,
    input: {
      readonly key: string;
      readonly kind: MemoryKind;
      readonly content: string;
      readonly sensitivity: Sensitivity;
      readonly attribution: MemoryAttribution;
      readonly occurredAt: string | null;
      readonly via: 'tool_write' | 'import';
      readonly staged: boolean;
    },
  ): Promise<Result<MemoryWriteResult>> => {
    const session = await sourceSession(scope);
    if (!session.ok) return session;
    const author = authorOf(scope);
    return deps.writer.write({
      kind: input.kind,
      content: input.content,
      sensitivity: input.sensitivity,
      subject: input.attribution.kind === 'participant_attributed' ? { kind: 'contacts', contactIds: [input.attribution.contactId] } : writeSubjectOf(scope),
      confidence: COMPANION_CONFIDENCE,
      occurredAt: input.occurredAt,
      staged: input.staged,
      access: accessOf(scope),
      provenance: {
        author,
        attribution: attributionFor(author, input.attribution),
        source: scope.audience,
        sourceSessionId: session.value,
        sourceTurnIds: [],
        sourceConversationAt: input.via === 'import' ? null : deps.clock.now().toISOString(),
        via: input.via,
        // Keys are namespaced by conversation, so another room can neither collide with nor probe them.
        idempotencyKey: `mw:${digest({ conversation: conversationKey(scope.audience), key: input.key })}` as IdempotencyKey,
      },
    });
  };

  const requestedAttribution = (scope: TrustedTurnScope, requested: 'companion_authored' | 'participant_attributed'): Result<MemoryAttribution> => {
    if (requested === 'companion_authored') return ok({ kind: 'companion_authored' });
    const contactId = callerContactOf(scope);
    if (contactId === null) return invalid('participant_attributed memories need a participant in this conversation');
    return ok({ kind: 'participant_attributed', contactId });
  };

  return {
    async search(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const query = boundedText(input.query, 'query', 500);
      if (!query.ok) return query;
      const access = accessOf(scope);
      const usage = emptyUsage();
      const lexical = await deps.store.searchLexical(access, query.value, input.limit);
      const embedded = await embedTexts(deps.embeddings, [query.value], 'memory_search');
      usage.embeddingCalls += 1;
      usage.embeddedTexts += 1;
      const vector = embedded.ok ? embedded.value[0] : undefined;
      const semantic = vector === undefined ? null : await deps.store.searchSemantic(access, deps.embeddings.space, vector, input.limit);
      if (!lexical.ok && (semantic === null || !semantic.ok)) return lexical;
      const byId = new Map<string, MemoryRecord>();
      const lists: string[][] = [];
      for (const hits of [lexical, semantic]) {
        if (hits === null || !hits.ok) continue;
        lists.push(hits.value.map((h) => h.record.id));
        for (const hit of hits.value) byId.set(hit.record.id, hit.record);
      }
      const memories = fuseRankings(lists, input.limit)
        .map((id) => byId.get(id))
        .filter((r): r is MemoryRecord => r !== undefined && memoryReadable(access, r))
        .map((r) => renderMemory(access, r));
      const mode: SearchMode = { lexical: lexical.ok ? 'ok' : 'unavailable', semantic: semantic?.ok === true ? 'ok' : 'unavailable' };
      return ok({ memories, mode, usage });
    },

    async get(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const record = await visible(scope, input.memoryId);
      if (!record.ok) return record;
      const access = accessOf(scope);
      const links = await deps.store.links(record.value.id);
      if (!links.ok) return links;
      const shown: MemoryLink[] = [];
      for (const link of links.value) {
        const other = await deps.store.get(link.fromId === record.value.id ? link.toId : link.fromId);
        if (!other.ok) return other;
        if (memoryReadableInAnyState(access, other.value)) shown.push(link);
      }
      const events = await deps.store.events(record.value.id, EVENTS_IN_GET);
      if (!events.ok) return events;
      return ok({ memory: renderMemory(access, record.value), links: shown, events: events.value.filter((e) => eventReadable(access, e)) });
    },

    async sharedBackground(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const contact = await deps.contacts.get(input.contactId);
      if (!contact.ok) return contact.error.kind === 'not_found' ? notFound(`contact ${input.contactId}`) : contact;
      if (!contactVisibleTo(viewerOf(scope), contact.value)) return notFound(`contact ${input.contactId}`);
      const access = accessOf(scope);
      const memories = await deps.store.aboutContact(access, input.contactId, input.limit);
      if (!memories.ok) return memories;
      const episodes = await deps.episodes.withParticipant(access, input.contactId, input.limit);
      if (!episodes.ok) return episodes;
      return ok({
        memories: memories.value.filter((r) => memoryReadable(access, r)).map((r) => renderMemory(access, r)),
        episodes: episodes.value.filter((e) => episodeReadable(access, e)).map((e) => renderEpisode(access, e)),
      });
    },

    async census(scope) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const counts = await deps.store.census(accessOf(scope));
      if (!counts.ok) return counts;
      const byKind = Object.fromEntries(MEMORY_KINDS.map((k) => [k, counts.value[k] ?? 0])) as Record<MemoryKind, number>;
      return ok({ total: MEMORY_KINDS.reduce((n, k) => n + byKind[k], 0), byKind });
    },

    async write(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      if (!scope.admitted.includes(input.sensitivity)) {
        return denied('audience_not_admitted', `this conversation is not admitted to ${input.sensitivity} material`);
      }
      const content = boundedText(input.content, 'content', CONTENT_MAX);
      if (!content.ok) return content;
      const attribution = requestedAttribution(scope, input.attribution);
      if (!attribution.ok) return attribution;
      return writeOne(scope, {
        key: `write:${input.writeId}`,
        kind: input.kind,
        content: content.value,
        sensitivity: input.sensitivity,
        attribution: attribution.value,
        occurredAt: input.occurredAt,
        via: 'tool_write',
        staged: scope.caller.kind === 'worker' && isRestrictedForWorkers(input.kind, input.sensitivity),
      });
    },

    async import(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      if (input.records.length === 0 || input.records.length > IMPORT_MAX) return invalid(`an import holds 1-${IMPORT_MAX} records`);
      const issues: string[] = [];
      const now = deps.clock.now().toISOString();
      input.records.forEach((r, i) => {
        if (!scope.admitted.includes(r.sensitivity)) issues.push(`records[${i}] sensitivity ${r.sensitivity} is not admitted here`);
        if (r.content.trim().length === 0 || r.content.length > CONTENT_MAX) issues.push(`records[${i}].content must be 1-${CONTENT_MAX} characters`);
        if (r.occurredAt > now) issues.push(`records[${i}].occurredAt is in the future`);
      });
      if (issues.length > 0) {
        return issues.some((i) => i.includes('not admitted')) ? denied('audience_not_admitted', issues.join('; ')) : invalid(...issues);
      }
      // Any restricted record stages the whole batch for a worker, so a batch cannot be split around review.
      const staged = scope.caller.kind === 'worker' && input.records.some((r) => isRestrictedForWorkers(r.kind, r.sensitivity));
      const results: MemoryWriteResult[] = [];
      for (const [index, record] of input.records.entries()) {
        const written = await writeOne(scope, {
          key: `import:${input.batchId}:${index}`,
          kind: record.kind,
          content: record.content,
          sensitivity: record.sensitivity,
          attribution: { kind: 'companion_authored' },
          occurredAt: record.occurredAt,
          via: 'import',
          staged,
        });
        if (!written.ok) return written;
        results.push(written.value);
      }
      return ok({ staged, results });
    },

    async patch(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const content = boundedText(input.content, 'content', CONTENT_MAX);
      if (!content.ok) return content;
      const reason = boundedText(input.reason, 'reason', 500);
      if (!reason.ok) return reason;
      const found = await visible(scope, input.memoryId);
      if (!found.ok) return found;
      const record = found.value;
      if (input.expectedRevision !== null && input.expectedRevision !== record.revision) {
        return conflict('stale_revision', `memory ${record.id} moved`, { expectedRevision: input.expectedRevision, actualRevision: record.revision });
      }
      const author = authorOf(scope);
      const at = deps.clock.now().toISOString();
      // Text the companion rewrote is no longer what a participant said or what a model inferred.
      const attribution: MemoryAttribution = content.value === record.content ? record.provenance.attribution : { kind: 'companion_authored' };
      const next: MemoryRecord = {
        ...record,
        content: content.value,
        provenance: { ...record.provenance, attribution },
        revision: record.revision + 1,
        updatedAt: at,
      };
      const saved = await deps.store.update(next, record.revision, {
        memoryId: record.id,
        kind: 'patched',
        author,
        at,
        detail: { reason: reason.value, previousContent: record.content, previousAttribution: record.provenance.attribution },
      });
      if (!saved.ok) return saved;
      const embedded = await embedTexts(deps.embeddings, [content.value], 'memory_patch');
      if (embedded.ok && embedded.value[0] !== undefined) {
        const put = await deps.store.putEmbedding(record.id, deps.embeddings.space, embedded.value[0]);
        if (!put.ok) return put;
      }
      return ok(renderMemory(accessOf(scope), saved.value));
    },

    async proposeDelete(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const explanation = boundedText(input.explanation, 'explanation', 1_000);
      if (!explanation.ok) return explanation;
      const found = await visible(scope, input.memoryId);
      if (!found.ok) return found;
      const pending = await deps.deletions.latestFor(found.value.id, 'pending');
      if (!pending.ok) return pending;
      if (pending.value !== null) return ok(pending.value);
      const proposalId = `deletion:${found.value.id}:${found.value.revision}`;
      const submitted = await deps.approvals.submit({
        kind: 'memory_deletion',
        summary: `Soft-delete memory ${found.value.id} (${input.justification})`,
        payload: { proposalId, memoryId: found.value.id, memoryRevision: found.value.revision, justification: input.justification },
        requestedBy: authorOf(scope),
      });
      if (!submitted.ok) return submitted;
      return deps.deletions.create({
        proposalId,
        memoryId: found.value.id,
        memoryRevision: found.value.revision,
        justification: input.justification,
        explanation: explanation.value,
        proposedBy: authorOf(scope),
        proposedAt: deps.clock.now().toISOString(),
        approvalId: submitted.value.proposalId,
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        revision: 1,
      });
    },

    async restore(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const found = await visible(scope, input.memoryId, true);
      if (!found.ok) return found;
      if (found.value.state !== 'soft_deleted') return invalid(`memory ${input.memoryId} is not soft-deleted`);
      const applied = await deps.deletions.latestFor(found.value.id, 'approved');
      if (!applied.ok) return applied;
      const at = deps.clock.now().toISOString();
      const author = authorOf(scope);
      const restored = await deps.store.update({ ...found.value, state: 'current', revision: found.value.revision + 1, updatedAt: at }, found.value.revision, {
        memoryId: found.value.id,
        kind: 'restored',
        author,
        at,
        detail: { proposalId: applied.value?.proposalId ?? null },
      });
      if (!restored.ok) return restored;
      if (applied.value !== null) {
        const marked = await deps.deletions.save({ ...applied.value, status: 'restored', revision: applied.value.revision + 1 }, applied.value.revision);
        if (!marked.ok) return marked;
      }
      return ok(renderMemory(accessOf(scope), restored.value));
    },
  };
}

/**
 * A reinforcing write from another conversation carries that conversation's
 * provenance; it is shown only to viewers who may read that source.
 */
function eventReadable(access: SourceAccess, event: MemoryEvent): boolean {
  const provenance = event.detail['provenance'];
  if (provenance === undefined) return true;
  if (!isRecord(provenance) || !isRecord(provenance['source'])) return false;
  const { conversation, sourceClass } = sourceKeys(provenance['source'] as unknown as MemoryRecord['provenance']['source']);
  return sourceReadable(access, conversation, sourceClass);
}

/** A bound viewer sees only the co-subjects it is itself; other contact ids are withheld. */
export function renderMemory(access: SourceAccess, record: MemoryRecord): MemoryView {
  const subject: MemorySubject =
    access.subjects.kind === 'bound' && record.subject.kind === 'contacts'
      ? { kind: 'contacts', contactIds: record.subject.contactIds.filter((c) => access.subjects.kind === 'bound' && access.subjects.contactIds.includes(c)) }
      : record.subject;
  return {
    id: record.id,
    kind: record.kind,
    content: record.content,
    sensitivity: record.sensitivity,
    subject,
    attribution: record.provenance.attribution,
    author: record.provenance.author,
    confidence: record.confidence,
    occurredAt: record.occurredAt,
    recordedAt: record.provenance.recordedAt,
    via: record.provenance.via,
    revision: record.revision,
  };
}
