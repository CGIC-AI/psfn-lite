import type { ActivityLogPort, ArtifactRef } from '../activity/index.ts';
import {
  activityStatusForOutcome,
  canViewWorkerRun,
  isTerminalWorker,
  statusForOutcome,
  type WorkerEffectPort,
  type WorkerGrant,
  type WorkerOutcome,
  type WorkerPrincipal,
  type WorkerRun,
  type WorkerRunPort,
  type WorkerTrigger,
  workerActivityId,
} from '../automata/index.ts';
import {
  conflict,
  conversationKey,
  denied,
  invalid,
  notFound,
  ok,
  sameAudience,
  type Clock,
  type Result,
  type WorkerRunId,
} from '../shared/index.ts';
import { applyActivityUpdate, newActivity } from './activity.ts';
import { collectPaged } from './paging.ts';
import type { CurrentTurn } from './current-turn.ts';
import type { ToolDispatcher } from './dispatch.ts';
import { isTrustedTurnScope, deriveWorkerScope, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';
import { digest } from './turn-history.ts';
import { fencedCall } from './worker-effects.ts';
import type { WorkerHostPort, WorkerReport, WorkerSession, WorkerTurnGate } from './worker-session.ts';

const LABEL_MAX = 120;
const TASK_MAX = 4_000;
const SUMMARY_MAX = 8_000;
const ARTIFACTS_MAX = 50;
const SWEEP_BATCH = 50;
const ACTIVITY_SYNC_ATTEMPTS = 3;

export interface SpawnInput {
  /** Caller-chosen key; a retried spawn with the same key and request replays the same run. */
  readonly key: string;
  readonly label: string;
  readonly task: string;
  readonly grant: WorkerGrant;
  readonly trigger: WorkerTrigger;
}

export interface SweepReport {
  readonly requeued: readonly WorkerRunId[];
  /** Runs failed closed because an effect's outcome is unknown. */
  readonly blocked: readonly WorkerRunId[];
  readonly failed: readonly WorkerRunId[];
  readonly cancelled: readonly WorkerRunId[];
  /** Runs another pass moved first; left to it. */
  readonly contended: readonly WorkerRunId[];
}

export interface WorkerRunner {
  spawn(parent: TrustedTurnScope, input: SpawnInput): Promise<Result<{ readonly run: WorkerRun; readonly created: boolean }>>;
  /** Claims a queued run and hands the attempt to the host, under a worker scope derived from this freshly admitted parent. */
  drive(parent: TrustedTurnScope, runId: WorkerRunId): Promise<Result<WorkerRun>>;
  /**
   * Drives every queued run of the parent's conversation spawned for the same
   * principal (after a restart or recovery). The scheduler tick calls it for
   * companion-internal runs; the host calls it after admitting a participant
   * turn, so that conversation's requeued work continues. A run another pass
   * claimed first is skipped.
   */
  resume(parent: TrustedTurnScope): Promise<Result<readonly WorkerRun[]>>;
  /**
   * Recovers attempts whose lease expired. A started effect without an outcome
   * becomes `outcome_unknown` and blocks its run; a run with no ambiguous
   * effect returns to the queue until `maxAttempts`, then fails as
   * `lease_expired`. Nothing is re-executed here.
   */
  sweep(): Promise<Result<SweepReport>>;
  /**
   * Settles as failed (`not_resumed`) every queued run nothing drove within
   * `resumeGraceMs`, so no run waits forever for a conversation that never
   * comes back. The scheduler runs it after `resume`, so its own runs get
   * their chance first. Returns the runs it settled; one another pass moved
   * first is left alone.
   */
  settleUnresumed(): Promise<Result<readonly WorkerRunId[]>>;
  /**
   * Cancels a visible run. A queued run settles at once; a running one gets a
   * durable request the next turn gate honours, and the host is told.
   */
  cancel(scope: TrustedTurnScope, runId: WorkerRunId): Promise<Result<WorkerRun>>;
  /** A run this scope may see; another conversation's run reads as missing. */
  visible(scope: TrustedTurnScope, runId: WorkerRunId): Promise<Result<WorkerRun>>;
}

export interface WorkerRunnerDeps {
  readonly runs: WorkerRunPort;
  readonly effects: WorkerEffectPort;
  readonly activities: ActivityLogPort;
  readonly dispatcher: ToolDispatcher;
  readonly host: WorkerHostPort;
  readonly locate: (scope: TrustedTurnScope) => Promise<Result<CurrentTurn>>;
  readonly clock: Clock;
  /** This runner instance; a lease names it, and only it may act on the attempt. */
  readonly owner: string;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  /** How long a queued run may wait for its conversation to drive it before it settles as `not_resumed`. */
  readonly resumeGraceMs: number;
}

/**
 * The one lifecycle for bounded workers, whether the companion requested
 * them, a turn produced them or a schedule did (donor
 * `src/faculties/subagents/faculty.ts`, `task-registry.ts` and the
 * background-work recovery fences). Core owns the grant, scope, lifecycle,
 * effects and result; the host runs the model loop.
 */
export function createWorkerRunner(deps: WorkerRunnerDeps): Result<WorkerRunner> {
  const issues: string[] = [];
  if (!Number.isInteger(deps.leaseMs) || deps.leaseMs < 1) issues.push('leaseMs must be a positive integer');
  if (!Number.isInteger(deps.maxAttempts) || deps.maxAttempts < 1 || deps.maxAttempts > 10) issues.push('maxAttempts must be an integer from 1 to 10');
  if (!Number.isInteger(deps.resumeGraceMs) || deps.resumeGraceMs < 1) issues.push('resumeGraceMs must be a positive integer');
  if (deps.owner.trim().length === 0) issues.push('owner must be non-empty');
  if (issues.length > 0) return invalid(...issues);

  const now = () => deps.clock.now().toISOString();

  const visible = async (scope: TrustedTurnScope, runId: WorkerRunId): Promise<Result<WorkerRun>> => {
    if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
    const found = await deps.runs.get(runId);
    if (!found.ok) return found.error.kind === 'not_found' ? notFound(`worker run ${runId}`) : found;
    return canViewWorkerRun(viewerOf(scope), found.value) ? found : notFound(`worker run ${runId}`);
  };

  /**
   * Mirrors a settled run into its activity record once; a retry after a
   * partial failure completes it. A note landing between the read and the
   * write is re-read and the outcome applied over it, so a settled run never
   * leaves its activity in progress because of a lost race.
   */
  const syncActivity = async (run: WorkerRun): Promise<Result<WorkerRun>> => {
    const outcome = run.outcome;
    if (outcome === null) return ok(run);
    const author = { kind: 'machine', producer: `worker:${run.id}` } as const;
    for (let attempt = 1; ; attempt += 1) {
      const activity = await deps.activities.get(run.activityId);
      if (!activity.ok) return activity;
      if (activity.value.status !== 'in_progress') return ok(run);
      const next = applyActivityUpdate(
        activity.value,
        {
          expectedRevision: activity.value.revision,
          status: activityStatusForOutcome(outcome),
          outcome: run.result?.summary ?? `worker ${outcome}${run.reason === null ? '' : `: ${run.reason}`}`,
          artifacts: run.result?.artifacts ?? [],
        },
        author,
        now(),
      );
      if (!next.ok) return next;
      const updated = await deps.activities.update(next.value, activity.value.revision);
      if (updated.ok) return ok(run);
      const raced = updated.error.kind === 'conflict' && updated.error.reason === 'stale_revision';
      if (!raced || attempt >= ACTIVITY_SYNC_ATTEMPTS) return updated;
    }
  };

  const settle = async (
    run: WorkerRun,
    input: { readonly outcome: WorkerOutcome; readonly reason: string | null; readonly result: WorkerRun['result']; readonly usage?: WorkerReport['usage'] },
  ): Promise<Result<WorkerRun>> => {
    const at = now();
    const usage = input.usage ?? { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
    const updated = await deps.runs.update(
      {
        ...run,
        status: statusForOutcome(input.outcome),
        outcome: input.outcome,
        reason: input.reason,
        result: input.result,
        lease: null,
        accounting: {
          ...run.accounting,
          modelCalls: run.accounting.modelCalls + usage.modelCalls,
          inputTokens: run.accounting.inputTokens + usage.inputTokens,
          outputTokens: run.accounting.outputTokens + usage.outputTokens,
        },
        updatedAt: at,
        finishedAt: at,
        revision: run.revision + 1,
      },
      run.revision,
    );
    return updated.ok ? syncActivity(updated.value) : updated;
  };

  /** The run as it stands, only while `attempt` is its live attempt under this owner. */
  const live = async (runId: WorkerRunId, attempt: number): Promise<Result<WorkerRun>> => {
    const found = await deps.runs.get(runId);
    if (!found.ok) return found;
    const { lease, status } = found.value;
    if (status !== 'running' || lease === null || lease.owner !== deps.owner || lease.attempt !== attempt) {
      return conflict('turn_ownership', `attempt ${attempt} of worker run ${runId} is no longer current`);
    }
    if (Date.parse(lease.until) <= deps.clock.now().getTime()) return conflict('turn_ownership', `the lease of worker run ${runId} expired`);
    return found;
  };

  const sessionFor = (claimed: WorkerRun, scope: TrustedTurnScope, attempt: number): WorkerSession => ({
    run: claimed,
    scope,

    async beginTurn(): Promise<Result<WorkerTurnGate>> {
      const current = await live(claimed.id, attempt);
      if (!current.ok) return current;
      const run = current.value;
      if (run.cancelRequested) return ok({ kind: 'cancel_requested' });
      if (run.accounting.turnsUsed >= run.grant.maxTurns) return ok({ kind: 'budget_exhausted' });
      const updated = await deps.runs.update(
        {
          ...run,
          accounting: { ...run.accounting, turnsUsed: run.accounting.turnsUsed + 1 },
          lease: { owner: deps.owner, attempt, until: new Date(deps.clock.now().getTime() + deps.leaseMs).toISOString() },
          updatedAt: now(),
          revision: run.revision + 1,
        },
        run.revision,
      );
      if (!updated.ok) return updated;
      return ok({ kind: 'turn', turn: updated.value.accounting.turnsUsed, guidance: updated.value.guidance });
    },

    async call(effectKey, call) {
      const current = await live(claimed.id, attempt);
      if (!current.ok) return current;
      return fencedCall(deps, { run: current.value, attempt, scope, effectKey, call });
    },

    async finish(report) {
      const parsed = parseReport(report);
      if (!parsed.ok) return parsed;
      const found = await deps.runs.get(claimed.id);
      if (!found.ok) return found;
      const run = found.value;
      // A retry after the run settled replays it and completes any activity mirroring left undone.
      if (isTerminalWorker(run.status)) {
        return run.lease === null && run.outcome === report.outcome && run.result?.summary === parsed.value.summary
          ? syncActivity(run)
          : conflict('turn_already_settled', `worker run ${run.id} already settled as ${run.status}`);
      }
      const current = await live(claimed.id, attempt);
      if (!current.ok) return current;
      const effects = await deps.effects.list(run.id);
      if (!effects.ok) return effects;
      const ambiguous = effects.value.some((e) => e.phase === 'started' || e.phase === 'outcome_unknown');
      return settle(current.value, {
        outcome: ambiguous ? 'blocked' : report.outcome,
        reason: ambiguous ? 'effect_outcome_unknown' : report.reason,
        result: { summary: parsed.value.summary, artifacts: parsed.value.artifacts, author: { kind: 'machine', producer: `worker:${run.id}` } },
        usage: report.usage,
      });
    },
  });

  const drive = async (parent: TrustedTurnScope, runId: WorkerRunId): Promise<Result<WorkerRun>> => {
    const found = await visible(parent, runId);
    if (!found.ok) return found;
    const run = found.value;
    if (!sameAudience(parent.audience, run.source.audience) || !samePrincipal(principalOf(parent), run.source.principal)) {
      return denied('unknown_authority', `worker run ${runId} is driven only under its own conversation's principal`);
    }
    if (run.status === 'running') return conflict('turn_lease_active', `worker run ${runId} is already running`);
    if (run.status !== 'queued') return ok(run);
    if (run.cancelRequested) return settle(run, { outcome: 'cancelled', reason: 'cancelled_before_start', result: null });
    const scope = deriveWorkerScope(parent, run.id, run.grant);
    if (!scope.ok) return scope;
    const attempt = run.attempts + 1;
    const claimed = await deps.runs.update(
      {
        ...run,
        status: 'running',
        attempts: attempt,
        lease: { owner: deps.owner, attempt, until: new Date(deps.clock.now().getTime() + deps.leaseMs).toISOString() },
        updatedAt: now(),
        revision: run.revision + 1,
      },
      run.revision,
    );
    if (!claimed.ok) return claimed;
    const started = await deps.host.start(sessionFor(claimed.value, scope.value, attempt));
    if (started.ok) return deps.runs.get(run.id);
    // The host never took the attempt, so nothing ran: release it to the queue as it was.
    const released = await deps.runs.update(
      { ...claimed.value, status: 'queued', attempts: run.attempts, lease: null, updatedAt: now(), revision: claimed.value.revision + 1 },
      claimed.value.revision,
    );
    return released.ok ? started : released;
  };

  return ok({
    async spawn(parent, input) {
      if (!isTrustedTurnScope(parent)) return denied('unknown_authority', 'scope was not admitted by ingress');
      if (parent.caller.kind === 'worker') return denied('worker_not_permitted', 'workers cannot spawn workers');
      const label = input.label.trim();
      const task = input.task.trim();
      if (label.length === 0 || label.length > LABEL_MAX) return invalid(`label must be 1-${LABEL_MAX} characters`);
      if (task.length === 0 || task.length > TASK_MAX) return invalid(`task must be 1-${TASK_MAX} characters`);
      // Keys are namespaced by conversation, so another room can neither collide with nor probe them.
      const hash = digest({ conversation: conversationKey(parent.audience), key: input.key }).slice(0, 40);
      const runId = `worker_run:${hash}` as WorkerRunId;
      const grant = deriveWorkerScope(parent, runId, input.grant);
      if (!grant.ok) return grant;
      const principal = principalOf(parent);
      const requestDigest = digest({ label, task, grant: input.grant, trigger: input.trigger, principal, audience: parent.audience });

      const existing = await deps.runs.get(runId);
      if (existing.ok) return replaySpawn(existing.value, requestDigest);
      if (existing.error.kind !== 'not_found') return existing;

      const turn = await deps.locate(parent);
      if (!turn.ok) return turn;
      const at = now();
      const activityId = workerActivityId(runId);
      const activity = newActivity({
        id: activityId,
        purpose: `Worker: ${label}`,
        visibility: parent.audience,
        sessionId: turn.value.sessionId,
        turnId: turn.value.turnId,
        workerRunId: runId,
        at,
      });
      if (!activity.ok) return activity;
      const inserted = await deps.activities.insert(activity.value);
      if (!inserted.ok && !(inserted.error.kind === 'conflict' && inserted.error.reason === 'already_exists')) return inserted;

      const run: WorkerRun = {
        id: runId,
        spawnKey: `wk:${hash}`,
        requestDigest,
        label,
        task,
        status: 'queued',
        outcome: null,
        reason: null,
        grant: grant.value.caller.kind === 'worker' ? grant.value.caller.grant : input.grant,
        source: { audience: parent.audience, sessionId: turn.value.sessionId, turnId: turn.value.turnId, principal, trigger: input.trigger },
        activityId,
        lease: null,
        attempts: 0,
        maxAttempts: deps.maxAttempts,
        cancelRequested: false,
        guidance: [],
        accounting: { turnsUsed: 0, toolCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 },
        result: null,
        createdAt: at,
        updatedAt: at,
        finishedAt: null,
        revision: 1,
      };
      const created = await deps.runs.insert(run);
      if (created.ok) return ok({ run: created.value, created: true });
      if (created.error.kind !== 'conflict' || created.error.reason !== 'already_exists') return created;
      const winner = await deps.runs.get(runId);
      return winner.ok ? replaySpawn(winner.value, requestDigest) : winner;
    },

    drive,

    async resume(parent) {
      if (!isTrustedTurnScope(parent)) return denied('unknown_authority', 'scope was not admitted by ingress');
      const principal = principalOf(parent);
      const queued = await collectPaged({
        fetch: (after, pageSize) => deps.runs.list({ statuses: ['queued'], limit: pageSize, after }),
        cursorOf: (r: WorkerRun) => ({ createdAt: r.createdAt, id: r.id }),
        keep: (r) => sameAudience(r.source.audience, parent.audience) && samePrincipal(r.source.principal, principal),
        limit: Number.POSITIVE_INFINITY,
      });
      if (!queued.ok) return queued;
      const driven: WorkerRun[] = [];
      // Oldest first, so work resumes in the order it was asked for.
      for (const run of queued.value.reverse()) {
        const result = await drive(parent, run.id);
        if (lostRace(result)) continue;
        if (!result.ok) return result;
        driven.push(result.value);
      }
      return ok(driven);
    },

    async sweep() {
      const report = {
        requeued: [] as WorkerRunId[],
        blocked: [] as WorkerRunId[],
        failed: [] as WorkerRunId[],
        cancelled: [] as WorkerRunId[],
        contended: [] as WorkerRunId[],
      };
      /** Settles or requeues one run; a lost race leaves it to the pass that moved it. */
      const record = (result: Result<WorkerRun>, run: WorkerRun, into: WorkerRunId[]): Result<void> => {
        if (lostRace(result)) report.contended.push(run.id);
        else if (!result.ok) return result;
        else into.push(run.id);
        return ok(undefined);
      };
      const expired = await deps.runs.expired(now(), SWEEP_BATCH);
      if (!expired.ok) return expired;
      for (const run of expired.value) {
        const effects = await deps.effects.list(run.id);
        if (!effects.ok) return effects;
        let unknown = false;
        for (const effect of effects.value) {
          if (effect.phase === 'outcome_unknown') unknown = true;
          if (effect.phase !== 'started') continue;
          const marked = await deps.effects.settle({ ...effect, phase: 'outcome_unknown', settledAt: now() });
          if (!marked.ok) return marked;
          unknown = true;
        }
        const outcome = unknown
          ? record(await settle(run, { outcome: 'blocked', reason: 'effect_outcome_unknown', result: null }), run, report.blocked)
          : run.cancelRequested
            ? record(await settle(run, { outcome: 'cancelled', reason: 'cancelled_lease_expired', result: null }), run, report.cancelled)
            : run.attempts >= run.maxAttempts
              ? record(await settle(run, { outcome: 'failed', reason: 'lease_expired', result: null }), run, report.failed)
              : record(
                  await deps.runs.update(
                    { ...run, status: 'queued', lease: null, reason: 'lease_expired_requeued', updatedAt: now(), revision: run.revision + 1 },
                    run.revision,
                  ),
                  run,
                  report.requeued,
                );
        if (!outcome.ok) return outcome;
      }
      return ok(report);
    },

    async settleUnresumed() {
      // Queued work nothing drove: its conversation never resumed it within the grace window.
      const cutoff = deps.clock.now().getTime() - deps.resumeGraceMs;
      const abandoned = await collectPaged({
        fetch: (after, pageSize) => deps.runs.list({ statuses: ['queued'], limit: pageSize, after }),
        cursorOf: (r: WorkerRun) => ({ createdAt: r.createdAt, id: r.id }),
        keep: (r) => Date.parse(r.updatedAt) <= cutoff,
        limit: SWEEP_BATCH,
      });
      if (!abandoned.ok) return abandoned;
      const settled: WorkerRunId[] = [];
      for (const run of abandoned.value) {
        const result = await settle(run, { outcome: 'failed', reason: 'not_resumed', result: null });
        if (lostRace(result)) continue;
        if (!result.ok) return result;
        settled.push(run.id);
      }
      return ok(settled);
    },

    async cancel(scope, runId) {
      const found = await visible(scope, runId);
      if (!found.ok) return found;
      const run = found.value;
      if (isTerminalWorker(run.status) || run.cancelRequested) return ok(run);
      const requested = await deps.runs.update({ ...run, cancelRequested: true, updatedAt: now(), revision: run.revision + 1 }, run.revision);
      if (!requested.ok) return requested;
      if (run.status === 'queued') return settle(requested.value, { outcome: 'cancelled', reason: 'cancelled_before_start', result: null });
      // The durable request stands even if the host cannot be told now: the next turn gate refuses to continue.
      const told = await deps.host.cancel(run.id);
      return told.ok ? requested : told;
    },

    visible,
  });
}

export function principalOf(scope: TrustedTurnScope): WorkerPrincipal {
  const caller = scope.caller.kind === 'worker' ? scope.caller.parent : scope.caller;
  return caller.kind === 'participant' ? { kind: 'participant', contactId: caller.contactId } : { kind: 'companion_internal' };
}

/** A compare-and-set lost to another pass, or a run another pass already holds. */
function lostRace(result: Result<unknown>): boolean {
  return !result.ok && result.error.kind === 'conflict' && (result.error.reason === 'stale_revision' || result.error.reason === 'turn_lease_active');
}

export function samePrincipal(a: WorkerPrincipal, b: WorkerPrincipal): boolean {
  if (a.kind === 'participant' && b.kind === 'participant') return a.contactId === b.contactId;
  return a.kind === b.kind;
}

function replaySpawn(run: WorkerRun, requestDigest: string): Result<{ readonly run: WorkerRun; readonly created: boolean }> {
  return run.requestDigest === requestDigest
    ? ok({ run, created: false })
    : conflict('idempotency_mismatch', 'this spawn key was already used for a different worker');
}

function parseReport(report: WorkerReport): Result<{ readonly summary: string; readonly artifacts: readonly ArtifactRef[] }> {
  const issues: string[] = [];
  if (!['completed', 'blocked', 'cancelled', 'budget_limited'].includes(report.outcome)) issues.push('report outcome is not a worker outcome');
  const summary = report.summary.trim();
  if (summary.length === 0 || summary.length > SUMMARY_MAX) issues.push(`summary must be 1-${SUMMARY_MAX} characters`);
  if (report.artifacts.length > ARTIFACTS_MAX) issues.push(`at most ${ARTIFACTS_MAX} artifacts`);
  for (const a of report.artifacts) if (a.kind.trim().length === 0 || a.ref.trim().length === 0) issues.push('artifacts need a kind and a ref');
  const usage = [report.usage.modelCalls, report.usage.inputTokens, report.usage.outputTokens];
  if (!usage.every((n) => Number.isInteger(n) && n >= 0)) issues.push('usage must be non-negative integers');
  return issues.length > 0 ? invalid(...issues) : ok({ summary, artifacts: report.artifacts });
}
