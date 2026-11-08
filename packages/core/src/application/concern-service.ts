import type { Vad } from '../emotion/index.ts';
import {
  CONCERN_DUPLICATE_SIMILARITY,
  MAX_CONCERN_OUTCOME_CHARS,
  MAX_CONCERN_TEXT_CHARS,
  canViewConcern,
  concernTextSimilarity,
  describeConcernArc,
  isOpenConcernStatus,
  isTerminalConcernStatus,
  mergeEvidence,
  normalizeDueAt,
  parseEvidenceRefs,
  reliefDelta,
  validateConcernTransition,
  type ActiveConcern,
  type ConcernEvent,
  type ConcernPort,
  type ConcernPriority,
  type ConcernResolution,
  type ConcernTransitionTarget,
} from '../intention/index.ts';
import {
  SENSITIVITIES,
  conflict,
  denied,
  invalid,
  notFound,
  ok,
  type Clock,
  type CoreError,
  type IdSource,
  type Result,
  type Sensitivity,
} from '../shared/index.ts';
import { authorOf, isTrustedTurnScope, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';

const RECENT_SCAN = 500;
const ARC_PRODUCER = 'intention.concern_arc';

export type ReliefOutcome =
  | { readonly status: 'applied' | 'duplicate' }
  /** No relief exists: the concern did not resolve, or one of its two affect snapshots was never captured. */
  | { readonly status: 'not_captured' }
  /** The resolution is durable; applying its relief failed and is reported, not hidden. */
  | { readonly status: 'failed'; readonly error: CoreError };

export interface ConcernTransitionOutcome {
  readonly concern: ActiveConcern;
  readonly relief: ReliefOutcome;
}

export interface ConcernService {
  list(scope: TrustedTurnScope, input: { readonly includeClosed: boolean; readonly limit: number }): Promise<Result<readonly ActiveConcern[]>>;
  create(
    scope: TrustedTurnScope,
    input: {
      readonly text: string;
      readonly priority: ConcernPriority;
      readonly sensitivity: Sensitivity | null;
      readonly evidenceRefs: unknown;
      readonly nextReviewAt: string | null;
    },
  ): Promise<Result<ActiveConcern>>;
  transition(
    scope: TrustedTurnScope,
    input: {
      readonly concernId: string;
      readonly to: ConcernTransitionTarget;
      readonly expectedRevision: number;
      readonly outcome: string | null;
      readonly evidenceRefs: unknown;
      readonly nextReviewAt: string | null;
    },
  ): Promise<Result<ConcernTransitionOutcome>>;
}

/**
 * Companion-owned concerns. Every read and target is gated by
 * `canViewConcern`, so a concern the audience may not see reads as missing and
 * is never counted. Writes are compare-and-set and append an event, so
 * evidence and earlier resolutions survive reopening. Formation and resolution
 * affect come only from the scope's trusted, fresh estimate.
 */
export function createConcernService(deps: {
  readonly concerns: ConcernPort;
  readonly emotion: {
    currentVad(scope: TrustedTurnScope): Promise<Result<Vad | null>>;
    applyRelief(scope: TrustedTurnScope, input: { readonly generationId: string; readonly delta: Vad }): Promise<Result<'applied' | 'duplicate'>>;
  };
  readonly clock: Clock;
  readonly ids: IdSource;
}): ConcernService {
  const visible = async (scope: TrustedTurnScope): Promise<Result<readonly ActiveConcern[]>> => {
    const listed = await deps.concerns.list(RECENT_SCAN);
    if (!listed.ok) return listed;
    const viewer = viewerOf(scope);
    return ok(listed.value.filter((c) => canViewConcern(viewer, c)));
  };

  const visibleOne = async (scope: TrustedTurnScope, id: string): Promise<Result<ActiveConcern>> => {
    const found = await deps.concerns.get(id);
    if (!found.ok) return found.error.kind === 'not_found' ? notFound(`concern ${id}`) : found;
    return canViewConcern(viewerOf(scope), found.value) ? found : notFound(`concern ${id}`);
  };

  return {
    async list(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const concerns = await visible(scope);
      if (!concerns.ok) return concerns;
      return ok(concerns.value.filter((c) => input.includeClosed || isOpenConcernStatus(c.status)).slice(0, input.limit));
    },

    async create(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'concerns are companion-authored');
      const text = input.text.replace(/\s+/g, ' ').trim();
      if (text.length === 0 || text.length > MAX_CONCERN_TEXT_CHARS) return invalid(`text must be 1-${MAX_CONCERN_TEXT_CHARS} characters`);
      // Unspecified sensitivity is the most private class admitted here, never a wider one.
      const sensitivity = input.sensitivity ?? [...SENSITIVITIES].reverse().find((s) => scope.admitted.includes(s));
      if (sensitivity === undefined || !scope.admitted.includes(sensitivity)) return invalid('sensitivity must be one this conversation admits');
      const evidence = parseEvidenceRefs(input.evidenceRefs, { fallback: sensitivity, admitted: scope.admitted });
      if (!evidence.ok) return evidence;
      const nextReviewAt = input.nextReviewAt === null ? ok(null) : normalizeDueAt(input.nextReviewAt);
      if (!nextReviewAt.ok) return invalid('nextReviewAt must be an ISO 8601 timestamp');
      const existing = await visible(scope);
      if (!existing.ok) return existing;
      const duplicate = existing.value.find((c) => isOpenConcernStatus(c.status) && concernTextSimilarity(c.text, text) >= CONCERN_DUPLICATE_SIMILARITY);
      if (duplicate !== undefined) return conflict('already_exists', `an open concern already says this: ${duplicate.id}`);
      const formationVad = await deps.emotion.currentVad(scope);
      if (!formationVad.ok) return formationVad;
      const at = deps.clock.now().toISOString();
      const author = authorOf(scope);
      const concern: ActiveConcern = {
        id: deps.ids.next('concern'),
        text,
        status: 'active',
        priority: input.priority,
        sensitivity,
        owner: 'companion',
        author,
        formedIn: scope.audience,
        contactId: scope.audience.kind === 'direct' ? scope.audience.contactId : null,
        evidenceRefs: evidence.value,
        formationVad: formationVad.value,
        resolution: null,
        nextReviewAt: nextReviewAt.value,
        createdAt: at,
        updatedAt: at,
        revision: 1,
      };
      const event: ConcernEvent = {
        concernId: concern.id,
        revision: 1,
        kind: 'created',
        from: null,
        to: 'active',
        evidenceRefs: evidence.value,
        outcome: null,
        resolution: null,
        author,
        at,
      };
      return deps.concerns.create(concern, event);
    },

    async transition(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'concerns are companion-authored');
      const found = await visibleOne(scope, input.concernId);
      if (!found.ok) return found;
      const concern = found.value;
      if (concern.revision !== input.expectedRevision) {
        return conflict('stale_revision', `concern ${concern.id} moved`, { expectedRevision: input.expectedRevision, actualRevision: concern.revision });
      }
      const added = parseEvidenceRefs(input.evidenceRefs, { fallback: concern.sensitivity, admitted: scope.admitted });
      if (!added.ok) return added;
      const allowed = validateConcernTransition({ from: concern.status, to: input.to, existing: concern.evidenceRefs, added: added.value });
      if (!allowed.ok) return allowed;
      const outcome = input.outcome?.replace(/\s+/g, ' ').trim() ?? null;
      if (outcome !== null && (outcome.length === 0 || outcome.length > MAX_CONCERN_OUTCOME_CHARS)) return invalid(`outcome must be 1-${MAX_CONCERN_OUTCOME_CHARS} characters`);
      const nextReviewAt = input.nextReviewAt === null ? ok(concern.nextReviewAt) : normalizeDueAt(input.nextReviewAt);
      if (!nextReviewAt.ok) return invalid('nextReviewAt must be an ISO 8601 timestamp');

      const at = deps.clock.now().toISOString();
      let resolution: ConcernResolution | null = isTerminalConcernStatus(concern.status) ? concern.resolution : null;
      if (isTerminalConcernStatus(input.to)) {
        const resolutionVad = await deps.emotion.currentVad(scope);
        if (!resolutionVad.ok) return resolutionVad;
        const relief = input.to === 'resolved' && concern.formationVad !== null && resolutionVad.value !== null ? reliefDelta(concern.formationVad, resolutionVad.value) : null;
        const arc = describeConcernArc(concern.formationVad, resolutionVad.value);
        resolution = {
          generationId: deps.ids.next('concern_resolution'),
          status: input.to,
          outcome,
          evidenceRefs: added.value,
          resolutionVad: resolutionVad.value,
          reliefDelta: relief,
          arc: arc === null ? null : { text: arc, author: { kind: 'machine', producer: ARC_PRODUCER } },
          resolvedAt: at,
        };
      } else if (isTerminalConcernStatus(concern.status)) {
        // Reopened: the resolution stays in the event history, not on the live concern.
        resolution = null;
      }
      const next: ActiveConcern = {
        ...concern,
        status: input.to,
        evidenceRefs: mergeEvidence(concern.evidenceRefs, added.value),
        resolution,
        nextReviewAt: nextReviewAt.value,
        updatedAt: at,
        revision: concern.revision + 1,
      };
      const event: ConcernEvent = {
        concernId: concern.id,
        revision: next.revision,
        kind: 'transitioned',
        from: concern.status,
        to: input.to,
        evidenceRefs: added.value,
        outcome,
        resolution: isTerminalConcernStatus(input.to) ? resolution : null,
        author: authorOf(scope),
        at,
      };
      const updated = await deps.concerns.update(next, concern.revision, event);
      if (!updated.ok) return updated;
      const delta = isTerminalConcernStatus(input.to) ? resolution?.reliefDelta ?? null : null;
      if (delta === null || resolution === null) return ok({ concern: updated.value, relief: { status: 'not_captured' } });
      const applied = await deps.emotion.applyRelief(scope, { generationId: resolution.generationId, delta });
      return ok({ concern: updated.value, relief: applied.ok ? { status: applied.value } : { status: 'failed', error: applied.error } });
    },
  };
}

function untrusted() {
  return denied('unknown_authority', 'scope was not admitted by ingress');
}
