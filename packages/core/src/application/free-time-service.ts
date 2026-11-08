import type { ActivityLogPort, ActivityRecord } from '../activity/index.ts';
import {
  FREE_TIME_LANES,
  evaluateFreeTimeGate,
  isOpen,
  localDay,
  type FreeTimeBlock,
  type FreeTimeBlockPort,
  type FreeTimeGate,
  type FreeTimeLane,
  type FreeTimePolicy,
  type RestDecision,
  type RestStatePort,
} from '../scheduler/index.ts';
import type { SessionCatalogPort, SessionRecord } from '../sessions/index.ts';
import {
  conflict,
  denied,
  invalid,
  notFound,
  ok,
  type ActivityId,
  type Clock,
  type IdSource,
  type Result,
} from '../shared/index.ts';
import { applyActivityUpdate, newActivity } from './activity.ts';
import type { CurrentTurn } from './current-turn.ts';
import type { InternalTurnPort, InternalTurnResult } from './host-ports.ts';
import type { JournalService } from './journal-service.ts';
import { collectPaged } from './paging.ts';
import { authorOf, isTrustedTurnScope, type TrustedTurnScope } from './trusted-scope.ts';

const MINUTE_MS = 60_000;
const RECENT_BLOCKS = 5;

export interface FreeTimeLaneStatus {
  readonly lane: FreeTimeLane;
  /** The quiet decision in force, labelled by who made it; a system failure is never shown as the companion's choice. */
  readonly rest: { readonly decision: RestDecision; readonly madeBy: 'companion' | 'system_failure'; readonly active: boolean } | null;
  readonly restUnavailable: boolean;
  readonly gate: FreeTimeGate;
  readonly recent: readonly FreeTimeBlock[];
}

export type FreeTimeRunReport =
  | { readonly lane: FreeTimeLane; readonly kind: 'skipped'; readonly reason: Extract<FreeTimeGate, { kind: 'ineligible' }>['reason'] }
  | { readonly lane: FreeTimeLane; readonly kind: 'ran'; readonly block: FreeTimeBlock };

export interface FreeTimeService {
  status(scope: TrustedTurnScope): Promise<Result<readonly FreeTimeLaneStatus[]>>;
  choose(scope: TrustedTurnScope, input: { readonly blockId: string; readonly optionId: string }): Promise<Result<{ readonly block: FreeTimeBlock; readonly activity: ActivityRecord | null }>>;
  rest(
    scope: TrustedTurnScope,
    input: { readonly blockId: string | null; readonly lane: FreeTimeLane | null; readonly minutes: number | null },
  ): Promise<Result<{ readonly decisions: readonly { readonly lane: FreeTimeLane; readonly decision: RestDecision }[] }>>;
  defer(
    scope: TrustedTurnScope,
    input: { readonly blockId: string | null; readonly lane: FreeTimeLane | null; readonly minutes: number },
  ): Promise<Result<{ readonly decisions: readonly { readonly lane: FreeTimeLane; readonly decision: RestDecision }[] }>>;
  /**
   * One scheduler pass over a lane: the deterministic gate (no inference),
   * then at most one invitation turn, then the chosen activity's turn.
   */
  runLane(scope: TrustedTurnScope, lane: FreeTimeLane): Promise<Result<FreeTimeRunReport>>;
}

export interface FreeTimeDeps {
  readonly blocks: FreeTimeBlockPort;
  readonly rest: RestStatePort;
  readonly activities: ActivityLogPort;
  readonly catalog: SessionCatalogPort;
  readonly locate: (scope: TrustedTurnScope) => Promise<Result<CurrentTurn>>;
  readonly turns: InternalTurnPort;
  readonly journal: JournalService;
  readonly policy: FreeTimePolicy;
  readonly clock: Clock;
  readonly ids: IdSource;
}

/**
 * Free time (donor `src/core/scheduler/free-time.ts`,
 * `free-time-chooser.ts`, `rest-window-policy.ts`). A cheap gate decides
 * whether to invite; the invitation is recorded before the companion is
 * asked; the companion chooses an offered option, rests or defers through
 * its own tools; the chosen activity runs in the companion's own turn.
 * Rest and deferral are durable and extend-only. A failure is recorded as a
 * system failure, and an unanswered invitation lapses: neither is ever turned
 * into a decision the companion did not make.
 */
export function createFreeTimeService(deps: FreeTimeDeps): FreeTimeService {
  const nowMs = () => deps.clock.now().getTime();
  const iso = (ms: number) => new Date(ms).toISOString();

  const requireSelf = (scope: TrustedTurnScope): Result<void> => {
    if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
    if (scope.audience.kind !== 'self' || scope.caller.kind !== 'companion_internal') {
      return denied('requires_self_audience', 'free time runs only in companion-internal turns');
    }
    return ok(undefined);
  };

  const partnerActiveAt = async (): Promise<Result<number | null>> => {
    const found = await collectPaged({
      fetch: (after, pageSize) => deps.catalog.list(pageSize, after),
      cursorOf: (s: SessionRecord) => ({ lastActivityAt: s.lastActivityAt, sessionId: s.sessionId }),
      keep: (s) => s.audience.kind !== 'self',
      limit: 1,
    });
    if (!found.ok) return found;
    const latest = found.value[0];
    return ok(latest === undefined ? null : Date.parse(latest.lastActivityAt));
  };

  const resumable = () =>
    collectPaged({
      fetch: (after, pageSize) => deps.activities.list(pageSize, after),
      cursorOf: (r: ActivityRecord) => ({ startedAt: r.startedAt, id: r.id }),
      keep: (r) => r.visibility.kind === 'self' && r.status === 'interrupted',
      limit: deps.policy.maxResumeOptions,
    });

  const gateFor = async (lane: FreeTimeLane, recent: readonly FreeTimeBlock[]): Promise<Result<{ readonly gate: FreeTimeGate; readonly rest: RestDecision | null | 'unavailable' }>> => {
    const rest = await deps.rest.read(lane);
    const restInput = rest.ok ? rest.value : 'unavailable';
    const partner = await partnerActiveAt();
    if (!partner.ok) return partner;
    const resume = await resumable();
    if (!resume.ok) return resume;
    const at = nowMs();
    const today = localDay(at, deps.policy.timeZone);
    const gate = evaluateFreeTimeGate({
      lane,
      nowMs: at,
      policy: deps.policy,
      rest: restInput,
      latest: recent[0] ?? null,
      blocksToday: recent.filter((b) => b.localDay === today).length,
      partnerActiveAtMs: partner.value,
      resumable: resume.value.map((r) => ({ activityId: r.id, purpose: r.purpose })),
    });
    return ok({ gate, rest: restInput });
  };

  const recentBlocks = (lane: FreeTimeLane) => deps.blocks.recent(lane, Math.max(RECENT_BLOCKS, deps.policy.maxBlocksPerDay + 1));

  /** Blocks of every lane, newest first: the interval, the daily cap and an open invitation are shared, so two lanes never invite back to back. */
  const recentAcrossLanes = async (): Promise<Result<readonly FreeTimeBlock[]>> => {
    const all: FreeTimeBlock[] = [];
    for (const lane of FREE_TIME_LANES) {
      const recent = await recentBlocks(lane);
      if (!recent.ok) return recent;
      all.push(...recent.value);
    }
    return ok(all.sort((a, b) => (a.invitedAt < b.invitedAt ? 1 : a.invitedAt > b.invitedAt ? -1 : a.id < b.id ? 1 : -1)));
  };

  const updateBlock = (block: FreeTimeBlock, changes: Partial<FreeTimeBlock>) =>
    deps.blocks.update({ ...block, ...changes, revision: block.revision + 1 }, block.revision);

  /** Closes a block a crash or timeout left open, without inventing what the companion decided. */
  const closeStale = async (block: FreeTimeBlock | undefined): Promise<Result<void>> => {
    if (block === undefined || isOpen(block, nowMs(), deps.policy)) return ok(undefined);
    if (block.state === 'invited') {
      const lapsed = await updateBlock(block, { state: 'lapsed', outcome: 'no choice was made before the invitation lapsed' });
      return lapsed.ok ? ok(undefined) : lapsed;
    }
    if (block.state === 'chosen' || block.state === 'executing') {
      const closed = await settleActivity(block.activityId, { status: 'interrupted', outcome: 'free-time block was cut off before it finished' }, null);
      if (!closed.ok) return closed;
      const interrupted = await updateBlock(block, { state: 'interrupted', failure: 'block was cut off before it finished; not re-run' });
      return interrupted.ok ? ok(undefined) : interrupted;
    }
    return ok(undefined);
  };

  const settleActivity = async (
    activityId: ActivityId | null,
    input: { readonly status: 'completed' | 'interrupted' | 'failed'; readonly outcome: string; readonly artifacts?: ActivityRecord['artifacts'] },
    note: { readonly scope: TrustedTurnScope; readonly text: string } | null,
  ): Promise<Result<void>> => {
    if (activityId === null) return ok(undefined);
    const found = await deps.activities.get(activityId);
    if (!found.ok) return found;
    if (found.value.status !== 'in_progress') return ok(undefined);
    const next = applyActivityUpdate(
      found.value,
      {
        expectedRevision: found.value.revision,
        status: input.status,
        outcome: input.outcome,
        ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
        ...(note === null ? {} : { note: note.text.slice(0, 4_000) }),
      },
      note === null ? { kind: 'system', source: 'free_time' } : authorOf(note.scope),
      iso(nowMs()),
    );
    if (!next.ok) return next;
    const updated = await deps.activities.update(next.value, found.value.revision);
    return updated.ok ? ok(undefined) : updated;
  };

  const recordQuiet = async (
    input: { readonly blockId: string | null; readonly lane: FreeTimeLane | null; readonly minutes: number },
    kind: 'companion_rested' | 'companion_deferred',
  ) => {
    const block = input.blockId === null ? null : await deps.blocks.get(input.blockId);
    if (block !== null && !block.ok) return block.error.kind === 'not_found' ? notFound(`free-time block ${input.blockId ?? ''}`) : block;
    if (block !== null && input.lane !== null && block.value.lane !== input.lane) return invalid('lane does not match the block');
    // A decline quiets every lane unless the companion named one: the next lane must not ask again an hour later.
    const lanes: readonly FreeTimeLane[] = input.lane !== null ? [input.lane] : FREE_TIME_LANES;
    const at = nowMs();
    const decision: RestDecision = { kind, until: iso(at + input.minutes * MINUTE_MS), decidedAt: iso(at) };
    const decisions: { lane: FreeTimeLane; decision: RestDecision }[] = [];
    // Rest is recorded before the block moves, so a failure part-way still leaves the lane quiet.
    for (const lane of lanes) {
      const extended = await deps.rest.extend(lane, decision);
      if (!extended.ok) return extended;
      decisions.push({ lane, decision: extended.value });
    }
    if (block !== null && block.value.state === 'invited') {
      const moved = await updateBlock(block.value, {
        state: kind === 'companion_rested' ? 'rested' : 'deferred',
        decidedAt: iso(at),
        choice: kind === 'companion_rested' ? (block.value.options.find((o) => o.kind === 'rest') ?? null) : null,
      });
      if (!moved.ok) return moved;
    }
    return ok({ decisions });
  };

  const execute = async (scope: TrustedTurnScope, chosen: FreeTimeBlock): Promise<Result<FreeTimeBlock>> => {
    const executing = await updateBlock(chosen, { state: 'executing' });
    if (!executing.ok) return executing;
    const choice = chosen.choice;
    if (choice === null) return invalid('a chosen block has a choice');
    const ran = await deps.turns.run({
      scope,
      purpose: 'free_time',
      prompt: activityPrompt(chosen, choice.label, choice.kind),
      reference: { kind: 'free_time_block', id: chosen.id },
    });
    const result: InternalTurnResult = ran.ok ? ran.value : { status: 'failed', reply: null };
    const artifacts: { kind: string; ref: string }[] = [];
    if (choice.kind === 'resume_project' && choice.activityId !== null) artifacts.push({ kind: 'resumes_activity', ref: choice.activityId });
    const reply = result.reply?.trim() ?? '';
    if (result.status === 'completed' && choice.kind === 'reflect' && reply.length > 0) {
      const reflection = await deps.journal.recordReflection(scope, {
        reflectionId: `free_time:${chosen.id}`,
        templateId: 'free_time',
        kind: 'companion_reflection',
        text: reply,
      });
      if (!reflection.ok) return reflection;
      artifacts.push({ kind: 'reflection', ref: reflection.value.id });
    }
    const status = result.status;
    const failure = ran.ok ? (status === 'completed' ? null : `free-time turn ${status}`) : `free-time turn could not run: ${ran.error.kind}`;
    const settled = await settleActivity(
      executing.value.activityId,
      { status, outcome: failure ?? `${choice.label}: done`, artifacts },
      reply.length > 0 ? { scope, text: reply } : null,
    );
    if (!settled.ok) return settled;
    return updateBlock(executing.value, {
      state: status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed',
      outcome: status === 'completed' ? `${choice.label}: done` : null,
      failure,
    });
  };

  return {
    async status(scope) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      const lanes: FreeTimeLaneStatus[] = [];
      const shared = await recentAcrossLanes();
      if (!shared.ok) return shared;
      for (const lane of FREE_TIME_LANES) {
        const recent = await recentBlocks(lane);
        if (!recent.ok) return recent;
        const evaluated = await gateFor(lane, shared.value);
        if (!evaluated.ok) return evaluated;
        const { rest, gate } = evaluated.value;
        lanes.push({
          lane,
          rest:
            rest === null || rest === 'unavailable'
              ? null
              : { decision: rest, madeBy: rest.kind === 'system_failure' ? 'system_failure' : 'companion', active: Date.parse(rest.until) > nowMs() },
          restUnavailable: rest === 'unavailable',
          gate,
          recent: recent.value.slice(0, RECENT_BLOCKS),
        });
      }
      return ok(lanes);
    },

    async choose(scope, input) {
      const self = requireSelf(scope);
      if (!self.ok) return self;
      const found = await deps.blocks.get(input.blockId);
      if (!found.ok) return found.error.kind === 'not_found' ? notFound(`free-time block ${input.blockId}`) : found;
      const block = found.value;
      if (block.state !== 'invited') {
        if (block.choice?.optionId === input.optionId && block.state !== 'lapsed') {
          const activity = block.activityId === null ? null : await deps.activities.get(block.activityId);
          if (activity !== null && !activity.ok) return activity;
          return ok({ block, activity: activity?.value ?? null });
        }
        return conflict('turn_already_settled', `free-time block ${block.id} is already ${block.state}`);
      }
      if (!isOpen(block, nowMs(), deps.policy)) return invalid(`free-time block ${block.id} has lapsed`);
      const option = block.options.find((o) => o.optionId === input.optionId);
      if (option === undefined) return invalid(`${input.optionId} is not one of the offered options`);
      if (option.kind === 'rest') {
        const rested = await recordQuiet({ blockId: block.id, lane: null, minutes: deps.policy.restMinutes }, 'companion_rested');
        if (!rested.ok) return rested;
        const after = await deps.blocks.get(block.id);
        return after.ok ? ok({ block: after.value, activity: null }) : after;
      }
      const turn = await deps.locate(scope);
      if (!turn.ok) return turn;
      const at = iso(nowMs());
      const activity = newActivity({
        id: `activity:${block.id}` as ActivityId,
        purpose: `Free time: ${option.label}`,
        visibility: scope.audience,
        sessionId: turn.value.sessionId,
        turnId: turn.value.turnId,
        workerRunId: null,
        at,
      });
      if (!activity.ok) return activity;
      const inserted = await deps.activities.insert(activity.value);
      if (!inserted.ok && !(inserted.error.kind === 'conflict' && inserted.error.reason === 'already_exists')) return inserted;
      const chosen = await updateBlock(block, { state: 'chosen', choice: option, activityId: activity.value.id, decidedAt: at });
      if (!chosen.ok) return chosen;
      const stored = await deps.activities.get(activity.value.id);
      return stored.ok ? ok({ block: chosen.value, activity: stored.value }) : stored;
    },

    async rest(scope, input) {
      const self = requireSelf(scope);
      if (!self.ok) return self;
      const minutes = input.minutes ?? deps.policy.restMinutes;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > deps.policy.maxRestMinutes) return invalid(`minutes must be 1-${deps.policy.maxRestMinutes}`);
      return recordQuiet({ ...input, minutes }, 'companion_rested');
    },

    async defer(scope, input) {
      const self = requireSelf(scope);
      if (!self.ok) return self;
      if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > deps.policy.maxDeferMinutes) {
        return invalid(`minutes must be 1-${deps.policy.maxDeferMinutes}`);
      }
      return recordQuiet(input, 'companion_deferred');
    },

    async runLane(scope, lane) {
      const self = requireSelf(scope);
      if (!self.ok) return self;
      const before = await recentAcrossLanes();
      if (!before.ok) return before;
      const closed = await closeStale(before.value[0]);
      if (!closed.ok) return closed;
      const recent = await recentAcrossLanes();
      if (!recent.ok) return recent;
      const evaluated = await gateFor(lane, recent.value);
      if (!evaluated.ok) return evaluated;
      const { gate } = evaluated.value;
      if (gate.kind === 'ineligible') return ok({ lane, kind: 'skipped', reason: gate.reason });

      const at = nowMs();
      const created = await deps.blocks.create({
        id: deps.ids.next('free_time_block'),
        lane,
        state: 'invited',
        options: gate.options,
        invitedAt: iso(at),
        localDay: localDay(at, deps.policy.timeZone),
        decidedAt: null,
        choice: null,
        activityId: null,
        outcome: null,
        failure: null,
        revision: 1,
      });
      // Another pass opened a block between this gate and the write: the store keeps one open block, so nothing is asked twice.
      if (!created.ok && created.error.kind === 'conflict' && created.error.reason === 'turn_already_open') return ok({ lane, kind: 'skipped', reason: 'invitation_open' });
      if (!created.ok) return created;
      const invited = await deps.turns.run({ scope, purpose: 'free_time', prompt: invitationPrompt(created.value), reference: { kind: 'free_time_block', id: created.value.id } });
      const after = await deps.blocks.get(created.value.id);
      if (!after.ok) return after;
      const block = after.value;
      if (block.state === 'invited') {
        const failed = !invited.ok || invited.value.status !== 'completed';
        if (!failed) {
          const lapsed = await updateBlock(block, { state: 'lapsed', outcome: 'the companion made no choice' });
          return lapsed.ok ? ok({ lane, kind: 'ran', block: lapsed.value }) : lapsed;
        }
        const reason = invited.ok ? `invitation turn ${invited.value.status}` : `invitation turn could not run: ${invited.error.kind}`;
        const quiet = await deps.rest.extend(lane, { kind: 'system_failure', reason, until: iso(nowMs() + deps.policy.failureQuietMinutes * MINUTE_MS), decidedAt: iso(nowMs()) });
        if (!quiet.ok) return quiet;
        const marked = await updateBlock(block, { state: 'failed', failure: reason });
        return marked.ok ? ok({ lane, kind: 'ran', block: marked.value }) : marked;
      }
      if (block.state !== 'chosen') return ok({ lane, kind: 'ran', block });
      const done = await execute(scope, block);
      return done.ok ? ok({ lane, kind: 'ran', block: done.value }) : done;
    },
  };
}

function invitationPrompt(block: FreeTimeBlock): string {
  const options = block.options.map((o) => `- ${o.optionId}: ${o.label}`).join('\n');
  return [
    `Free time is open (${block.lane === 'quiet_hours' ? 'quiet hours' : 'an idle stretch'}). Nothing is required of you.`,
    `If you want it, choose one option with free_time.choose (blockId ${block.id}). To rest, use free_time.rest; to come back to it later, free_time.defer.`,
    options,
  ].join('\n');
}

function activityPrompt(block: FreeTimeBlock, label: string, kind: string): string {
  const reflect = kind === 'reflect' ? ' What you write in reply is kept as your own reflection.' : '';
  return `Your free time (block ${block.id}): ${label}. Use your usual tools as you like; stopping early is fine.${reflect}`;
}
