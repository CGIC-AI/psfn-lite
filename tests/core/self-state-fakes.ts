/**
 * Test-only in-memory fakes of the self-state ports. They implement the
 * documented compare-and-set and idempotency contracts so behavior tests
 * exercise the real failure paths, and the estimator counts every call.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  conflict,
  invalid,
  notFound,
  ok,
  OPEN_CONCERN_STATUSES,
  type ActiveConcern,
  type AffectEstimatorPort,
  type AffectObservation,
  type AppraisalEntry,
  type AppraisalLogPort,
  type AuthoredReflection,
  type AuthoredReflectionPort,
  type ConcernEvent,
  type ConcernListQuery,
  type ConcernPort,
  type EmotionObservationRecord,
  type EmotionSelfReport,
  type EmotionStatePort,
  type EmotionStateRecord,
  type FollowUpListQuery,
  type FollowUpPort,
  type PendingFollowUp,
  type Result,
  type SelfReportPort,
} from '../../packages/core/src/index.ts';

const done = <T>(value: T): Promise<T> => Promise.resolve(value);

export class FakeEmotionStates implements EmotionStatePort {
  readonly states = new Map<string, EmotionStateRecord>();
  readonly observations = new Map<string, EmotionObservationRecord>();

  get(key: string) {
    return done(ok(this.states.get(key) ?? null));
  }
  observation(id: string) {
    return done(ok(this.observations.get(id) ?? null));
  }
  commit(input: { next: EmotionStateRecord; expectedRevision: number; observation: EmotionObservationRecord | null }): Promise<Result<EmotionStateRecord>> {
    const actual = this.states.get(input.next.key)?.revision ?? 0;
    if (input.next.revision !== input.expectedRevision + 1) return done(invalid('revision must follow'));
    if (actual !== input.expectedRevision) return done(conflict('stale_revision', 'moved', { expectedRevision: input.expectedRevision, actualRevision: actual }));
    if (input.observation !== null && this.observations.has(input.observation.id)) return done(conflict('already_exists', 'observed'));
    this.states.set(input.next.key, input.next);
    if (input.observation !== null) this.observations.set(input.observation.id, input.observation);
    return done(ok(input.next));
  }
}

export class FakeAppraisals implements AppraisalLogPort {
  readonly entries: AppraisalEntry[] = [];
  append(entry: AppraisalEntry): Promise<Result<AppraisalEntry>> {
    const existing = this.entries.find((e) => e.id === entry.id);
    if (existing !== undefined) return done(isDeepStrictEqual(existing, entry) ? ok(existing) : conflict('entry_mismatch', 'different appraisal'));
    this.entries.push(entry);
    return done(ok(entry));
  }
  get(id: string) {
    return done(ok(this.entries.find((e) => e.id === id) ?? null));
  }
  recent(query: { limit: number; before: string | null }): Promise<Result<readonly AppraisalEntry[]>> {
    const newest = [...this.entries].reverse();
    if (query.before === null) return done(ok(newest.slice(0, query.limit)));
    const at = newest.findIndex((e) => e.id === query.before);
    return done(at < 0 ? notFound(`appraisal ${query.before}`) : ok(newest.slice(at + 1, at + 1 + query.limit)));
  }
}

export class FakeSelfReports implements SelfReportPort {
  readonly reports: EmotionSelfReport[] = [];
  append(report: EmotionSelfReport): Promise<Result<EmotionSelfReport>> {
    if (this.reports.some((r) => r.id === report.id)) return done(conflict('already_exists', 'report exists'));
    this.reports.push(report);
    return done(ok(report));
  }
  get(id: string): Promise<Result<EmotionSelfReport>> {
    const found = this.reports.find((r) => r.id === id);
    return done(found === undefined ? notFound(`self-report ${id}`) : ok(found));
  }
  recent(scopeKey: string, limit: number) {
    return done(ok(this.reports.filter((r) => r.scopeKey === scopeKey).reverse().slice(0, limit)));
  }
}

export class FakeConcerns implements ConcernPort {
  readonly concerns = new Map<string, ActiveConcern>();
  readonly eventLog: ConcernEvent[] = [];
  get(id: string): Promise<Result<ActiveConcern>> {
    const found = this.concerns.get(id);
    return done(found === undefined ? notFound(`concern ${id}`) : ok(found));
  }
  list(query: ConcernListQuery) {
    // Most recent first: (updatedAt, id) descending, strictly after the cursor.
    const order = (a: { updatedAt: string; id: string }, b: { updatedAt: string; id: string }) =>
      a.updatedAt === b.updatedAt ? b.id.localeCompare(a.id) : b.updatedAt.localeCompare(a.updatedAt);
    const after = query.after;
    const rows = [...this.concerns.values()]
      .filter((c) => !query.openOnly || OPEN_CONCERN_STATUSES.includes(c.status))
      .filter((c) => after === null || order(after, c) < 0)
      .sort(order);
    return done(ok(rows.slice(0, query.limit)));
  }
  create(concern: ActiveConcern, event: ConcernEvent): Promise<Result<ActiveConcern>> {
    if (this.concerns.has(concern.id)) return done(conflict('already_exists', 'concern exists'));
    this.concerns.set(concern.id, concern);
    this.eventLog.push(event);
    return done(ok(concern));
  }
  update(next: ActiveConcern, expectedRevision: number, event: ConcernEvent): Promise<Result<ActiveConcern>> {
    const actual = this.concerns.get(next.id)?.revision;
    if (actual === undefined) return done(notFound(`concern ${next.id}`));
    if (actual !== expectedRevision) return done(conflict('stale_revision', 'moved', { expectedRevision, actualRevision: actual }));
    this.concerns.set(next.id, next);
    this.eventLog.push(event);
    return done(ok(next));
  }
  events(id: string, limit: number) {
    return done(ok(this.eventLog.filter((e) => e.concernId === id).slice(0, limit)));
  }
}

export class FakeFollowUps implements FollowUpPort {
  readonly followUps = new Map<string, PendingFollowUp>();
  create(followUp: PendingFollowUp) {
    const existing = this.followUps.get(followUp.id);
    if (existing !== undefined) return done(ok({ followUp: existing, created: false }));
    this.followUps.set(followUp.id, followUp);
    return done(ok({ followUp, created: true }));
  }
  get(id: string): Promise<Result<PendingFollowUp>> {
    const found = this.followUps.get(id);
    return done(found === undefined ? notFound(`follow-up ${id}`) : ok(found));
  }
  list(query: FollowUpListQuery) {
    // Earliest due first: (dueAt, id) ascending, strictly after the cursor.
    const order = (a: { dueAt: string; id: string }, b: { dueAt: string; id: string }) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id);
    const { after, dueAtOrBefore } = query;
    const rows = [...this.followUps.values()]
      .filter((f) => query.state === null || f.state === query.state)
      .filter((f) => dueAtOrBefore === null || Date.parse(f.dueAt) <= Date.parse(dueAtOrBefore))
      .filter((f) => after === null || order(after, f) < 0)
      .sort(order);
    return done(ok(rows.slice(0, query.limit)));
  }
  update(next: PendingFollowUp, expectedRevision: number): Promise<Result<PendingFollowUp>> {
    const actual = this.followUps.get(next.id)?.revision;
    if (actual === undefined) return done(notFound(`follow-up ${next.id}`));
    if (actual !== expectedRevision) return done(conflict('stale_revision', 'moved'));
    this.followUps.set(next.id, next);
    return done(ok(next));
  }
}

/** Deterministic estimator: returns `reading` (set by the test) and records every request. */
export class FakeEstimator implements AffectEstimatorPort {
  readonly calls: Parameters<AffectEstimatorPort['estimate']>[0][] = [];
  reading: AffectObservation = steady();
  estimate(request: Parameters<AffectEstimatorPort['estimate']>[0]) {
    this.calls.push(request);
    return done(ok(this.reading));
  }
}

export class FakeReflections implements AuthoredReflectionPort {
  readonly reflections: AuthoredReflection[] = [];
  recent(limit: number) {
    return done(ok([...this.reflections].reverse().slice(0, limit)));
  }
}

export function steady(confidence = 0.9): AffectObservation {
  return { vad: { valence: 0, arousal: 0, dominance: 0 }, discrete: {}, confidence, producer: 'fake-estimator' };
}

export function reading(valence: number, arousal: number, dominance: number, confidence = 0.9, discrete: Record<string, number> = {}): AffectObservation {
  return { vad: { valence, arousal, dominance }, discrete, confidence, producer: 'fake-estimator' };
}
