import type { SessionCatalogPort, TurnLedgerPort } from '../sessions/index.ts';
import { conversationKey, ok, type Result, type SessionId, type TurnId } from '../shared/index.ts';
import type { TrustedTurnScope } from './trusted-scope.ts';

/** The session and open turn of a scope's conversation, as the durable state records them. */
export interface CurrentTurn {
  readonly sessionId: SessionId | null;
  readonly turnId: TurnId | null;
}

/**
 * Resolves what an action made in this scope is bound to, from the session
 * catalog and the turn ledger, never from model arguments.
 */
export function currentTurnOf(deps: { readonly catalog: SessionCatalogPort; readonly ledger: TurnLedgerPort }) {
  return async (scope: TrustedTurnScope): Promise<Result<CurrentTurn>> => {
    const head = await deps.catalog.active(conversationKey(scope.audience));
    if (!head.ok) return head;
    if (head.value === null) return ok({ sessionId: null, turnId: null });
    const ledger = await deps.ledger.head(head.value.sessionId);
    if (!ledger.ok) return ledger;
    return ok({ sessionId: head.value.sessionId, turnId: ledger.value.openTurnId });
  };
}
