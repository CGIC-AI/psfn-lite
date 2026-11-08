import {
  journalReadable,
  mergeProvenance,
  parseJournalPath,
  writerProvenance,
  type JournalNote,
  type JournalNotePort,
  type ReflectionEntry,
  type ReflectionPort,
} from '../journals/index.ts';
import { conflict, denied, invalid, notFound, ok, type Clock, type Result } from '../shared/index.ts';
import { accessOf, boundedText, requireTrusted } from './memory-scope.ts';
import { authorOf, type TrustedTurnScope } from './trusted-scope.ts';

const BODY_MAX = 20_000;
const REFLECTION_MAX = 8_000;

export interface JournalService {
  list(scope: TrustedTurnScope, input: { readonly limit: number }): Promise<Result<readonly JournalNote[]>>;
  read(scope: TrustedTurnScope, input: { readonly path: string }): Promise<Result<JournalNote>>;
  search(scope: TrustedTurnScope, input: { readonly query: string; readonly limit: number }): Promise<Result<readonly JournalNote[]>>;
  write(scope: TrustedTurnScope, input: { readonly path: string; readonly body: string; readonly expectedRevision: number | null }): Promise<Result<JournalNote>>;
  append(scope: TrustedTurnScope, input: { readonly path: string; readonly text: string }): Promise<Result<JournalNote>>;
  reflectionsList(scope: TrustedTurnScope, input: { readonly limit: number }): Promise<Result<readonly ReflectionEntry[]>>;
  reflectionsRead(scope: TrustedTurnScope, input: { readonly reflectionId: string }): Promise<Result<ReflectionEntry>>;
  /**
   * Records a reflection from a self turn (scheduled reflection, free time).
   * A `companion_reflection` is the companion's own words and needs the
   * companion's own internal turn; anything a process produced is a
   * `process_log` attributed to that process.
   */
  recordReflection(
    scope: TrustedTurnScope,
    input: { readonly reflectionId: string; readonly templateId: string; readonly kind: ReflectionEntry['kind']; readonly text: string },
  ): Promise<Result<ReflectionEntry>>;
}

/**
 * The companion's journal and reflection records (donor
 * `src/boundary/integrations/journal/tools.ts`, `provenance.ts`;
 * `src/persistence/journals/reflection-journal.ts`). Note provenance is
 * stamped from the writing scope, never read from content: a note is
 * readable wherever its source conversation is, a restricted note only where
 * confidential material is. An unreadable note reads as missing and cannot
 * be overwritten or appended to.
 */
export function createJournalService(deps: {
  readonly notes: JournalNotePort;
  readonly reflections: ReflectionPort;
  readonly clock: Clock;
}): JournalService {
  const readable = async (scope: TrustedTurnScope, rawPath: string): Promise<Result<JournalNote>> => {
    const path = parseJournalPath(rawPath);
    if (!path.ok) return path;
    const found = await deps.notes.get(path.value);
    if (!found.ok) return found.error.kind === 'not_found' ? notFound(`journal note ${path.value}`) : found;
    return journalReadable(accessOf(scope), found.value.provenance) ? found : notFound(`journal note ${path.value}`);
  };

  return {
    async list(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const access = accessOf(scope);
      const notes = await deps.notes.list(access, input.limit);
      return notes.ok ? ok(notes.value.filter((n) => journalReadable(access, n.provenance))) : notes;
    },

    async read(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      return readable(scope, input.path);
    },

    async search(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const query = boundedText(input.query, 'query', 500);
      if (!query.ok) return query;
      const access = accessOf(scope);
      const notes = await deps.notes.search(access, query.value, input.limit);
      return notes.ok ? ok(notes.value.filter((n) => journalReadable(access, n.provenance))) : notes;
    },

    async write(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const path = parseJournalPath(input.path);
      if (!path.ok) return path;
      const body = boundedText(input.body, 'body', BODY_MAX);
      if (!body.ok) return body;
      const at = deps.clock.now().toISOString();
      const existing = await deps.notes.get(path.value);
      if (!existing.ok && existing.error.kind !== 'not_found') return existing;
      const author = authorOf(scope);
      if (!existing.ok) {
        if (input.expectedRevision !== null) return notFound(`journal note ${path.value}`);
        return deps.notes.put(
          { path: path.value, provenance: writerProvenance(scope.audience), author, body: body.value, revision: 1, createdAt: at, updatedAt: at },
          null,
        );
      }
      if (!journalReadable(accessOf(scope), existing.value.provenance)) return notFound(`journal note ${path.value}`);
      if (input.expectedRevision !== existing.value.revision) {
        return conflict('stale_revision', `journal note ${path.value} exists; overwrite it with its current revision`, {
          ...(input.expectedRevision === null ? {} : { expectedRevision: input.expectedRevision }),
          actualRevision: existing.value.revision,
        });
      }
      return deps.notes.put(
        { ...existing.value, provenance: writerProvenance(scope.audience), author, body: body.value, revision: existing.value.revision + 1, updatedAt: at },
        existing.value.revision,
      );
    },

    async append(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const note = await readable(scope, input.path);
      if (!note.ok) return note;
      const text = boundedText(input.text, 'text', BODY_MAX);
      if (!text.ok) return text;
      const body = `${note.value.body}\n${text.value}`;
      if (body.length > BODY_MAX) return invalid(`a journal note holds at most ${BODY_MAX} characters`);
      return deps.notes.put(
        {
          ...note.value,
          provenance: mergeProvenance(note.value.provenance, writerProvenance(scope.audience)),
          author: authorOf(scope),
          body,
          revision: note.value.revision + 1,
          updatedAt: deps.clock.now().toISOString(),
        },
        note.value.revision,
      );
    },

    async reflectionsList(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      return deps.reflections.list(input.limit);
    },

    async reflectionsRead(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      return deps.reflections.get(input.reflectionId);
    },

    async recordReflection(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      if (scope.audience.kind !== 'self') return denied('requires_self_audience', 'reflections are recorded in self turns');
      if (input.kind === 'companion_reflection' && scope.caller.kind !== 'companion_internal') {
        return denied('worker_not_permitted', 'only the companion records its own reflection');
      }
      const text = boundedText(input.text, 'text', REFLECTION_MAX);
      if (!text.ok) return text;
      return deps.reflections.append({
        id: input.reflectionId,
        templateId: input.templateId,
        kind: input.kind,
        author: input.kind === 'companion_reflection' ? authorOf(scope) : { kind: 'machine', producer: `reflection:${input.templateId}` },
        text: text.value,
        createdAt: deps.clock.now().toISOString(),
      });
    },
  };
}
