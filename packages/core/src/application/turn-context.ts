import type { ActivityRecord } from '../activity/index.ts';
import type { CoreBlock } from '../identity/index.ts';
import type { SessionArchivePort } from '../sessions/index.ts';
import { denied, invalid, ok, sameConversation, type Result, type SessionId, type TurnId } from '../shared/index.ts';
import { permitsAction } from './action-permission.ts';
import type { ActivityService } from './activity.ts';
import { contextFromHistory, internalContext, type ContextEntry } from './context.ts';
import type { OrientationService } from './orientation-service.ts';
import type { SelfStateContext } from './self-state-context.ts';
import { TOOL_INVENTORY, resolveAction } from './tool-inventory.ts';
import { isTrustedTurnScope, type TrustedTurnScope } from './trusted-scope.ts';

export interface TurnContextLimits {
  /** Canonical history entries shown before the trigger. */
  readonly historyEntries: number;
  /** Self-state items, and recent activities, shown for the turn. */
  readonly selfStateItems: number;
}

/**
 * Everything a harness shows the companion before a turn, read only under
 * the turn's scope. Identity comes from the enabled prompt layers and the
 * conversation's orientation blocks; awareness from the labelled self-state
 * and the recent activity this audience may read, including activity on
 * other surfaces and in other conversations it is admitted to; the
 * conversation from canonical history. Nothing here is participant speech
 * except history entries core attributed as such at ingress.
 */
export interface TurnContextParts {
  readonly layers: readonly string[];
  readonly orientation: readonly CoreBlock[];
  readonly internal: readonly ContextEntry[];
  readonly activity: readonly ContextEntry[];
  readonly history: readonly ContextEntry[];
}

export interface TurnContextAssembler {
  /**
   * `excludeTurn` leaves out the entries of a turn already open in the
   * session (its archived trigger), so a resumed preparation shows the same
   * history the first one did.
   */
  assemble(
    scope: TrustedTurnScope,
    input: { readonly sessionId: SessionId; readonly limits: TurnContextLimits; readonly excludeTurn: TurnId | null },
  ): Promise<Result<TurnContextParts>>;
}

export interface TurnContextDeps {
  readonly orientation: Pick<OrientationService, 'view' | 'listLayers'>;
  readonly selfState: SelfStateContext;
  readonly activity: Pick<ActivityService, 'recent'>;
  readonly archive: Pick<SessionArchivePort, 'readTail'>;
}

export function createTurnContextAssembler(deps: TurnContextDeps): TurnContextAssembler {
  return {
    async assemble(scope, input) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      const { historyEntries, selfStateItems } = input.limits;
      if (!positive(historyEntries) || !positive(selfStateItems)) return invalid('context limits must be positive integers');
      const layers = await deps.orientation.listLayers(scope);
      if (!layers.ok) return layers;
      // Orientation blocks belong to a conversation; a self turn has none, by core's design.
      const blocks = scope.audience.kind === 'self' ? ok([]) : await deps.orientation.view(scope);
      if (!blocks.ok) return blocks;
      const internal = await deps.selfState.build(scope, { limit: selfStateItems });
      if (!internal.ok) return internal;
      const activity = await recentActivity(deps.activity, scope, selfStateItems);
      if (!activity.ok) return activity;
      // One extra entry per excluded turn trigger keeps the window the same size.
      const tail = await deps.archive.readTail(input.sessionId, historyEntries + (input.excludeTurn === null ? 0 : 1));
      if (!tail.ok) return tail;
      const history = tail.value.filter((entry) => entry.turnId !== input.excludeTurn).slice(-historyEntries);
      return ok({
        layers: layers.value.filter((layer) => layer.enabled && layer.content.trim().length > 0).map((layer) => layer.content.trim()),
        orientation: blocks.value.filter((block) => block.text.trim().length > 0),
        internal: internal.value,
        activity: activity.value,
        history: history.map(contextFromHistory),
      });
    },
  };
}

/** The activity this scope may read, gated like `activity.recent` itself, as one labelled internal signal. */
async function recentActivity(activity: Pick<ActivityService, 'recent'>, scope: TrustedTurnScope, limit: number): Promise<Result<readonly ContextEntry[]>> {
  const resolved = resolveAction(TOOL_INVENTORY, 'activity', 'recent');
  if (!resolved.ok || !permitsAction(scope, 'activity', 'recent', resolved.value.action).ok) return ok([]);
  const recent = await activity.recent(scope, { limit });
  if (!recent.ok) return recent;
  if (recent.value.length === 0) return ok([]);
  const entry = internalContext(
    { kind: 'internal_signal', source: 'activity' },
    ['Recent activity you may know about, most recent first (awareness is not permission to disclose it):', ...recent.value.map((r) => `- ${describeActivity(scope, r)}`)].join('\n'),
  );
  return entry.ok ? ok([entry.value]) : entry;
}

function describeActivity(scope: TrustedTurnScope, record: ActivityRecord): string {
  const where =
    record.visibility.kind === 'self'
      ? 'in your own time'
      : sameConversation(scope.audience, record.visibility)
        ? 'in this conversation'
        : 'in another conversation';
  const by = record.source.workerRunId === null ? '' : ' (a worker run)';
  const outcome = record.outcome === null ? '' : `; outcome: ${record.outcome}`;
  const artifacts = record.artifacts.length === 0 ? '' : `; artifacts: ${record.artifacts.slice(0, 3).map((a) => `${a.kind}:${a.ref}`).join(', ')}`;
  return `${where}${by}: ${record.purpose} [${record.status}${outcome}${artifacts}] since ${record.startedAt}, updated ${record.updatedAt}`;
}

function positive(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}
