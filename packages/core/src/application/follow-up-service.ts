import {
  canViewConcern,
  followUpId,
  normalizeDueAt,
  normalizeFollowUpContent,
  type ConcernPort,
  type FollowUpPort,
  type PendingFollowUp,
} from '../intention/index.ts';
import type { SessionCatalogPort } from '../sessions/index.ts';
import {
  canViewerRead,
  conflict,
  denied,
  invalid,
  notFound,
  ok,
  sameConversation,
  type Audience,
  type ChannelId,
  type Clock,
  type Result,
} from '../shared/index.ts';
import { authorOf, isTrustedTurnScope, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';

const RECENT_SCAN = 500;

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
  const visible = async (scope: TrustedTurnScope): Promise<Result<readonly PendingFollowUp[]>> => {
    const listed = await deps.followUps.list(RECENT_SCAN);
    if (!listed.ok) return listed;
    const viewer = viewerOf(scope);
    return ok(listed.value.filter((f) => canViewerRead(viewer, f.target)));
  };

  const targetFor = async (scope: TrustedTurnScope, channelId: ChannelId | null): Promise<Result<Audience>> => {
    if (channelId === null) {
      return scope.audience.kind === 'self' ? invalid('a follow-up from a companion-internal turn must name channelId') : ok(scope.audience);
    }
    const head = await deps.catalog.active(`channel:${channelId}`);
    if (!head.ok) return head;
    if (head.value === null) return notFound(`channel ${channelId}`);
    const session = await deps.catalog.get(head.value.sessionId);
    if (!session.ok) return session;
    return canViewerRead(viewerOf(scope), session.value.audience) ? ok(session.value.audience) : notFound(`channel ${channelId}`);
  };

  return {
    async list(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const followUps = await visible(scope);
      if (!followUps.ok) return followUps;
      return ok(followUps.value.filter((f) => input.includeDone || f.state === 'pending').slice(0, input.limit));
    },

    async due(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const followUps = await visible(scope);
      if (!followUps.ok) return followUps;
      const now = deps.clock.now().getTime();
      return ok(
        followUps.value
          .filter((f) => f.state === 'pending' && sameConversation(f.target, scope.audience) && Date.parse(f.dueAt) <= now)
          .slice(0, input.limit),
      );
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
