/**
 * The light Garden's own routes, under `/api/lite/`: what the eight screens
 * need that no kept donor route serves.
 *
 * - The Overview and the Inner life views read the stores directly, because
 *   the donor's dashboard service (model usage, shards, the action pipe,
 *   charge) is cut.
 * - Memory deletion follows docs/extraction.md S8 decision (a). An operator
 *   delete is a soft delete with a restorable checkpoint, through the memory
 *   store the memory tool uses. The operator approves or rejects pending
 *   in-turn proposals through the proposal store, as the donor's resolve
 *   did. A proposal whose host turn is still waiting on the host's own
 *   approval is refused.
 * - Settings follows decision (b). The capability tier and the scheduler
 *   owner files are written with the donor's savers and answer
 *   `restartRequired`. The model is read-only.
 *
 * Introspection consent is read-only: its writer is always the companion
 * itself (faculties/core-memory/tools.ts), never the operator.
 * Every write records a Garden audit entry with actor `operator`.
 */
import {
  loadCapabilityTierConfig,
  loadSchedulerConfig,
  saveCapabilityTierConfig,
  saveSchedulerConfig,
  type MemoryDeletionProposal,
} from './companion.ts';
import type { GardenServices } from './garden.ts';
import { conflict, invalid, isNonEmptyString, isRecord, notFound, ok, type Result } from './mcp.ts';

/** What the host tells the Garden about itself. */
export interface GardenHostFacts {
  /** The model the host runs the companion with (read-only: it is named in the host's config). */
  readonly model: { readonly provider: string; readonly modelId: string };
  /** True while a host turn still waits on the host's own approval for this proposal (packages/lifecycle HostMemoryDeletionApprovals.awaiting). */
  readonly awaitingHostTurn: (proposalId: string) => boolean;
  /** How many of the latest session's turns the Overview shows. */
  readonly recentTurnLimit: number;
}

export interface LiteRequest {
  readonly principal: string;
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface LiteRoute {
  readonly method: 'GET' | 'POST' | 'PUT';
  /** Path segments; `:name` captures one. */
  readonly pattern: string;
  readonly hasBody: boolean;
  handle(request: LiteRequest): Promise<Result<unknown>>;
}

export const LITE_PREFIX = '/api/lite';

export function buildLiteRoutes(services: GardenServices, host: GardenHostFacts): LiteRoute[] {
  const { companion, ownerFiles, audit } = services;
  const handles = companion.garden;
  const proposals = companion.persistence.memoryDeletionProposalStore;
  const loadOptions = { seedDir: ownerFiles.seedDir };
  let restartRequired = false;
  const operatorId = (principal: string) => `garden:${principal}`;

  const focus = async () => {
    const sessions = await services.sessions.listSessions();
    return sessions.channels
      .map((row) => companion.sessionManager.getActiveFocusSession(row.channelId))
      .filter((snapshot) => snapshot !== null);
  };

  return [
    {
      method: 'GET',
      pattern: '/overview',
      hasBody: false,
      handle: async () => {
        const sessions = (await services.sessions.listSessions()).channels
          .slice()
          .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
        const latest = sessions[0];
        const recentTurns = latest === undefined
          ? []
          : (await services.sessions.getSessionMessages(latest.sessionId, { limit: host.recentTurnLimit, messagesOnly: true })).messages;
        const concerns = await handles.concernStore.list({});
        const schedule = services.scheduler.getFullData();
        return ok({
          companionId: services.companionId,
          model: host.model,
          tier: loadCapabilityTierConfig(ownerFiles.dataDir, loadOptions),
          restartRequired,
          heartbeat: schedule,
          openConcerns: concerns,
          focus: await focus(),
          emotion: handles.emotionState.getState(),
          latestSession: latest ?? null,
          recentTurns,
        });
      },
    },
    {
      method: 'GET',
      pattern: '/inner-life',
      hasBody: false,
      handle: async () => ok({
        focus: await focus(),
        emotion: handles.emotionState.getState(),
        introspectionConsent: handles.introspectionConsentStore.load(),
        wakeWindow: services.scheduler.getWakeWindow(),
      }),
    },
    {
      method: 'GET',
      pattern: '/memory-deletions',
      hasBody: false,
      handle: async () => {
        const pending = await proposals.listPendingMemoryDeletionProposals();
        const recoverable = await proposals.listRecoverableMemoryDeletionProposals();
        return ok({
          pending: pending.map((proposal) => ({ ...proposal, awaitingHostTurn: host.awaitingHostTurn(proposal.id) })),
          recoverable,
        });
      },
    },
    {
      method: 'POST',
      pattern: '/memory-deletions/:id/approve',
      hasBody: false,
      handle: async ({ principal, params }) => {
        const proposal = await decidable(params['id'] ?? '');
        if (!proposal.ok) return proposal;
        if (proposal.value.status === 'pending_partner_alert') await proposals.markMemoryDeletionPartnerAlerted(proposal.value.id);
        const approved = await proposals.approveMemoryDeletionProposal(proposal.value.id, operatorId(principal));
        audit.append({
          actionType: 'memory_mutation',
          decision: 'allowed',
          narrative: `Approved memory deletion proposal ${approved.id}.`,
          details: `memory ${approved.memoryId}`,
          actor: 'operator',
        });
        return ok({ proposalId: approved.id, status: approved.status, deleteId: approved.deleteId ?? null });
      },
    },
    {
      method: 'POST',
      pattern: '/memory-deletions/:id/reject',
      hasBody: false,
      handle: async ({ principal, params }) => {
        const proposal = await decidable(params['id'] ?? '');
        if (!proposal.ok) return proposal;
        if (proposal.value.status === 'pending_partner_alert') await proposals.markMemoryDeletionPartnerAlerted(proposal.value.id);
        const denied = await proposals.denyMemoryDeletionProposal(proposal.value.id, operatorId(principal));
        audit.append({
          actionType: 'memory_mutation',
          decision: 'denied',
          narrative: `Rejected memory deletion proposal ${denied.id}; the memory stays.`,
          details: `memory ${denied.memoryId}`,
          actor: 'operator',
        });
        return ok({ proposalId: denied.id, status: denied.status });
      },
    },
    {
      method: 'POST',
      pattern: '/memories/:id/delete',
      hasBody: true,
      handle: async ({ principal, params, body }) => {
        const reason = isRecord(body) && isNonEmptyString(body['reason']) ? body['reason'].trim() : undefined;
        if (body !== undefined && body !== null && !isRecord(body)) return invalid('the body must be a JSON object');
        const id = params['id'] ?? '';
        const deleted = await handles.memoryStore.softDeleteMemory(id, { deletedBy: operatorId(principal), ...(reason === undefined ? {} : { reason }) });
        if (deleted === null) return notFound('memory');
        audit.append({
          actionType: 'memory_mutation',
          decision: 'allowed',
          narrative: `Deleted memory ${deleted.memoryId}; restorable with checkpoint ${deleted.deleteId}.`,
          ...(reason === undefined ? {} : { details: reason }),
          actor: 'operator',
        });
        return ok({ memoryId: deleted.memoryId, deleteId: deleted.deleteId, deletedAt: deleted.deletedAt });
      },
    },
    {
      method: 'POST',
      pattern: '/memories/restore',
      hasBody: true,
      handle: async ({ principal, body }) => {
        const deleteId = isRecord(body) && isNonEmptyString(body['deleteId']) ? body['deleteId'].trim() : null;
        if (deleteId === null) return invalid('deleteId is required');
        const restored = await handles.memoryStore.undoSoftDelete(deleteId, { restoredBy: operatorId(principal), actorRole: 'Operator' });
        if (restored === null) return notFound('delete checkpoint (or it was already restored)');
        audit.append({
          actionType: 'memory_mutation',
          decision: 'allowed',
          narrative: `Restored memory ${restored.memoryId} from checkpoint ${restored.deleteId}.`,
          actor: 'operator',
        });
        return ok({ memoryId: restored.memoryId, deleteId: restored.deleteId, restoredAt: restored.restoredAt ?? null });
      },
    },
    {
      method: 'GET',
      pattern: '/settings',
      hasBody: false,
      handle: () => Promise.resolve(ok({
        model: host.model,
        tier: loadCapabilityTierConfig(ownerFiles.dataDir, loadOptions),
        scheduler: loadSchedulerConfig(ownerFiles.dataDir, loadOptions),
        restartRequired,
      })),
    },
    {
      method: 'PUT',
      pattern: '/settings/tier',
      hasBody: true,
      handle: ({ body }) => Promise.resolve(writeOwnerFile('capability-tier', () => saveCapabilityTierConfig(ownerFiles.dataDir, body))),
    },
    {
      method: 'PUT',
      pattern: '/settings/scheduler',
      hasBody: true,
      handle: ({ body }) => Promise.resolve(writeOwnerFile('scheduler', () => saveSchedulerConfig(ownerFiles.dataDir, body))),
    },
  ];

  /** A pending proposal the operator may decide now: not one a host turn is still waiting to settle. */
  async function decidable(proposalId: string): Promise<Result<MemoryDeletionProposal>> {
    const proposal = await proposals.getMemoryDeletionProposal(proposalId);
    if (proposal === undefined) return notFound('memory deletion proposal');
    if (proposal.status !== 'pending_partner_alert' && proposal.status !== 'pending_operator_validation') {
      return conflict('not_pending', `the proposal is ${proposal.status}`);
    }
    if (host.awaitingHostTurn(proposal.id)) {
      return conflict('awaiting_host_turn', 'a host turn is waiting on its own approval for this proposal; answer it in the host');
    }
    return ok(proposal);
  }

  function writeOwnerFile(file: 'capability-tier' | 'scheduler', save: () => unknown): Result<unknown> {
    let saved: unknown;
    try {
      saved = save();
    } catch (error) {
      audit.append({ actionType: 'settings_change', decision: 'denied', narrative: `Refused an invalid ${file} owner file.`, actor: 'operator' });
      return invalid(error instanceof Error ? error.message : `the ${file} document is not valid`);
    }
    restartRequired = true;
    audit.append({ actionType: 'settings_change', decision: 'allowed', narrative: `Wrote the ${file} owner file; it applies at the next start.`, actor: 'operator' });
    return ok({ restartRequired: true, [file === 'scheduler' ? 'scheduler' : 'tier']: saved });
  }
}
