import type { ActivityLogPort, ActivityRecord, ActivityStatus, ArtifactRef } from '../activity/index.ts';
import {
  denied,
  fail,
  invalid,
  isNonEmptyString,
  notFound,
  type ActivityId,
  type Audience,
  type Author,
  type Clock,
  type IdSource,
  type Result,
  type SessionId,
  type TurnId,
} from '../shared/index.ts';
import { isTrustedTurnScope, type TrustedTurnScope } from './trusted-scope.ts';

export interface ActivityService {
  start(
    scope: TrustedTurnScope,
    input: { readonly purpose: string; readonly sessionId: SessionId | null; readonly turnId: TurnId | null },
  ): Promise<Result<ActivityRecord>>;
  update(
    scope: TrustedTurnScope,
    input: {
      readonly id: ActivityId;
      readonly expectedRevision: number;
      readonly status?: Exclude<ActivityStatus, 'in_progress'>;
      readonly outcome?: string;
      readonly artifacts?: readonly ArtifactRef[];
      readonly note?: string;
    },
  ): Promise<Result<ActivityRecord>>;
  get(scope: TrustedTurnScope, id: ActivityId): Promise<Result<ActivityRecord>>;
}

/**
 * Records what the companion is doing, bound to the turn and audience it
 * happened in. Note authorship comes from the scope: a worker's note is
 * machine output, never companion-authored reflection.
 */
export function createActivityService(deps: {
  readonly log: ActivityLogPort;
  readonly clock: Clock;
  readonly ids: IdSource;
}): ActivityService {
  const readVisible = async (scope: TrustedTurnScope, id: ActivityId): Promise<Result<ActivityRecord>> => {
    if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
    const found = await deps.log.get(id);
    if (!found.ok) return found;
    if (!isVisibleTo(scope.audience, found.value.visibility)) return notFound(`activity ${id}`);
    return found;
  };

  return {
    async start(scope, input) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      if (!isNonEmptyString(input.purpose)) return invalid('activity purpose must be non-empty');
      const at = deps.clock.now().toISOString();
      return deps.log.insert({
        id: deps.ids.next('activity'),
        purpose: input.purpose,
        status: 'in_progress',
        outcome: null,
        artifacts: [],
        notes: [],
        source: {
          sessionId: input.sessionId,
          turnId: input.turnId,
          workerRunId: scope.caller.kind === 'worker' ? scope.caller.runId : null,
        },
        visibility: scope.audience,
        startedAt: at,
        updatedAt: at,
        revision: 1,
      });
    },

    async update(scope, input) {
      const found = await readVisible(scope, input.id);
      if (!found.ok) return found;
      const record = found.value;
      if (record.revision !== input.expectedRevision) {
        return fail({
          kind: 'conflict',
          reason: 'stale_revision',
          expectedRevision: input.expectedRevision,
          actualRevision: record.revision,
          detail: 'activity changed since it was read',
        });
      }
      if (input.status !== undefined && record.status !== 'in_progress') {
        return invalid(`activity already settled as ${record.status}`);
      }
      if (input.note !== undefined && !isNonEmptyString(input.note)) return invalid('activity note must be non-empty');
      return deps.log.update(
        {
          ...record,
          status: input.status ?? record.status,
          outcome: input.outcome ?? record.outcome,
          artifacts: [...record.artifacts, ...(input.artifacts ?? [])],
          notes: input.note === undefined ? record.notes : [...record.notes, { author: noteAuthor(scope), text: input.note }],
          updatedAt: deps.clock.now().toISOString(),
          revision: record.revision + 1,
        },
        input.expectedRevision,
      );
    },

    get: readVisible,
  };
}

function noteAuthor(scope: TrustedTurnScope): Author {
  return scope.caller.kind === 'worker' ? { kind: 'machine', producer: `worker:${scope.caller.runId}` } : { kind: 'companion' };
}

/** Self turns see everything; otherwise only activity from the same channel is visible. */
function isVisibleTo(viewer: Audience, visibility: Audience): boolean {
  if (viewer.kind === 'self') return true;
  if (visibility.kind === 'self') return false;
  return viewer.channelId === visibility.channelId;
}
