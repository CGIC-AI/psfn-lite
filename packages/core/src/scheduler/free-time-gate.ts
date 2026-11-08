/**
 * The pre-spend free-time gate (donor `src/core/scheduler/free-time.ts`,
 * `rest-window.ts`, `free-time-chooser.ts`). Pure: no I/O and no inference,
 * so a closed gate costs nothing. Ordered hard closes: unreadable or active
 * rest, the quiet-hours window, an invitation already open, recent partner
 * activity, the minimum interval and the daily cap.
 */
import type { ActivityId } from '../shared/index.ts';
import type { FreeTimePolicy } from './policy.ts';
import { inDailyWindow, localMinute, parseLocalTime } from './time.ts';
import type { FreeTimeBlock, FreeTimeGate, FreeTimeLane, FreeTimeOption, RestDecision } from './types.ts';

const MINUTE_MS = 60_000;

export interface FreeTimeGateInput {
  readonly lane: FreeTimeLane;
  readonly nowMs: number;
  readonly policy: FreeTimePolicy;
  readonly rest: RestDecision | null | 'unavailable';
  /** The latest block of any lane, if any: the interval and the open invitation are shared across lanes. */
  readonly latest: FreeTimeBlock | null;
  /** Blocks of every lane invited on the current local day. */
  readonly blocksToday: number;
  readonly partnerActiveAtMs: number | null;
  readonly resumable: readonly { readonly activityId: ActivityId; readonly purpose: string }[];
}

export function evaluateFreeTimeGate(input: FreeTimeGateInput): FreeTimeGate {
  const { policy, nowMs } = input;
  if (input.rest === 'unavailable') return { kind: 'ineligible', reason: 'rest_state_unavailable' };
  if (input.rest !== null && Date.parse(input.rest.until) > nowMs) return { kind: 'ineligible', reason: 'silenced' };
  if (input.lane === 'quiet_hours') {
    const start = parseLocalTime(policy.quietHours.start);
    const end = parseLocalTime(policy.quietHours.end);
    if (!start.ok || !end.ok || !inDailyWindow(localMinute(nowMs, policy.timeZone), start.value, end.value)) {
      return { kind: 'ineligible', reason: 'outside_quiet_hours' };
    }
  }
  if (input.latest !== null && isOpen(input.latest, nowMs, policy)) return { kind: 'ineligible', reason: 'invitation_open' };
  if (input.partnerActiveAtMs !== null && nowMs - input.partnerActiveAtMs < policy.partnerQuietMinutes * MINUTE_MS) {
    return { kind: 'ineligible', reason: 'recent_partner_activity' };
  }
  if (input.latest !== null && nowMs - Date.parse(input.latest.invitedAt) < policy.minIntervalMinutes * MINUTE_MS) {
    return { kind: 'ineligible', reason: 'min_interval' };
  }
  if (input.blocksToday >= policy.maxBlocksPerDay) return { kind: 'ineligible', reason: 'daily_cap' };
  return { kind: 'eligible', options: freeTimeOptions(input.resumable.slice(0, policy.maxResumeOptions)) };
}

/** An invitation still awaiting the companion, or a block whose activity is being carried out. */
export function isOpen(block: FreeTimeBlock, nowMs: number, policy: FreeTimePolicy): boolean {
  if (block.state === 'chosen' || block.state === 'executing') return nowMs - Date.parse(block.decidedAt ?? block.invitedAt) < policy.blockLeaseMinutes * MINUTE_MS;
  return block.state === 'invited' && nowMs - Date.parse(block.invitedAt) < policy.inviteTtlMinutes * MINUTE_MS;
}

/** The fixed menu. Rest is always offered; nothing outside this list can be chosen. */
export function freeTimeOptions(resumable: readonly { readonly activityId: ActivityId; readonly purpose: string }[]): readonly FreeTimeOption[] {
  return [
    { optionId: 'rest', kind: 'rest', label: 'Rest; nothing needs doing now', activityId: null },
    { optionId: 'reflect', kind: 'reflect', label: 'Reflect privately and write it down', activityId: null },
    { optionId: 'wander', kind: 'wander', label: 'Spend private time on whatever interests you', activityId: null },
    ...resumable.map((r): FreeTimeOption => ({ optionId: `resume:${r.activityId}`, kind: 'resume_project', label: `Resume: ${r.purpose.slice(0, 120)}`, activityId: r.activityId })),
    { optionId: 'begin_new', kind: 'begin_new', label: 'Begin something new', activityId: null },
  ];
}
