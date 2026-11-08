import {
  canViewConcern,
  followUpId,
  normalizeDueAt,
  normalizeFollowUpContent,
  type ConcernPort,
  type FollowUpPort,
  type FollowUpState,
  type PendingFollowUp,
} from '../intention/index.ts';
import type { SessionCatalogPort } from '../sessions/index.ts';
import {
  canViewerRead,
  conflict,
  denied,
  invalid,
  notFound,
  sameConversation,
  type ChannelId,
  type Clock,
  type Result,
} from '../shared/index.ts';
import { conversationTarget } from './conversation-target.ts';
import { collectPaged } from './paging.ts';
import { authorOf, isTrustedTurnScope, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';

export interface FollowUpService {
  list(scope: TrustedTurnScope, input: { readonly includeDone: boolean; readonly limit: number }): Promise<Result<readonly PendingFollowUp[]>>;
  /** Pending follow-ups for this conversation whose due time has passed. */
  due(scope: TrustedTurnScope, input: { readonly limit: number }): Promise<Result<readonly PendingFollowUp[]>>;
  create(
    scope: TrustedTurnScope,
    input: { readonly content: string; readonly dueAt: string; readonly channelId: ChannelId | null; readonly concernId: string | null },
  ): Promise<Result<{ readonly followUp: PendingFollowUp; readonly created: boolean }>>;
  activate(scope: TrustedTurnScope, input: { readonly followUpId: string; readonly expectedRevision: number }): Promise<Result<PendingFollowUp>>;
}

/**
 * Follow-ups the companion intends to raise in a conversation. The target is
 * the current conversation or another one this scope can read; its audience
 * is stored so every later read is gated by `canViewerRead`. Creation is
 * idempotent by target, content and due time.
 */
export function createFollowUpService(deps: {
  readonly followUps: FollowUpPort;
  readonly catalog: SessionCatalogPort;
  readonly concerns: ConcernPort;
  readonly clock: Clock;
}): FollowUpService {
  /** Up to `limit` follow-ups this scope may read, earliest due first. */
  const visible = (
    scope: TrustedTurnScope,
    input: { readonly state: FollowUpState | null; readonly dueAtOrBefore: string | null; readonly limit: number; readonly match?: (f: PendingFollowUp) => boolean },
  ) => {
    const viewer = viewerOf(scope);
    return collectPaged({
      fetch: (after, pageSize) => deps.followUps.list({ state: input.state, dueAtOrBefore: input.dueAtOrBefore, limit: pageSize, after }),
      cursorOf: (f: PendingFollowUp) => ({ dueAt: f.dueAt, id: f.id }),
      keep: (f) => canViewerRead(viewer, f.target) && (input.match?.(f) ?? true),
      limit: input.limit,
    });
  };

  const targetFor = conversationTarget(deps.catalog, 'a follow-up');

  return {
    async list(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      return visible(scope, { state: input.includeDone ? null : 'pending', dueAtOrBefore: null, limit: input.limit });
    },

    async due(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      return visible(scope, {
        state: 'pending',
        dueAtOrBefore: deps.clock.now().toISOString(),
        limit: input.limit,
        match: (f) => sameConversation(f.target, scope.audience),
      });
    },

    async create(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'follow-ups are companion-authored');
      const content = normalizeFollowUpContent(input.content);
      if (!content.ok) return content;
      const dueAt = normalizeDueAt(input.dueAt);
      if (!dueAt.ok) return dueAt;
      const target = await targetFor(scope, input.channelId);
      if (!target.ok) return target;
      if (input.concernId !== null) {
        const concern = await deps.concerns.get(input.concernId);
        if (!concern.ok && concern.error.kind !== 'not_found') return concern;
        if (!concern.ok || !canViewConcern(viewerOf(scope), concern.value)) return notFound(`concern ${input.concernId}`);
      }
      return deps.followUps.create({
        id: followUpId(target.value, content.value, dueAt.value),
        target: target.value,
        content: content.value,
        dueAt: dueAt.value,
        state: 'pending',
        concernId: input.concernId,
        author: authorOf(scope),
        createdAt: deps.clock.now().toISOString(),
        activatedAt: null,
        revision: 1,
      });
    },

    async activate(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const found = await deps.followUps.get(input.followUpId);
      if (!found.ok) return found.error.kind === 'not_found' ? notFound(`follow-up ${input.followUpId}`) : found;
      const followUp = found.value;
      if (!canViewerRead(viewerOf(scope), followUp.target)) return notFound(`follow-up ${input.followUpId}`);
      if (!sameConversation(followUp.target, scope.audience)) return invalid('a follow-up is activated in the conversation it targets');
      if (followUp.revision !== input.expectedRevision) {
        return conflict('stale_revision', `follow-up ${followUp.id} moved`, { expectedRevision: input.expectedRevision, actualRevision: followUp.revision });
      }
      if (followUp.state !== 'pending') return invalid(`follow-up is already ${followUp.state}`);
      return deps.followUps.update(
        { ...followUp, state: 'activated', activatedAt: deps.clock.now().toISOString(), revision: followUp.revision + 1 },
        followUp.revision,
      );
    },
  };
}

function untrusted() {
  return denied('unknown_authority', 'scope was not admitted by ingress');
}
