import type { MemoryDeletionPort, MemoryDeletionProposal, MemoryRecord, MemoryStorePort } from '../memory/index.ts';
import { conflict, invalid, isNonEmptyString, ok, type Author, type Clock, type Result } from '../shared/index.ts';

/**
 * Operator decisions core never takes on its own: applying or denying a
 * memory deletion proposal, and reviewing memories a worker staged. The host
 * calls these only for an authenticated operator; `actor` names them in the
 * audit trail.
 */
export interface MemoryAdministration {
  decideDeletion(actor: string, input: { readonly proposalId: string; readonly approve: boolean }): Promise<Result<MemoryDeletionProposal>>;
  listStaged(limit: number): Promise<Result<readonly MemoryRecord[]>>;
  reviewStaged(actor: string, input: { readonly memoryId: string; readonly approve: boolean }): Promise<Result<MemoryRecord>>;
}

export function createMemoryAdministration(deps: {
  readonly store: MemoryStorePort;
  readonly deletions: MemoryDeletionPort;
  readonly clock: Clock;
}): MemoryAdministration {
  const operator = (actor: string): Result<Author> =>
    isNonEmptyString(actor) ? ok({ kind: 'operator', actor }) : invalid('an operator decision names its actor');

  return {
    async decideDeletion(actor, input) {
      const author = operator(actor);
      if (!author.ok) return author;
      const proposal = await deps.deletions.get(input.proposalId);
      if (!proposal.ok) return proposal;
      if (proposal.value.status !== 'pending') return conflict('stale_revision', `proposal ${input.proposalId} is already ${proposal.value.status}`);
      const at = deps.clock.now().toISOString();
      const decided = (status: MemoryDeletionProposal['status']): MemoryDeletionProposal => ({
        ...proposal.value,
        status,
        decidedBy: author.value,
        decidedAt: at,
        revision: proposal.value.revision + 1,
      });
      if (!input.approve) return deps.deletions.save(decided('denied'), proposal.value.revision);
      const memory = await deps.store.get(proposal.value.memoryId);
      if (!memory.ok) return memory;
      if (memory.value.revision !== proposal.value.memoryRevision || memory.value.state !== 'current') {
        return conflict('stale_revision', `memory ${memory.value.id} changed after the proposal; it needs a fresh proposal`, {
          expectedRevision: proposal.value.memoryRevision,
          actualRevision: memory.value.revision,
        });
      }
      const deleted = await deps.store.update(
        { ...memory.value, state: 'soft_deleted', revision: memory.value.revision + 1, updatedAt: at },
        memory.value.revision,
        { memoryId: memory.value.id, kind: 'soft_deleted', author: author.value, at, detail: { proposalId: proposal.value.proposalId } },
      );
      if (!deleted.ok) return deleted;
      return deps.deletions.save(decided('approved'), proposal.value.revision);
    },

    listStaged: (limit) => deps.store.staged(limit),

    async reviewStaged(actor, input) {
      const author = operator(actor);
      if (!author.ok) return author;
      const memory = await deps.store.get(input.memoryId);
      if (!memory.ok) return memory;
      if (memory.value.state !== 'staged') return invalid(`memory ${input.memoryId} is not staged`);
      const at = deps.clock.now().toISOString();
      return deps.store.update(
        { ...memory.value, state: input.approve ? 'current' : 'rejected', revision: memory.value.revision + 1, updatedAt: at },
        memory.value.revision,
        { memoryId: memory.value.id, kind: input.approve ? 'approved' : 'rejected', author: author.value, at, detail: {} },
      );
    },
  };
}
