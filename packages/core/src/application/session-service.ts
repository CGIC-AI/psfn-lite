import type {
  ArchivedEntry,
  ContinuityArtifact,
  ContinuityOccasion,
  ContinuityPort,
  FocusPort,
  FocusRecord,
  SessionArchivePort,
  SessionCatalogPort,
  SessionCursor,
  SessionEntry,
  SessionRecord,
  TranscriptProjectionPort,
} from '../sessions/index.ts';
import {
  canViewerRead,
  conversationKey,
  denied,
  invalid,
  isNonEmptyString,
  notFound,
  ok,
  presentationRole,
  sameAudience,
  sameConversation,
  type Clock,
  type IdSource,
  type Origin,
  type PresentationRole,
  type Result,
  type SessionId,
} from '../shared/index.ts';
import type { ModelPort } from './host-ports.ts';
import { syncTranscriptProjection } from './transcript-projection.ts';
import { authorOf, isTrustedTurnScope, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';

/** How many catalog rows a visibility-filtered listing may scan. */
const MAX_LIST_SCAN = 2_000;
const CATALOG_PAGE = 100;
/** Sessions a search or grep covers when no session is named. */
const MAX_SEARCH_SESSIONS = 50;
const MAX_GREP_ENTRIES_PER_SESSION = 5_000;
const SUMMARY_MAX_CHARS = 800;
const FOCUS_TRANSCRIPT_MAX_ENTRIES = 120;

export interface RenderedEntry {
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly at: string;
  readonly origin: Origin;
  readonly role: PresentationRole;
  readonly text: string;
}

export interface SessionSummary {
  readonly session: SessionRecord;
  readonly entryCount: number;
}

export interface SessionService {
  /** The session the scope's conversation writes to, created when absent or bound to another audience. */
  current(scope: TrustedTurnScope): Promise<Result<SessionRecord>>;
  list(scope: TrustedTurnScope, input: { readonly limit: number }): Promise<Result<readonly SessionSummary[]>>;
  messages(scope: TrustedTurnScope, input: { readonly sessionId: SessionId | null; readonly limit: number }): Promise<Result<readonly RenderedEntry[]>>;
  grep(
    scope: TrustedTurnScope,
    input: { readonly pattern: string; readonly caseSensitive: boolean; readonly sessionId: SessionId | null; readonly limit: number },
  ): Promise<Result<readonly RenderedEntry[]>>;
  search(
    scope: TrustedTurnScope,
    input: { readonly query: string; readonly sessionId: SessionId | null; readonly limit: number; readonly summarize: boolean },
  ): Promise<Result<{ readonly hits: readonly RenderedEntry[]; readonly summary: MachineSummary | null }>>;
  continuityList(
    scope: TrustedTurnScope,
    input: { readonly sessionId: SessionId | null; readonly limit: number },
  ): Promise<Result<readonly ContinuityArtifact[]>>;
  startNew(scope: TrustedTurnScope): Promise<Result<SessionRecord>>;
  resume(scope: TrustedTurnScope, input: { readonly sessionId: SessionId }): Promise<Result<SessionRecord>>;
  wakeReturn(
    scope: TrustedTurnScope,
    input: {
      readonly sessionId: SessionId | null;
      readonly summary: string;
      readonly occasion: ContinuityOccasion;
      readonly nextAnchor: string | null;
    },
  ): Promise<Result<ContinuityArtifact>>;
  startFocus(scope: TrustedTurnScope, input: { readonly sessionId: SessionId | null; readonly focus: string }): Promise<Result<FocusRecord>>;
  completeFocus(
    scope: TrustedTurnScope,
    input: { readonly sessionId: SessionId | null; readonly knowledge: string | null },
  ): Promise<Result<FocusRecord>>;
}

/** Model output stays machine inference; it is never rendered as companion speech. */
export interface MachineSummary {
  readonly origin: { readonly kind: 'machine_inference'; readonly producer: string };
  readonly text: string;
}

export interface SessionServiceDeps {
  readonly catalog: SessionCatalogPort;
  readonly archive: SessionArchivePort;
  readonly projection: TranscriptProjectionPort;
  readonly continuity: ContinuityPort;
  readonly focus: FocusPort;
  readonly model: ModelPort;
  readonly clock: Clock;
  readonly ids: IdSource;
}

/**
 * Sessions and lived history the current audience may read. A session is
 * visible when material from its audience is readable by the caller
 * (`canViewerRead`); an invisible session reads exactly like a missing one,
 * and listings drop it without a count.
 */
export function createSessionService(deps: SessionServiceDeps): SessionService {
  const visibleSession = async (scope: TrustedTurnScope, sessionId: SessionId): Promise<Result<SessionRecord>> => {
    const found = await deps.catalog.get(sessionId);
    if (!found.ok) return found;
    if (!canViewerRead(viewerOf(scope), found.value.audience)) return notFound(`session ${sessionId}`);
    return found;
  };

  /** The named session, or the conversation's current one; either must be readable by the caller. */
  const targetSession = async (scope: TrustedTurnScope, sessionId: SessionId | null): Promise<Result<SessionRecord>> => {
    if (sessionId !== null) return visibleSession(scope, sessionId);
    const session = await current(deps, scope);
    if (!session.ok) return session;
    if (!canViewerRead(viewerOf(scope), session.value.audience)) return notFound(`session ${session.value.sessionId}`);
    return session;
  };

  const visibleSessions = async (scope: TrustedTurnScope, limit: number): Promise<Result<SessionRecord[]>> => {
    const viewer = viewerOf(scope);
    const visible: SessionRecord[] = [];
    let cursor: SessionCursor | null = null;
    for (let scanned = 0; scanned < MAX_LIST_SCAN && visible.length < limit; ) {
      const page = await deps.catalog.list(CATALOG_PAGE, cursor);
      if (!page.ok) return page;
      for (const record of page.value) {
        if (canViewerRead(viewer, record.audience)) visible.push(record);
        if (visible.length >= limit) break;
      }
      scanned += page.value.length;
      const last = page.value.at(-1);
      if (last === undefined || page.value.length < CATALOG_PAGE) break;
      cursor = { lastActivityAt: last.lastActivityAt, sessionId: last.sessionId };
    }
    return ok(visible);
  };

  const sessionsFor = async (scope: TrustedTurnScope, sessionId: SessionId | null): Promise<Result<SessionRecord[]>> => {
    if (sessionId === null) return visibleSessions(scope, MAX_SEARCH_SESSIONS);
    const one = await visibleSession(scope, sessionId);
    return one.ok ? ok([one.value]) : one;
  };

  return {
    current: (scope) => current(deps, scope),

    async list(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const sessions = await visibleSessions(scope, input.limit);
      if (!sessions.ok) return sessions;
      const summaries: SessionSummary[] = [];
      for (const session of sessions.value) {
        const head = await deps.archive.head(session.sessionId);
        if (!head.ok) return head;
        summaries.push({ session, entryCount: head.value.count });
      }
      return ok(summaries);
    },

    async messages(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const session = await targetSession(scope, input.sessionId);
      if (!session.ok) return session;
      const head = await deps.archive.head(session.value.sessionId);
      if (!head.ok) return head;
      const from = Math.max(1, head.value.count - input.limit + 1);
      const range = await deps.archive.readRange(session.value.sessionId, from, input.limit);
      return range.ok ? ok(range.value.map(render)) : range;
    },

    async grep(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      if (input.pattern.length === 0) return invalid('grep pattern must be non-empty');
      const sessions = await sessionsFor(scope, input.sessionId);
      if (!sessions.ok) return sessions;
      const needle = input.caseSensitive ? input.pattern : input.pattern.toLowerCase();
      const hits: RenderedEntry[] = [];
      for (const session of sessions.value) {
        const range = await deps.archive.readRange(session.sessionId, 1, MAX_GREP_ENTRIES_PER_SESSION);
        if (!range.ok) return range;
        for (const archived of range.value) {
          const text = input.caseSensitive ? archived.entry.text : archived.entry.text.toLowerCase();
          if (text.includes(needle)) hits.push(render(archived));
          if (hits.length >= input.limit) return ok(hits);
        }
      }
      return ok(hits);
    },

    async search(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      if (!isNonEmptyString(input.query)) return invalid('search query must be non-empty');
      const sessions = await sessionsFor(scope, input.sessionId);
      if (!sessions.ok) return sessions;
      for (const session of sessions.value) {
        const synced = await syncTranscriptProjection(deps.archive, deps.projection, session.sessionId);
        if (!synced.ok) return synced;
      }
      const found = await deps.projection.search(input.query, sessions.value.map((s) => s.sessionId), input.limit);
      if (!found.ok) return found;
      const hits = found.value.map((hit) => render({ seq: hit.seq, hash: '', entry: hit.entry }));
      if (!input.summarize || hits.length === 0) return ok({ hits, summary: null });
      const summary = await summarize(deps.model, `Summarize these transcript matches for "${input.query}".`, hits);
      return summary.ok ? ok({ hits, summary: summary.value }) : summary;
    },

    async continuityList(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const sessions = await sessionsFor(scope, input.sessionId);
      if (!sessions.ok) return sessions;
      return deps.continuity.list(sessions.value.map((s) => s.sessionId), input.limit);
    },

    async startNew(scope) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      return openSession(deps, scope, { continuesFrom: null });
    },

    async resume(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const target = await visibleSession(scope, input.sessionId);
      if (!target.ok) return target;
      if (sameAudience(target.value.audience, scope.audience)) {
        const conversation = conversationKey(scope.audience);
        const head = await deps.catalog.active(conversation);
        if (!head.ok) return head;
        const set = await deps.catalog.setActive(conversation, target.value.sessionId, head.value?.revision ?? 0);
        return set.ok ? target : set;
      }
      // Another audience's history is read, never written to: continue it in a new session of this conversation.
      return openSession(deps, scope, { continuesFrom: target.value.sessionId });
    },

    async wakeReturn(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const summary = boundedText(input.summary, 'summary', SUMMARY_MAX_CHARS);
      if (!summary.ok) return summary;
      const session = await targetSession(scope, input.sessionId);
      if (!session.ok) return session;
      return deps.continuity.append({
        id: deps.ids.next('continuity'),
        sessionId: session.value.sessionId,
        kind: 'wake_return',
        occasion: input.occasion,
        summary: summary.value,
        nextAnchor: input.nextAnchor,
        author: authorOf(scope),
        createdAt: deps.clock.now().toISOString(),
      });
    },

    async startFocus(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const focus = boundedText(input.focus, 'focus', SUMMARY_MAX_CHARS);
      if (!focus.ok) return focus;
      const session = await targetSession(scope, input.sessionId);
      if (!session.ok) return session;
      const head = await deps.archive.head(session.value.sessionId);
      if (!head.ok) return head;
      return deps.focus.open({
        focusId: deps.ids.next('focus'),
        sessionId: session.value.sessionId,
        scope: focus.value,
        startedAt: deps.clock.now().toISOString(),
        startSeq: head.value.count,
        completion: null,
      });
    },

    async completeFocus(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const session = await targetSession(scope, input.sessionId);
      if (!session.ok) return session;
      const open = await deps.focus.openFor(session.value.sessionId);
      if (!open.ok) return open;
      if (open.value === null) return notFound(`open focus in session ${session.value.sessionId}`);
      const head = await deps.archive.head(session.value.sessionId);
      if (!head.ok) return head;
      const completedAt = deps.clock.now().toISOString();
      if (input.knowledge !== null) {
        const knowledge = boundedText(input.knowledge, 'knowledge', SUMMARY_MAX_CHARS * 4);
        if (!knowledge.ok) return knowledge;
        return deps.focus.complete(open.value.focusId, { completedAt, endSeq: head.value.count, knowledge: knowledge.value, author: authorOf(scope) });
      }
      const range = await deps.archive.readRange(session.value.sessionId, open.value.startSeq + 1, FOCUS_TRANSCRIPT_MAX_ENTRIES);
      if (!range.ok) return range;
      if (range.value.length === 0) return invalid('the focus has no transcript yet; pass knowledge to conclude it');
      const summary = await summarize(deps.model, `Summarize what this focus on "${open.value.scope}" established.`, range.value.map(render));
      if (!summary.ok) return summary;
      return deps.focus.complete(open.value.focusId, {
        completedAt,
        endSeq: head.value.count,
        knowledge: summary.value.text,
        author: { kind: 'machine', producer: summary.value.origin.producer },
      });
    },
  };
}

async function current(deps: SessionServiceDeps, scope: TrustedTurnScope): Promise<Result<SessionRecord>> {
  if (!isTrustedTurnScope(scope)) return untrusted();
  const head = await deps.catalog.active(conversationKey(scope.audience));
  if (!head.ok) return head;
  if (head.value !== null) {
    const session = await deps.catalog.get(head.value.sessionId);
    if (!session.ok) return session;
    if (sameAudience(session.value.audience, scope.audience)) return session;
  }
  return openSession(deps, scope, { continuesFrom: null });
}

/** Opens a session for the scope's conversation and makes it the conversation's active session. */
async function openSession(
  deps: SessionServiceDeps,
  scope: TrustedTurnScope,
  lineage: { readonly continuesFrom: SessionId | null },
): Promise<Result<SessionRecord>> {
  if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'workers do not open sessions');
  const conversation = conversationKey(scope.audience);
  const head = await deps.catalog.active(conversation);
  if (!head.ok) return head;
  let previous: SessionId | null = null;
  if (head.value !== null) {
    const prior = await deps.catalog.get(head.value.sessionId);
    if (!prior.ok) return prior;
    previous = sameConversation(prior.value.audience, scope.audience) ? prior.value.sessionId : null;
  }
  const at = deps.clock.now().toISOString();
  const created = await deps.catalog.create({
    sessionId: deps.ids.next('session'),
    audience: scope.audience,
    createdAt: at,
    lastActivityAt: at,
    previousSessionId: previous,
    continuesFrom: lineage.continuesFrom,
  });
  if (!created.ok) return created;
  const set = await deps.catalog.setActive(conversation, created.value.sessionId, head.value?.revision ?? 0);
  return set.ok ? created : set;
}

async function summarize(model: ModelPort, instruction: string, entries: readonly RenderedEntry[]): Promise<Result<MachineSummary>> {
  const completed = await model.complete({
    attribution: { purpose: 'session_summary', turnId: null, output: 'machine_inference' },
    messages: [
      { role: 'labelled_context', label: 'system note: session tool', text: instruction },
      ...entries.map((e) => ({ role: 'labelled_context' as const, label: `transcript ${e.sessionId}#${e.seq} (${e.origin.kind})`, text: e.text })),
    ],
    maxOutputTokens: 400,
  });
  if (!completed.ok) return completed;
  if (!isNonEmptyString(completed.value.text)) return invalid('the model returned an empty summary');
  return ok({ origin: { kind: 'machine_inference', producer: 'session_summary' }, text: completed.value.text.trim() });
}

function render(archived: ArchivedEntry): RenderedEntry {
  const entry: SessionEntry = archived.entry;
  return { sessionId: entry.sessionId, seq: archived.seq, at: entry.at, origin: entry.origin, role: presentationRole(entry.origin), text: entry.text };
}

function boundedText(value: string, field: string, max: number): Result<string> {
  const text = value.trim();
  if (text.length === 0) return invalid(`${field} must be non-empty`);
  if (text.length > max) return invalid(`${field} must be at most ${max} characters`);
  return ok(text);
}

function untrusted() {
  return denied('unknown_authority', 'scope was not admitted by ingress');
}
