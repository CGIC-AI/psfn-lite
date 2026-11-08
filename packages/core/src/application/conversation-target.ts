import type { SessionCatalogPort } from '../sessions/index.ts';
import { canViewerRead, invalid, notFound, ok, type Audience, type ChannelId, type Result } from '../shared/index.ts';
import { viewerOf, type TrustedTurnScope } from './trusted-scope.ts';

/**
 * The conversation something is aimed at: the current one, or another named
 * channel this scope can read. An unreadable channel reads as missing.
 */
export function conversationTarget(catalog: SessionCatalogPort, what: string) {
  return async (scope: TrustedTurnScope, channelId: ChannelId | null): Promise<Result<Audience>> => {
    if (channelId === null) {
      return scope.audience.kind === 'self' ? invalid(`${what} from a companion-internal turn must name channelId`) : ok(scope.audience);
    }
    const head = await catalog.active(`channel:${channelId}`);
    if (!head.ok) return head;
    if (head.value === null) return notFound(`channel ${channelId}`);
    const session = await catalog.get(head.value.sessionId);
    if (!session.ok) return session;
    return canViewerRead(viewerOf(scope), session.value.audience) ? ok(session.value.audience) : notFound(`channel ${channelId}`);
  };
}
