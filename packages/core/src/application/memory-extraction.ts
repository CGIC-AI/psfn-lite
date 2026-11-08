import type { ContactStorePort } from '../contacts/index.ts';
import {
  EXTRACTION_INSTRUCTION,
  normalizeContent,
  parseExtraction,
  sourceAccessFor,
  subjectContacts,
  subjectKey,
  type ExtractedMemory,
  type MemoryAttribution,
  type MemorySubject,
  type SessionCursorPort,
} from '../memory/index.ts';
import type { ArchivedEntry, SessionArchivePort, SessionCatalogPort } from '../sessions/index.ts';
import { invalid, ok, type ContactId, type IdempotencyKey, type Result, type SessionId, type TurnId } from '../shared/index.ts';
import type { ModelMessage, ModelPort } from './host-ports.ts';
import { addUsage, emptyUsage, requireMaintenanceScope, type InferenceUsage } from './memory-scope.ts';
import type { MemoryWriter, MemoryWriteResult } from './memory-writer.ts';
import { digest } from './turn-history.ts';
import { viewerOf, type TrustedTurnScope } from './trusted-scope.ts';

const PRODUCER = 'memory_extraction';
const MAX_OUTPUT_TOKENS = 1_200;

export interface ExtractionReport {
  readonly sessionId: SessionId;
  readonly outcome: 'extracted' | 'up_to_date' | 'nothing_conversational';
  readonly throughSeq: number;
  readonly written: readonly MemoryWriteResult[];
  /** Proposed memories about a contact whose tracking consent is not granted; nothing was recorded. */
  readonly withheld: readonly { readonly turnId: TurnId; readonly reason: 'untracked_contact' }[];
  readonly usage: InferenceUsage;
}

export interface MemoryExtraction {
  extract(scope: TrustedTurnScope, input: { readonly sessionId: SessionId; readonly maxEntries: number }): Promise<Result<ExtractionReport>>;
}

/**
 * Background memory extraction over canonical history (donor
 * `src/faculties/memory/extraction/orchestrator.ts`, `llm-pass.ts`,
 * `speaker-routing.ts`, and `src/core/contacts/tracking-gate.ts`). It runs in a
 * companion-internal maintenance turn over the entries after the session's
 * extraction watermark. The model only proposes; the runtime binds each
 * memory's subject to the attributed speaker of the named source turn, marks
 * it participant-attributed or inferred, and records nothing about a contact
 * whose tracking consent is not granted, nor anything drawn from such a
 * contact's own turn. The watermark advances only after
 * every write succeeded, and each write is keyed by its source turn and
 * content, so a retry neither duplicates memories nor changes their
 * provenance.
 */
export function createMemoryExtraction(deps: {
  readonly catalog: SessionCatalogPort;
  readonly archive: SessionArchivePort;
  readonly cursors: SessionCursorPort;
  readonly writer: MemoryWriter;
  readonly model: ModelPort;
  readonly contacts: ContactStorePort;
}): MemoryExtraction {
  const consented = async (contactIds: readonly ContactId[]): Promise<Result<boolean>> => {
    for (const contactId of contactIds) {
      const contact = await deps.contacts.get(contactId);
      if (!contact.ok) return contact.error.kind === 'not_found' ? ok(false) : contact;
      if (contact.value.consent !== 'granted' || contact.value.status.kind !== 'active') return ok(false);
    }
    return ok(true);
  };

  return {
    async extract(scope, input) {
      const allowed = requireMaintenanceScope(scope);
      if (!allowed.ok) return allowed;
      const session = await deps.catalog.get(input.sessionId);
      if (!session.ok) return session;
      const cursor = await deps.cursors.get(input.sessionId);
      if (!cursor.ok) return cursor;
      const usage = emptyUsage();
      const report = (outcome: ExtractionReport['outcome'], throughSeq: number, written: MemoryWriteResult[] = [], withheld: ExtractionReport['withheld'] = []) =>
        ok({ sessionId: input.sessionId, outcome, throughSeq, written, withheld, usage });
      const range = await deps.archive.readRange(input.sessionId, cursor.value.seq + 1, input.maxEntries);
      if (!range.ok) return range;
      const last = range.value.at(-1);
      if (last === undefined) return report('up_to_date', cursor.value.seq);
      const conversational = range.value.filter((e) => e.entry.origin.kind === 'participant_speech' || e.entry.origin.kind === 'companion_speech');
      if (conversational.length === 0) {
        const advanced = await deps.cursors.advance(input.sessionId, last.seq, cursor.value.revision);
        return advanced.ok ? report('nothing_conversational', last.seq) : advanced;
      }

      const speakers = new Map<TurnId, ContactId>();
      const turnTimes = new Map<TurnId, string>();
      for (const { entry } of conversational) {
        if (entry.origin.kind === 'participant_speech') speakers.set(entry.turnId, entry.origin.speaker);
        turnTimes.set(entry.turnId, entry.at);
      }
      const completed = await deps.model.complete({
        attribution: { purpose: PRODUCER, turnId: null, output: 'machine_inference' },
        messages: [{ role: 'labelled_context', label: 'system note: memory extraction', text: EXTRACTION_INSTRUCTION }, ...conversational.map(label)],
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      if (!completed.ok) return completed;
      usage.modelCalls += 1;
      usage.inputTokens += completed.value.inputTokens;
      usage.outputTokens += completed.value.outputTokens;
      const parsed = parseExtraction(completed.value.text, [...turnTimes.keys()]);
      if (!parsed.ok) return parsed;

      const audience = session.value.audience;
      const planned: { item: ExtractedMemory; subject: MemorySubject; attribution: MemoryAttribution }[] = [];
      for (const item of parsed.value) {
        const speaker = speakers.get(item.turnId) ?? null;
        if (item.about === 'speaker' && speaker === null) return invalid(`memory about the speaker of ${item.turnId}, which has no participant speaker`);
        if (item.attribution === 'participant_attributed' && speaker === null) return invalid(`turn ${item.turnId} has no participant to attribute to`);
        const subject: MemorySubject =
          item.about === 'speaker' && speaker !== null
            ? { kind: 'contacts', contactIds: [speaker] }
            : audience.kind === 'direct'
              ? { kind: 'contacts', contactIds: [audience.contactId] }
              : audience.kind === 'group'
                ? { kind: 'room', channelId: audience.channelId }
                : { kind: 'companion_internal' };
        const attribution: MemoryAttribution =
          item.attribution === 'participant_attributed' && speaker !== null
            ? { kind: 'participant_attributed', contactId: speaker }
            : { kind: 'inferred', producer: PRODUCER };
        planned.push({ item, subject, attribution });
      }

      const written: MemoryWriteResult[] = [];
      const withheld: { turnId: TurnId; reason: 'untracked_contact' }[] = [];
      const access = sourceAccessFor(viewerOf(scope), null);
      for (const { item, subject, attribution } of planned) {
        // The source turn's speaker is checked whatever the subject: a group memory drawn from an untracked
        // speaker's words would otherwise record them under a room subject.
        const speaker = speakers.get(item.turnId);
        const tracked = await consented([...new Set([...subjectContacts(subject), ...(speaker === undefined ? [] : [speaker])])]);
        if (!tracked.ok) return tracked;
        if (!tracked.value) {
          withheld.push({ turnId: item.turnId, reason: 'untracked_contact' });
          continue;
        }
        const result = await deps.writer.write({
          kind: item.kind,
          content: item.content,
          sensitivity: item.sensitivity,
          subject,
          confidence: item.confidence,
          occurredAt: null,
          staged: false,
          access,
          provenance: {
            author: { kind: 'machine', producer: PRODUCER },
            attribution,
            source: audience,
            sourceSessionId: input.sessionId,
            sourceTurnIds: [item.turnId],
            sourceConversationAt: turnTimes.get(item.turnId) ?? null,
            via: 'extraction',
            idempotencyKey: extractionKey(input.sessionId, item, subject, attribution),
          },
        });
        if (!result.ok) return result;
        addUsage(usage, result.value.usage);
        written.push(result.value);
      }
      const advanced = await deps.cursors.advance(input.sessionId, last.seq, cursor.value.revision);
      return advanced.ok ? report('extracted', last.seq, written, withheld) : advanced;
    },
  };
}

/**
 * The write key of an extracted memory covers every field the writer's
 * request digest covers. A rerun that re-emits an item unchanged replays its
 * receipt; one that relabels it (another sensitivity or attribution) is a new
 * write that deduplication and evolution resolve, never an
 * `idempotency_mismatch` that would stall the session's watermark for good.
 */
function extractionKey(sessionId: SessionId, item: ExtractedMemory, subject: MemorySubject, attribution: MemoryAttribution): IdempotencyKey {
  return `mx:${digest({
    sessionId,
    turnId: item.turnId,
    kind: item.kind,
    content: normalizeContent(item.content),
    sensitivity: item.sensitivity,
    subject: subjectKey(subject),
    attribution,
    occurredAt: null,
  })}` as IdempotencyKey;
}

function label(archived: ArchivedEntry): ModelMessage {
  const { entry } = archived;
  const who = entry.origin.kind === 'participant_speech' ? `participant ${entry.origin.speaker}` : 'companion';
  return { role: 'labelled_context', label: `transcript turn ${entry.turnId} (${who})`, text: entry.text };
}

