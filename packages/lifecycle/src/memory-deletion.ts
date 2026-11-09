/**
 * Memory deletion approved by the host's human (docs/extraction.md, Step E3).
 *
 * The donor `memory` tool never deletes on its own: action=delete records a
 * pending proposal and asks the MemoryDeletionApprovalPort for a human
 * decision; the memory is deleted only when the proposal is approved
 * (MemoryDeletionProposalStorePort.approveMemoryDeletionProposal). The donor's
 * port was the gateway's confirmation surface, whose resolve called approve
 * or deny (donor app/agent/main.ts:583-602).
 *
 * For a host-driven turn, the human decision is the host's own approval gate,
 * taken before the call runs: Hermes asks its human for the companion's
 * memory delete call (the plugin's `pre_tool_call` returns `approve`), runs
 * the call only on an approval, and the plugin then resolves the proposal the
 * call created. This port records which host turn requested each proposal; an
 * approval is accepted once, only from that turn's owner while the turn is
 * open, for that memory, and within the approval window. A proposal requested outside a host turn (the operator's
 * own Pi turns, a boot replay of pending proposals) stays pending, as the
 * donor leaves it until a decision arrives.
 */
import { getRequestContext, type MemoryDeletionApprovalPort, type MemoryDeletionApprovalRequest, type MemoryDeletionApprovalResult, type MemoryDeletionProposalStorePort } from './companion.ts';
import type { HostTurnRelay } from './host-turns.ts';
import { conflict, notFound, ok, unavailable, type Result } from './mcp.ts';

export interface HostMemoryDeletionOptions {
  readonly relay: HostTurnRelay;
  /** How long after the request the host may resolve it (the host-turn timeout: the call and its resolve happen inside the turn). */
  readonly approvalWindowMs: number;
  readonly now?: () => number;
}

export interface MemoryDeletionResolution {
  readonly proposalId: string;
  readonly status: 'approved';
  readonly deleteId: string;
}

interface Requested {
  readonly turnId: string;
  readonly owner: string;
  readonly memoryId: string;
  readonly expiresAt: number;
}

type ProposalStore = Pick<MemoryDeletionProposalStorePort, 'getMemoryDeletionProposal' | 'markMemoryDeletionPartnerAlerted' | 'approveMemoryDeletionProposal'>;

export class HostMemoryDeletionApprovals implements MemoryDeletionApprovalPort {
  private readonly requested = new Map<string, Requested>();
  private store: ProposalStore | null = null;
  private readonly now: () => number;

  constructor(private readonly options: HostMemoryDeletionOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The companion's proposal store, once the runtime has built it. */
  attach(store: ProposalStore): void {
    this.store = store;
  }

  requestMemoryDeletionApproval(request: MemoryDeletionApprovalRequest): Promise<MemoryDeletionApprovalResult> {
    const channelId = getRequestContext()?.channelId;
    const turn = channelId === undefined ? undefined : this.options.relay.open().find((candidate) => candidate.channelId === channelId && !candidate.isEnded);
    const expiresAt = this.now() + this.options.approvalWindowMs;
    if (turn !== undefined) this.requested.set(request.proposalId, { turnId: turn.turnId, owner: turn.owner, memoryId: request.memoryId, expiresAt });
    this.forgetExpired();
    return Promise.resolve({ status: 'approval_required', proposalId: request.proposalId, approvalId: `host:${request.proposalId}`, expiresAt });
  }

  /** The host's human approved the call that requested this proposal: approve it as the donor's resolve did (main.ts:587-601). */
  async approve(owner: string, proposalId: string, memoryId: string, operatorId: string): Promise<Result<MemoryDeletionResolution>> {
    const store = this.store;
    if (store === null) return unavailable('memory_deletion', 'the companion runtime is not ready');
    const requested = this.requested.get(proposalId);
    if (requested === undefined || requested.owner !== owner) return notFound('memory deletion proposal');
    // One answer per request: a refused approval leaves the proposal pending for good.
    this.requested.delete(proposalId);
    if (requested.memoryId !== memoryId) return conflict('memory_mismatch', 'the proposal is for another memory; it stays pending');
    if (this.now() > requested.expiresAt) return conflict('approval_expired', 'the proposal was requested too long ago; it stays pending');
    if (!this.options.relay.open().some((turn) => turn.turnId === requested.turnId && !turn.isEnded)) {
      return conflict('turn_ended', 'the turn that requested the proposal has ended; it stays pending');
    }
    const proposal = await store.getMemoryDeletionProposal(proposalId);
    if (proposal === undefined) return notFound('memory deletion proposal');
    if (proposal.status === 'pending_partner_alert') await store.markMemoryDeletionPartnerAlerted(proposalId);
    const approved = await store.approveMemoryDeletionProposal(proposalId, operatorId);
    if (approved.status !== 'approved' || approved.deleteId === undefined) {
      throw new Error(`Approved memory deletion proposal ${proposalId} has no delete checkpoint`);
    }
    return ok({ proposalId: approved.id, status: 'approved', deleteId: approved.deleteId });
  }

  /**
   * Read-only, for the light Garden (docs/extraction.md S8 decision a): true
   * while a host turn that requested this proposal may still approve it
   * (recorded, unexpired, its turn open). The Garden leaves such a proposal
   * to the host's own approval gate.
   */
  awaiting(proposalId: string): boolean {
    const requested = this.requested.get(proposalId);
    if (requested === undefined || this.now() > requested.expiresAt) return false;
    return this.options.relay.open().some((turn) => turn.turnId === requested.turnId && !turn.isEnded);
  }

  private forgetExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.requested) if (now > entry.expiresAt) this.requested.delete(id);
  }
}
