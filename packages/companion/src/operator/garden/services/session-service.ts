import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import type { ConcernStorePort } from '../../../core/intention/concern-store-port.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { sessionEntryToMessage } from '../../../core/agent/messages.js';
import { MESSAGE_CLASSES } from '../../../core/agent/message-classes.js';
import { resolveValidatedCrossChannelContinuityProvenance } from '../../../core/session/cross-channel-continuity-port.js';
import type { SessionManager } from '../../../core/session/manager.js';
import { mergeAuthenticatedJournalWithSessionTail } from '../../../core/session/manager/session-tail-read-store.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { CompactionSummary } from '../../../core/session/types.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import {
  sanitizeObservedMemory,
  type ObservedMemory,
  type TurnMemorySnapshotRecord,
} from '../../../core/turns/observability.js';
import {
  resolveTurnRecordMemoryCandidates,
  collectTurnRecordMemoryRefIds,
  type ObservedMemoryResolver,
} from '../../../persistence/sessions/turn-record-memory-refs.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import { TESTING_HARNESS_SESSION_CHANNEL_ID } from '../../../shared/contracts/testing-harness.js';
import {
  buildCompactionSourceBlock,
  computeCompactionSourceSha256,
  parseCompactionSourceHashTag,
} from '../../../core/session/compaction-audit.js';
import { resolveSessionEntryRoleEnvelopePreview } from '../../../core/session/turn-provenance.js';
import {
  classifyChannelDisclosure,
  visibilitiesShareContinuity,
} from '../../../system/trust/policy.js';
import { decodeStoredChannelVisibility } from '../../../system/trust/types.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type {
  AdminContinuityProvenanceView,
  AdminSessionRouteListData,
  AdminSessionRouteResetData,
  AdminSessionRouteResetInput,
  AdminPromptLoomSubsystemOutputsData,
  AdminSessionMessageOntologyView,
  AdminSessionMessagePaginationOptions,
  AdminSessionDetailData,
  AdminSessionListRow,
  AdminSessionListData,
  AdminSessionMessagesData,
  AdminSessionSearchData,
  AdminSessionService,
  AdminSessionTurnData,
  AdminSessionTurnDetailData,
} from './types.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { assertGardenRequestCompanionScope } from '../garden-companion-scope.js';
import {
  soleAdminFleetActor,
  type FleetGardenRequestContext,
  type GardenRequestContext,
} from '../garden-request-context.js';
import {
  getLinkedContactForSession,
  getStableLinkedContactForSession,
} from './contact-session-linker.js';
import {
  AdminSessionTurnObservabilityStore,
  resolvePromptLoomSubsystemOutputs,
} from './session-turn-observability.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { BackgroundWorkStorePort } from '../../../core/agent/background-work/store-port.js';
import {
  parseSubsystemOutputRef,
  parseTurnSubsystemProjectionRef,
} from '../../../shared/contracts/subsystem-output-refs.js';

const DEFAULT_ADMIN_TURN_LIMIT = 50;
export const DEFAULT_ADMIN_SESSION_MESSAGE_PAGE_LIMIT = 100;
export const MAX_ADMIN_SESSION_MESSAGE_PAGE_LIMIT = 200;
export const DEFAULT_ADMIN_SESSION_SEARCH_LIMIT = 25;
export const MAX_ADMIN_SESSION_SEARCH_LIMIT = 100;
const FLEET_SESSION_BOUNDARY_MESSAGE = 'Fleet session access requires a subject-bound session projection';

/**
 * Thrown by getSessionTurnDetail when the requested turn is not in the recent
 * turn window (or the turnId is blank). The session route maps this to a 404
 * instead of a 500 so a stale/expired turn expand degrades cleanly.
 */
export class AdminSessionTurnNotFoundError extends Error {
  constructor(public readonly sessionId: string, public readonly turnId: string) {
    super(`Turn "${turnId}" not found for session "${sessionId}"`);
    this.name = 'AdminSessionTurnNotFoundError';
  }
}

export class AdminSessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session "${sessionId}" not found`);
    this.name = 'AdminSessionNotFoundError';
  }
}

function resolveMessageClass(value: unknown): AdminSessionMessageOntologyView['messageClass'] {
  return typeof value === 'string' && Object.values(MESSAGE_CLASSES).includes(value as never)
    ? value as AdminSessionMessageOntologyView['messageClass']
    : MESSAGE_CLASSES.outwardSpeech;
}

function buildMessageOntologyView(entry: AdminSessionMessagesData['messages'][number]): AdminSessionMessageOntologyView {
  const classified = sessionEntryToMessage(entry);

  if (classified.role === 'toolResult') {
    return {
      sessionEntryId: entry.id,
      transportRole: entry.role,
      promptRole: 'toolResult',
      semanticType: 'toolResult',
      messageClass: null,
      promptVisibility: 'prompt_visible',
      displayLabel: 'Tool result',
    };
  }

  if (classified.role === 'custom') {
    // pi-agent-core 0.84.1 harness adds a generic CustomMessage<{ customType }>
    // alongside repo-owned custom message types. Only repo types carry the
    // `type` discriminator used here; treat harness custom messages as system
    // notes with no message class.
    if ('type' in classified && classified.type === 'mirror') {
      return {
        sessionEntryId: entry.id,
        transportRole: entry.role,
        promptRole: 'custom',
        semanticType: 'mirror',
        messageClass: classified.messageClass,
        promptVisibility: 'operator_only',
        displayLabel: 'Mirror note',
      };
    }

    return {
      sessionEntryId: entry.id,
      transportRole: entry.role,
      promptRole: 'custom',
      semanticType: 'systemNote',
      messageClass: 'type' in classified && typeof classified.messageClass === 'string'
        ? classified.messageClass
        : null,
      promptVisibility: 'operator_only',
      displayLabel: 'System note',
    };
  }

  if (classified.role === 'user' || classified.role === 'assistant') {
    const messageClass = resolveMessageClass(
      'messageClass' in classified ? classified.messageClass : undefined,
    );
    if (messageClass === MESSAGE_CLASSES.letter) {
      return {
        sessionEntryId: entry.id,
        transportRole: entry.role,
        promptRole: classified.role,
        semanticType: 'letter',
        messageClass,
        promptVisibility: 'prompt_visible',
        displayLabel: 'Letter',
      };
    }
    return {
      sessionEntryId: entry.id,
      transportRole: entry.role,
      promptRole: classified.role,
      semanticType: 'outwardSpeech',
      messageClass,
      promptVisibility: 'prompt_visible',
      displayLabel: 'Outward speech',
    };
  }

  throw new Error(`Unsupported session message role "${classified.role}"`);
}

function normalizeSearchLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ADMIN_SESSION_SEARCH_LIMIT;
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_ADMIN_SESSION_SEARCH_LIMIT;
  return Math.min(value, MAX_ADMIN_SESSION_SEARCH_LIMIT);
}

function normalizePageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ADMIN_SESSION_MESSAGE_PAGE_LIMIT;
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_ADMIN_SESSION_MESSAGE_PAGE_LIMIT;
  return Math.min(value, MAX_ADMIN_SESSION_MESSAGE_PAGE_LIMIT);
}

function normalizeBeforeId(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

export class AdminSessionDataService implements AdminSessionService {
  private readonly turnObservability: AdminSessionTurnObservabilityStore;

  constructor(private readonly deps: {
    sessionStore: SessionStore;
    sessionManager: SessionManager;
    eventBus: EventBus;
    contactStore?: ContactStorePort | null;
    concernStore?: ConcernStorePort | null;
    memoryStore?: MemoryStorePort | null;
    subsystemOutputRefStore?: Pick<BackgroundWorkStorePort, 'getSubsystemOutputProjection'> | null;
    config?: SubstrateConfig;
  }) {
    this.turnObservability = new AdminSessionTurnObservabilityStore({
      eventBus: deps.eventBus,
    });
  }

  private verifyCompactionSummary(channelId: string, summary: CompactionSummary) {
    const parsed = parseCompactionSourceHashTag(summary.summary);
    if (!parsed) {
      return {
        id: summary.id,
        createdAt: summary.createdAt,
        coveredUpTo: summary.coveredUpTo,
        summary: summary.summary,
        sourceHash: null,
        sourceFirstMessageId: null,
        sourceLastMessageId: null,
        sourceMessageCount: null,
        verification: 'missing_hash' as const,
        verificationDetail: 'Source hash metadata is missing in this compaction summary.',
      };
    }

    const sourceEntries = this.deps.sessionStore.getEntriesInRange(
      channelId,
      parsed.firstMessageId,
      parsed.lastMessageId,
    );
    const firstId = sourceEntries[0]?.id ?? null;
    const lastId = sourceEntries[sourceEntries.length - 1]?.id ?? null;
    if (
      sourceEntries.length !== parsed.messageCount
      || firstId !== parsed.firstMessageId
      || lastId !== parsed.lastMessageId
    ) {
      return {
        id: summary.id,
        createdAt: summary.createdAt,
        coveredUpTo: summary.coveredUpTo,
        summary: summary.summary,
        sourceHash: parsed.sha256,
        sourceFirstMessageId: parsed.firstMessageId,
        sourceLastMessageId: parsed.lastMessageId,
        sourceMessageCount: parsed.messageCount,
        verification: 'missing_source' as const,
        verificationDetail: `JSONL source block mismatch: expected ids ${parsed.firstMessageId}-${parsed.lastMessageId} (${parsed.messageCount} entries), found ${sourceEntries.length} entries.`,
      };
    }

    const computedHash = computeCompactionSourceSha256(buildCompactionSourceBlock(sourceEntries));
    if (computedHash !== parsed.sha256) {
      return {
        id: summary.id,
        createdAt: summary.createdAt,
        coveredUpTo: summary.coveredUpTo,
        summary: summary.summary,
        sourceHash: parsed.sha256,
        sourceFirstMessageId: parsed.firstMessageId,
        sourceLastMessageId: parsed.lastMessageId,
        sourceMessageCount: parsed.messageCount,
        verification: 'mismatch' as const,
        verificationDetail: `Hash mismatch: summary=${parsed.sha256} jsonl=${computedHash}.`,
      };
    }

    return {
      id: summary.id,
      createdAt: summary.createdAt,
      coveredUpTo: summary.coveredUpTo,
      summary: summary.summary,
      sourceHash: parsed.sha256,
      sourceFirstMessageId: parsed.firstMessageId,
      sourceLastMessageId: parsed.lastMessageId,
      sourceMessageCount: parsed.messageCount,
      verification: 'verified' as const,
      verificationDetail: 'Verified against JSONL source block.',
    };
  }

  private listSessionRows(): AdminSessionListRow[] {
    const channels = this.deps.sessionStore.listChannels();
    const activityBySessionId = new Map(
      this.deps.sessionStore
        .listSessionsByRecentActivity(Number.MAX_SAFE_INTEGER)
        .map(summary => [summary.sessionId, summary]),
    );
    return channels
      .filter(channel => channel.channelId !== TESTING_HARNESS_SESSION_CHANNEL_ID)
      .map((channel) => {
      const sessionActivity = activityBySessionId.get(channel.sessionId);
      return (
        typeof sessionActivity?.lastActivityAt === 'number' && Number.isFinite(sessionActivity.lastActivityAt)
      )
        ? { ...channel, lastActivityAt: sessionActivity.lastActivityAt }
        : channel;
      });
  }

  /**
   * Subject-bound session projection (88u3). Resolves and validates the
   * fleet request context for the session read paths:
   *
   * - the admitted companion target must match this service's bound
   *   companion (Invariant 11, docs/garden-control-plane.md) — a context
   *   created for companion A can never be applied to companion B's stores;
   * - the route must carry an explicit request-local subject relation; and
   * - the actor must carry a non-empty authenticated contact binding.
   *
   * Returns `null` for standalone/public contexts (single-companion Garden
   * behavior is unchanged) and throws fail-closed for any fleet context that
   * cannot be subject-bound. Role never widens visibility.
   */
  private subjectBoundFleetContext(
    context: GardenRequestContext | undefined,
  ): FleetGardenRequestContext | null {
    if (!context || context.kind !== 'fleet_principal') return null;
    assertGardenRequestCompanionScope(context, this.deps.config?.companionId);
    // D1 sole-admin doctrine: the deployment's single rostered admin is never
    // subject-partitioned from their own deployment's sessions.
    if (soleAdminFleetActor(context)) return null;
    if (
      context.resource.area !== 'sessions'
      || (context.subjectRelation !== 'self' && context.subjectRelation !== 'self_or_co_subject')
    ) {
      throw new Error(FLEET_SESSION_BOUNDARY_MESSAGE);
    }
    if (!context.actor.contactId.trim()) {
      throw new Error('Fleet session access requires an authenticated contact binding');
    }
    return context;
  }

  /**
   * Operations on the unpartitioned session surfaces (route recovery, CogSec
   * remediation) that have no subject-bound projection. They stay fail closed
   * for fleet principals even if a dispatch-level gate is bypassed.
   */
  private denyUnpartitionedFleetAccess(context: GardenRequestContext | undefined): void {
    if (context?.kind === 'fleet_principal' && !soleAdminFleetActor(context)) {
      throw new Error(FLEET_SESSION_BOUNDARY_MESSAGE);
    }
  }

  /**
   * Stable-attribution resolver for fleet AUTHORIZATION decisions. Never
   * consults the mutable last-entry-author heuristic (a participant in a
   * multi-author channel could regain visibility at will by posting last)
   * and fails closed on multi-participant journals. Display paths for the
   * standalone operator Garden keep the heuristic resolver.
   */
  private resolveStableLinkedContactForRow(row: AdminSessionListRow, contacts: Contact[]) {
    return getStableLinkedContactForSession({
      sessionId: row.sessionId,
      channelId: row.channelId,
      contacts,
      sessionStore: this.deps.sessionStore,
    });
  }

  /**
   * The rows a fleet principal may see: sessions whose STABLE linked contact
   * (persisted conversation channel or identity link, single-author journal)
   * IS the principal's authenticated contact binding. Rooms, group DMs,
   * system lanes, and ambiguous attribution are excluded fail-closed.
   */
  private async listSubjectBoundSessionRows(
    fleet: FleetGardenRequestContext,
  ): Promise<AdminSessionListRow[]> {
    const contacts = this.deps.contactStore ? await this.deps.contactStore.listAll() : [];
    if (contacts.length === 0) return [];
    const rows: AdminSessionListRow[] = [];
    for (const row of this.listSessionRows()) {
      const linkedContact = this.resolveStableLinkedContactForRow(row, contacts);
      if (linkedContact?.id === fleet.actor.contactId) rows.push(row);
    }
    return rows;
  }

  /**
   * Fail-closed visibility gate for single-session fleet reads. A session
   * outside the principal's subject binding surfaces as not-found on purpose:
   * a fleet principal must not learn whether another subject's session
   * exists.
   */
  private async assertSubjectBoundSessionVisible(
    fleet: FleetGardenRequestContext | null,
    sessionId: string,
  ): Promise<void> {
    if (!fleet) return;
    const row = this.listSessionRows().find(candidate => candidate.sessionId === sessionId);
    if (!row) throw new AdminSessionNotFoundError(sessionId);
    const contacts = this.deps.contactStore ? await this.deps.contactStore.listAll() : [];
    const linkedContact = contacts.length > 0
      ? this.resolveStableLinkedContactForRow(row, contacts)
      : undefined;
    if (!linkedContact || linkedContact.id !== fleet.actor.contactId) {
      throw new AdminSessionNotFoundError(sessionId);
    }
  }

  async listSessions(context?: GardenRequestContext): Promise<AdminSessionListData> {
    const fleet = this.subjectBoundFleetContext(context);
    if (fleet) {
      return { channels: await this.listSubjectBoundSessionRows(fleet) };
    }
    return { channels: this.listSessionRows() };
  }

  async getSessionDetail(sessionId: string, context?: GardenRequestContext): Promise<AdminSessionDetailData> {
    const fleet = this.subjectBoundFleetContext(context);
    const channel = this.listSessionRows().find(candidate => candidate.sessionId === sessionId);
    if (!channel) throw new AdminSessionNotFoundError(sessionId);

    const contacts = this.deps.contactStore ? await this.deps.contactStore.listAll() : [];
    if (fleet) {
      // Authorization keys on STABLE attribution only; the heuristic display
      // resolver below must never decide fleet visibility.
      const stableContact = this.resolveStableLinkedContactForRow(channel, contacts);
      if (!stableContact || stableContact.id !== fleet.actor.contactId) {
        throw new AdminSessionNotFoundError(sessionId);
      }
      return {
        channel: {
          ...channel,
          linkedContactId: stableContact.id,
          linkedContactName: stableContact.displayName,
        },
      };
    }

    const linkedContact = await getLinkedContactForSession({
      sessionId: channel.sessionId,
      channelId: channel.channelId,
      contacts,
      sessionStore: this.deps.sessionStore,
      contactStore: this.deps.contactStore,
    });
    return {
      channel: linkedContact
        ? {
            ...channel,
            linkedContactId: linkedContact.id,
            linkedContactName: linkedContact.displayName,
          }
        : channel,
    };
  }

  async listSessionRoutes(context?: GardenRequestContext): Promise<AdminSessionRouteListData> {
    this.denyUnpartitionedFleetAccess(context);
    return {
      routes: this.deps.sessionManager.listSessionRoutes(),
      channels: this.listSessionRows(),
    };
  }

  async resetSourceChannelSession(
    input: AdminSessionRouteResetInput,
    context?: GardenRequestContext,
  ): Promise<AdminSessionRouteResetData> {
    this.denyUnpartitionedFleetAccess(context);
    const result = this.deps.sessionManager.resetSourceChannelSession(input);
    return {
      ok: true,
      message: `Source channel ${result.sourceChannelId} now routes to ${result.newLogicalSessionId}. Old L0 history remains available for explicit audit/search.`,
      sourceChannelId: result.sourceChannelId,
      oldLogicalSessionId: result.oldLogicalSessionId,
      newLogicalSessionId: result.newLogicalSessionId,
      route: result.route,
      retiredSession: result.retiredSession,
    };
  }

  async searchSessionMessages(
    sessionId: string,
    query: string,
    limit?: number,
    context?: GardenRequestContext,
  ): Promise<AdminSessionSearchData> {
    await this.assertSubjectBoundSessionVisible(this.subjectBoundFleetContext(context), sessionId);
    const boundedLimit = normalizeSearchLimit(limit);
    const normalizedQuery = query.trim();
    const hits = normalizedQuery
      ? await this.deps.sessionStore.searchByKeywords(normalizedQuery, boundedLimit, { channelId: sessionId })
      : [];
    return {
      sessionId,
      query: normalizedQuery,
      limit: boundedLimit,
      hits: hits.map(hit => ({
        messageId: hit.messageId,
        role: hit.role,
        ...(hit.authorId ? { authorId: hit.authorId } : {}),
        ...(hit.authorName ? { authorName: hit.authorName } : {}),
        content: hit.content,
        timestamp: hit.timestamp,
        snippet: hit.snippet,
      })),
    };
  }

  /**
   * Garden's newest-page read path. Authenticate the current bounded journal
   * window first, then let the shared tail fill only ids newer than that
   * window. The latest authenticated message id is also the cross-process
   * freshness checkpoint: a behind tail is rejected and repopulated even when
   * this SessionStore's process-local index predates another writer's append.
   * Redis-disabled/degraded/missing/behind tails return `null` from the store
   * and fall through to the canonical journal reader. Cursor pages stay
   * canonical because a bounded hot tail cannot prove it covers older ranges.
   */
  async getSessionMessagesForAdminRead(
    sessionId: string,
    options: AdminSessionMessagePaginationOptions = {},
    context?: GardenRequestContext,
  ): Promise<AdminSessionMessagesData> {
    const fleet = this.subjectBoundFleetContext(context);
    await this.assertSubjectBoundSessionVisible(fleet, sessionId);
    const beforeId = normalizeBeforeId(options.beforeId);
    if (beforeId !== null) {
      // Forward the request context: the canonical reader re-runs the fleet
      // gate and applies the same viewer-scoped Loom filtering, so cursor
      // pages can never widen what the first page was allowed to show.
      return await this.getSessionMessages(sessionId, options, context);
    }

    const pageLimit = normalizePageLimit(options.limit);
    const authenticatedJournalMessages = this.deps.sessionStore.getRecent(sessionId, pageLimit);
    const expectedMinEntryId = authenticatedJournalMessages.at(-1)?.id ?? null;
    const tailMessages = await this.deps.sessionStore.fetchSessionTailWindow(sessionId, {
      ...(expectedMinEntryId !== null ? { expectedMinEntryId } : {}),
    });
    const authenticatedMessages = tailMessages
      ? mergeAuthenticatedJournalWithSessionTail(authenticatedJournalMessages, tailMessages).slice(-pageLimit)
      : authenticatedJournalMessages;
    return await this.buildSessionMessages(sessionId, options, authenticatedMessages, fleet?.actor.contactId);
  }

  async getSessionMessages(
    sessionId: string,
    options: AdminSessionMessagePaginationOptions = {},
    context?: GardenRequestContext,
  ): Promise<AdminSessionMessagesData> {
    const fleet = this.subjectBoundFleetContext(context);
    await this.assertSubjectBoundSessionVisible(fleet, sessionId);
    return await this.buildSessionMessages(sessionId, options, undefined, fleet?.actor.contactId);
  }

  /**
   * Resolve retrieved-memory candidate refs (bead psfn-framework-jsi9) against
   * the live memory store for a batch of turn records, before their snapshots
   * are cloned into the Loom view. This is the ONLY read boundary that resolves
   * these refs — the live-agent hot path never reads `snapshot.memory`. A memory
   * that is gone or has been soft-deleted at read time heals (its candidate is
   * dropped), which is how memory deletion/redaction propagates into old turn
   * records. Records without a ref (old fat records) pass through untouched, so
   * no memory-store round-trip happens for them.
   */
  private async resolveTurnRecordMemoryRefs(records: TurnRecord[]): Promise<TurnRecord[]> {
    const ids = new Set<string>();
    for (const record of records) {
      for (const id of collectTurnRecordMemoryRefIds(record)) ids.add(id);
    }
    if (ids.size === 0) return records;
    const memoryStore = this.deps.memoryStore;
    if (!memoryStore) {
      throw new Error(
        'Cannot resolve turn-record memory candidate refs: no memoryStore is configured on the session service',
      );
    }
    const resolved = new Map<string, ObservedMemory>();
    await Promise.all(
      [...ids].map(async (id) => {
        const memory = await memoryStore.getById(id);
        // A soft-deleted memory (deletedAt set) is treated as absent so that a
        // deletion after the turn suppresses the memory instead of resurrecting
        // it from the frozen turn record.
        if (memory && memory.deletedAt === undefined) {
          resolved.set(id, sanitizeObservedMemory(memory));
        }
      }),
    );
    const resolve: ObservedMemoryResolver = (id) => resolved.get(id);
    return records.map(record => resolveTurnRecordMemoryCandidates(record, resolve));
  }

  /**
   * Fleet Loom viewer filter (88u3): decides whether one memory id may appear
   * in a fleet principal's Loom view. Attribution must be PROVEN — a current
   * single-contact subject classification naming exactly the viewer — and
   * anything else (missing store, missing/stale/ambiguous classification,
   * foreign subject) is dropped fail-closed. Lookups run through the
   * service's memory store, so subject-scoped store wrappers further narrow,
   * never widen, what resolves. Decisions are memoised per read call.
   */
  private createFleetMemoryVisibilityChecker(
    viewerContactId: string,
  ): (memoryId: string) => Promise<boolean> {
    const memoryStore = this.deps.memoryStore;
    const cache = new Map<string, Promise<boolean>>();
    return (memoryId: string) => {
      const normalized = memoryId.trim();
      if (!normalized || !memoryStore) return Promise.resolve(false);
      const cached = cache.get(normalized);
      if (cached) return cached;
      const decision = (async () => {
        const classification = await memoryStore.getMemorySubjectClassification(normalized);
        return Boolean(classification
          && classification.status === 'current'
          && classification.subjectClass === 'single_contact'
          && classification.subjectContactIds.length === 1
          && classification.subjectContactIds[0] === viewerContactId);
      })();
      cache.set(normalized, decision);
      return decision;
    };
  }

  /**
   * Viewer-filter the globally resolved subsystem outputs for a fleet read:
   * memory writes require a proven viewer subject classification, concern
   * deltas require a matching contactId (unattributed concerns drop), and
   * contact deltas must be the viewer's own contact row. Unresolved/missing
   * entries drop too — a fleet Loom never carries foreign or unattributable
   * global-store data.
   */
  private async filterSubsystemOutputsForFleetViewer(
    outputs: AdminPromptLoomSubsystemOutputsData,
    viewerContactId: string,
    isViewerMemory: (memoryId: string) => Promise<boolean>,
  ): Promise<AdminPromptLoomSubsystemOutputsData> {
    const memoryDecisions = await Promise.all(outputs.memoryWrites.map(async entry => (
      entry.status === 'resolved' && entry.value !== undefined
        ? await isViewerMemory(entry.value.id)
        : false
    )));
    return {
      ...outputs,
      memoryWrites: outputs.memoryWrites.filter((_, index) => memoryDecisions[index] === true),
      concernDeltas: outputs.concernDeltas.filter(entry => (
        entry.status === 'resolved' && entry.value?.contactId === viewerContactId
      )),
      contactDeltas: outputs.contactDeltas.filter(entry => (
        entry.status === 'resolved' && entry.value?.id === viewerContactId
      )),
    };
  }

  /**
   * Scrub one turn snapshot's memory candidate lists for a fleet read. Every
   * item must pass the viewer subject-classification check. Categories with no
   * clean per-item attribution (Recent Contact Shape artifact, episodic chains) are
   * dropped entirely for fleet reads.
   */
  private async scrubSnapshotForFleetViewer(
    snapshot: NonNullable<AdminSessionTurnData['snapshot']>,
    isViewerMemory: (memoryId: string) => Promise<boolean>,
  ): Promise<NonNullable<AdminSessionTurnData['snapshot']>> {
    if (!snapshot.memory) return snapshot;
    const filterObserved = async <T extends { id: string }>(items: readonly T[]): Promise<T[]> => {
      const decisions = await Promise.all(items.map(item => isViewerMemory(item.id)));
      return items.filter((_, index) => decisions[index] === true);
    };
    const {
      recentContactShape: _recentContactShape,
      episodicChains: _episodicChains,
      ...memoryRest
    } = snapshot.memory;
    const scrubbedMemory: TurnMemorySnapshotRecord = {
      ...memoryRest,
      contactEmotionalMemories: await filterObserved(snapshot.memory.contactEmotionalMemories),
      semanticCandidates: await filterObserved(snapshot.memory.semanticCandidates),
      lexicalCandidates: await filterObserved(snapshot.memory.lexicalCandidates),
      proactiveCandidates: await filterObserved(snapshot.memory.proactiveCandidates),
    };
    return { ...snapshot, memory: scrubbedMemory };
  }

  /**
   * Fleet turn data carries a projected snapshot and the persisted record that
   * supplied it. Scrub both copies: filtering only the projection leaves the
   * same foreign memory payload reachable through
   * `record.observability.snapshot`.
   */
  private async scrubTurnDataForFleetViewer(
    turn: AdminSessionTurnData,
    isViewerMemory: (memoryId: string) => Promise<boolean>,
  ): Promise<AdminSessionTurnData> {
    const [snapshot, recordSnapshot] = await Promise.all([
      turn.snapshot
        ? this.scrubSnapshotForFleetViewer(turn.snapshot, isViewerMemory)
        : Promise.resolve(null),
      turn.record.observability?.snapshot
        ? this.scrubSnapshotForFleetViewer(turn.record.observability.snapshot, isViewerMemory)
        : Promise.resolve(undefined),
    ]);
    const record = recordSnapshot
      ? {
          ...turn.record,
          observability: {
            ...turn.record.observability!,
            snapshot: recordSnapshot,
          },
        }
      : turn.record;
    return { ...turn, record, snapshot };
  }

  private async buildResolvedTurnData(
    record: TurnRecord,
    fleetViewerContactId?: string,
  ): Promise<AdminSessionTurnData> {
    const expansion = await this.expandTurnSubsystemOutputRefs(record);
    const effectiveRecord = expansion.record;
    const subsystemOutputs = await resolvePromptLoomSubsystemOutputs(effectiveRecord, {
      memoryStore: this.deps.memoryStore,
      concernStore: this.deps.concernStore,
      contactStore: this.deps.contactStore,
      projectionStatus: expansion.projectionStatus,
    });
    if (fleetViewerContactId === undefined) {
      return this.turnObservability.buildTurnData(effectiveRecord, subsystemOutputs);
    }
    const isViewerMemory = this.createFleetMemoryVisibilityChecker(fleetViewerContactId);
    const scopedOutputs = await this.filterSubsystemOutputsForFleetViewer(
      subsystemOutputs,
      fleetViewerContactId,
      isViewerMemory,
    );
    const turn = this.turnObservability.buildTurnData(effectiveRecord, scopedOutputs);
    return await this.scrubTurnDataForFleetViewer(turn, isViewerMemory);
  }

  private async expandTurnSubsystemOutputRefs(record: TurnRecord): Promise<{
    record: TurnRecord;
    projectionStatus: 'not_applicable' | 'pending' | 'applied' | 'failed' | 'outcome_unknown';
  }> {
    const projectionRefs = [
      ...record.extractedMemoryIds,
      ...record.concernDeltaRefs,
      ...record.contactDeltaRefs,
    ];
    if (projectionRefs.length === 0) {
      return { record, projectionStatus: 'not_applicable' };
    }
    if (record.extractedMemoryIds.length !== 1
      || record.concernDeltaRefs.length !== 1
      || record.contactDeltaRefs.length !== 1) {
      throw new Error('TurnRecord subsystem output projection must contain one ref per field');
    }
    const binding = {
      logicalSessionId: record.sessionId ?? record.channelId,
      sourceChannelId: record.channelId,
      sourceTurnId: record.turnId,
      sourceRequestId: record.requestId,
    };
    parseTurnSubsystemProjectionRef(record.extractedMemoryIds[0]!, binding, 'memory');
    parseTurnSubsystemProjectionRef(record.concernDeltaRefs[0]!, binding, 'concern');
    parseTurnSubsystemProjectionRef(record.contactDeltaRefs[0]!, binding, 'contact');
    const projectionStore = this.deps.subsystemOutputRefStore;
    if (!projectionStore) {
      throw new Error('Cannot expand TurnRecord subsystem output refs: projection store is not configured');
    }
    const projection = await projectionStore.getSubsystemOutputProjection(binding);
    if (projection.status !== 'applied' && projection.outputRefs.length > 0) {
      throw new Error(`Non-applied subsystem output projection contains refs: ${projection.status}`);
    }
    const grouped = {
      memory: [] as string[],
      concern: [] as string[],
      contact: [] as string[],
    };
    for (const targetRef of projection.outputRefs) {
      const target = parseSubsystemOutputRef(targetRef);
      grouped[target.kind].push(targetRef);
    }
    return {
      projectionStatus: projection.status,
      record: {
        ...record,
        extractedMemoryIds: grouped.memory,
        concernDeltaRefs: grouped.concern,
        contactDeltaRefs: grouped.contact,
      },
    };
  }

  private async buildSessionMessages(
    sessionId: string,
    options: AdminSessionMessagePaginationOptions,
    firstPageMessages?: readonly SessionEntry[],
    fleetViewerContactId?: string,
  ): Promise<AdminSessionMessagesData> {
    const limit = normalizePageLimit(options.limit);
    const beforeId = normalizeBeforeId(options.beforeId);
    const totalMessages = this.deps.sessionStore.count(sessionId);
    const olderThanCursor = beforeId === null
      ? null
      : await this.deps.sessionStore.getEntriesBeforeAsync(sessionId, beforeId, limit + 1);
    const messages = olderThanCursor === null
      ? (firstPageMessages
          ? firstPageMessages.slice(-limit)
          : this.deps.sessionStore.getRecent(sessionId, limit))
      : olderThanCursor.slice(-limit);
    const hasMoreOlder = olderThanCursor === null
      ? totalMessages > messages.length
      : olderThanCursor.length > messages.length;
    const nextBeforeId = hasMoreOlder ? (messages[0]?.id ?? null) : null;
    const messageOntologyViews = messages.map(buildMessageOntologyView);
    const sessionActivity = this.deps.sessionStore.getSessionActivity(sessionId);
    const channelId = messages.length > 0
      ? messages[0]!.channelId
      : (sessionActivity?.channelId ?? sessionId);
    // Stored entry visibility decodes through the read-boundary decoder
    // (legacy 'semi_private'/'broadcast' records map onto ChannelPrivacy).
    const currentVisibility: ChannelPrivacy = decodeStoredChannelVisibility(messages[0]?.channelVisibility)
      ?? classifyChannelDisclosure(channelId).channelPrivacy;
    // messagesOnly drops everything heavy (turns, previews, compaction).
    // includeTurns=false keeps compaction summaries but drops the up-to-50 full
    // turn snapshots and role-envelope previews; the session browser uses it so
    // its initial page stays small and pulls per-turn detail on demand.
    const includeTurnDetail = !options.messagesOnly && options.includeTurns !== false;
    const roleEnvelopePreviews = includeTurnDetail
      ? messages.flatMap((entry) => {
        const preview = resolveSessionEntryRoleEnvelopePreview(entry);
        return preview ? [{ sessionEntryId: entry.id, preview }] : [];
      })
      : [];
    const turnRecords = includeTurnDetail
      ? await this.resolveTurnRecordMemoryRefs(
        this.deps.sessionStore.getRecentTurnRecords(sessionId, DEFAULT_ADMIN_TURN_LIMIT),
      )
      : [];
    const turns = await Promise.all(turnRecords.map(async (record) => {
      const turnData = await this.buildResolvedTurnData(record, fleetViewerContactId);
      return {
        ...turnData,
        continuityProvenance: buildContinuityProvenanceViews(
          record.turnId,
          record.channelId,
          currentVisibility,
          turnData.snapshot?.sessionContext?.continuityEntries ?? [],
        ),
      };
    }));
    const compactionAuditViews = options.messagesOnly
      ? []
      : this.deps.sessionStore
        .getCompactionSummaries(sessionId)
        .slice()
        .sort((left, right) => right.id - left.id)
        .map(summary => this.verifyCompactionSummary(sessionId, summary));
    return {
      sessionId,
      channelId,
      messages,
      pagination: {
        limit,
        beforeId,
        nextBeforeId,
        hasMoreOlder,
        totalMessages,
        returnedMessages: messages.length,
      },
      messageOntologyViews,
      roleEnvelopePreviews,
      compactionAuditViews,
      turns,
    };
  }

  /**
   * Lazily resolve a single turn's full snapshot detail, bounded to one turn so
   * the session browser can pull turn data on expand without shipping the
   * up-to-50 snapshots the list endpoint would otherwise attach. Searches the
   * same recent-turn window the list uses; a turnId outside that window (or an
   * unknown one) fails closed with AdminSessionTurnNotFoundError so the route
   * can answer 404 rather than silently returning an empty turn.
   */
  async getSessionTurnDetail(
    sessionId: string,
    turnId: string,
    context?: GardenRequestContext,
  ): Promise<AdminSessionTurnDetailData> {
    const fleet = this.subjectBoundFleetContext(context);
    await this.assertSubjectBoundSessionVisible(fleet, sessionId);
    const normalizedTurnId = turnId.trim();
    if (!normalizedTurnId) {
      throw new AdminSessionTurnNotFoundError(sessionId, turnId);
    }
    const record = this.deps.sessionStore
      .getRecentTurnRecords(sessionId, DEFAULT_ADMIN_TURN_LIMIT)
      .find(candidate => candidate.turnId === normalizedTurnId);
    if (!record) {
      throw new AdminSessionTurnNotFoundError(sessionId, normalizedTurnId);
    }
    // Decode channel visibility from a single recent entry (bounded read),
    // mirroring the list endpoint's fallback to channel-disclosure policy.
    const recentEntry = this.deps.sessionStore.getRecent(sessionId, 1).at(0);
    const currentVisibility: ChannelPrivacy = decodeStoredChannelVisibility(recentEntry?.channelVisibility)
      ?? classifyChannelDisclosure(record.channelId).channelPrivacy;
    const [resolvedRecord] = await this.resolveTurnRecordMemoryRefs([record]);
    const turnData = await this.buildResolvedTurnData(resolvedRecord!, fleet?.actor.contactId);
    const turn: AdminSessionTurnData = {
      ...turnData,
      continuityProvenance: buildContinuityProvenanceViews(
        record.turnId,
        record.channelId,
        currentVisibility,
        turnData.snapshot?.sessionContext?.continuityEntries ?? [],
      ),
    };
    return { sessionId, channelId: record.channelId, turn };
  }
}

function buildContinuityProvenanceViews(
  turnId: string,
  currentChannelId: string,
  currentVisibility: ChannelPrivacy,
  continuityEntries: readonly SessionEntry[],
): AdminContinuityProvenanceView[] {
  const provenance: AdminContinuityProvenanceView[] = [];

  for (const entry of continuityEntries) {
    const continuity = resolveValidatedCrossChannelContinuityProvenance(
      entry,
      currentChannelId,
    );
    if (!continuity) continue;

    const carriedAcrossChannels = continuity.sourceChannelId !== currentChannelId;
    const sourceVisibility = continuity.sourceVisibility;
    const visibilityCompatible = visibilitiesShareContinuity(
      { channelPrivacy: sourceVisibility, broadcast: false },
      { channelPrivacy: currentVisibility, broadcast: false },
    );

    provenance.push({
      sessionEntryId: entry.id,
      turnId,
      continuityUserId: continuity.continuityUserId,
      sourceChannelId: continuity.sourceChannelId,
      sourceVisibility,
      currentChannelId,
      currentVisibility,
      carriedAcrossChannels: carriedAcrossChannels && visibilityCompatible,
    });
  }

  return provenance;
}
