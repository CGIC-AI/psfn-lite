import type { ActivityLogPort, ActivityRecord, ActivityStatus, ArtifactRef } from '../activity/index.ts';
import {
  canViewerRead,
  conflict,
  denied,
  invalid,
  isNonEmptyString,
  notFound,
  ok,
  type ActivityId,
  type Audience,
  type Author,
  type Clock,
  type IdSource,
  type Result,
  type SessionId,
  type TurnId,
  type WorkerRunId,
} from '../shared/index.ts';
import { collectPaged } from './paging.ts';
import { authorOf, isTrustedTurnScope, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';

const PURPOSE_MAX = 500;
const OUTCOME_MAX = 4_000;
const NOTE_MAX = 4_000;
const ARTIFACTS_MAX = 50;

export interface ActivityUpdate {
  readonly id: ActivityId;
  readonly expectedRevision: number;
  readonly status?: Exclude<ActivityStatus, 'in_progress'>;
  readonly outcome?: string;
  readonly artifacts?: readonly ArtifactRef[];
  readonly note?: string;
}

export interface ActivityService {
  start(
    scope: TrustedTurnScope,
    input: { readonly purpose: string; readonly sessionId: SessionId | null; readonly turnId: TurnId | null },
  ): Promise<Result<ActivityRecord>>;
  update(scope: TrustedTurnScope, input: ActivityUpdate): Promise<Result<ActivityRecord>>;
  get(scope: TrustedTurnScope, id: ActivityId): Promise<Result<ActivityRecord>>;
  /** Visible activities, most recently started first; hidden ones are neither counted nor hinted at. */
  recent(scope: TrustedTurnScope, input: { readonly limit: number }): Promise<Result<readonly ActivityRecord[]>>;
}

/**
 * Who may see an activity. A worker always reaches the activity of its own
 * run; otherwise the reader must be able to read the audience the activity
 * happened in (`canViewerRead`, which also holds a worker to its grant's
 * ceiling). Awareness of an activity is not permission to disclose it.
 */
export function canSeeActivity(scope: TrustedTurnScope, record: ActivityRecord): boolean {
  if (scope.caller.kind === 'worker' && record.source.workerRunId === scope.caller.runId) return true;
  return canViewerRead(viewerOf(scope), record.visibility);
}

/** A fresh in-progress activity record; ids derived by the caller keep retries idempotent. */
export function newActivity(input: {
  readonly id: ActivityId;
  readonly purpose: string;
  readonly visibility: Audience;
  readonly sessionId: SessionId | null;
  readonly turnId: TurnId | null;
  readonly workerRunId: WorkerRunId | null;
  readonly at: string;
}): Result<ActivityRecord> {
  const purpose = input.purpose.trim();
  if (purpose.length === 0 || purpose.length > PURPOSE_MAX) return invalid(`activity purpose must be 1-${PURPOSE_MAX} characters`);
  return ok({
      id: input.id,
      purpose,
      status: 'in_progress',
      outcome: null,
      artifacts: [],
      notes: [],
      source: { sessionId: input.sessionId, turnId: input.turnId, workerRunId: input.workerRunId },
      visibility: input.visibility,
      startedAt: input.at,
      updatedAt: input.at,
      revision: 1,
  });
}

/** Applies an update to a record already checked for visibility; authorship comes from `author`. */
export function applyActivityUpdate(record: ActivityRecord, input: Omit<ActivityUpdate, 'id'>, author: Author, at: string): Result<ActivityRecord> {
  if (record.revision !== input.expectedRevision) {
    return conflict('stale_revision', 'activity changed since it was read', { expectedRevision: input.expectedRevision, actualRevision: record.revision });
  }
  if (input.status !== undefined && record.status !== 'in_progress') return invalid(`activity already settled as ${record.status}`);
  if (input.note !== undefined && (!isNonEmptyString(input.note) || input.note.length > NOTE_MAX)) return invalid(`activity note must be 1-${NOTE_MAX} characters`);
  if (input.outcome !== undefined && (!isNonEmptyString(input.outcome) || input.outcome.length > OUTCOME_MAX)) {
    return invalid(`activity outcome must be 1-${OUTCOME_MAX} characters`);
  }
  const artifacts = [...record.artifacts, ...(input.artifacts ?? [])];
  if (artifacts.length > ARTIFACTS_MAX) return invalid(`an activity holds at most ${ARTIFACTS_MAX} artifacts`);
  return ok({
      ...record,
      status: input.status ?? record.status,
      outcome: input.outcome ?? record.outcome,
      artifacts,
      notes: input.note === undefined ? record.notes : [...record.notes, { author, text: input.note }],
      updatedAt: at,
      revision: record.revision + 1,
  });
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
    if (!found.ok) return found.error.kind === 'not_found' ? notFound(`activity ${id}`) : found;
    if (!canSeeActivity(scope, found.value)) return notFound(`activity ${id}`);
    return found;
  };

  return {
    async start(scope, input) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      const record = newActivity({
        id: deps.ids.next('activity'),
        purpose: input.purpose,
        visibility: scope.audience,
        sessionId: input.sessionId,
        turnId: input.turnId,
        workerRunId: scope.caller.kind === 'worker' ? scope.caller.runId : null,
        at: deps.clock.now().toISOString(),
      });
      return record.ok ? deps.log.insert(record.value) : record;
    },

    async update(scope, input) {
      const found = await readVisible(scope, input.id);
      if (!found.ok) return found;
      const next = applyActivityUpdate(found.value, input, authorOf(scope), deps.clock.now().toISOString());
      return next.ok ? deps.log.update(next.value, input.expectedRevision) : next;
    },

    get: readVisible,

    async recent(scope, input) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      return collectPaged({
        fetch: (after, pageSize) => deps.log.list(pageSize, after),
        cursorOf: (r: ActivityRecord) => ({ startedAt: r.startedAt, id: r.id }),
        keep: (r) => canSeeActivity(scope, r),
        limit: input.limit,
      });
    },
  };
}
