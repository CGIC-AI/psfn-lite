import {
  careReminderId,
  normalizeDueAt,
  normalizeReminderText,
  type CareReminder,
  type CareReminderKind,
  type CareReminderPort,
  type CareReminderSchedule,
} from '../intention/index.ts';
import type { SessionCatalogPort } from '../sessions/index.ts';
import { denied, ok, type ChannelId, type Clock, type Result } from '../shared/index.ts';
import { conversationTarget } from './conversation-target.ts';
import type { ReminderDeliveryPort } from './host-ports.ts';
import { authorOf, isTrustedTurnScope, type TrustedTurnScope } from './trusted-scope.ts';

const DAY_MS = 86_400_000;
const DELIVERY_BATCH = 50;

export interface ReminderDeliveryReport {
  readonly delivered: readonly string[];
  /** Delivery was refused definitely (nothing went out); the reminder stays pending for the next tick. */
  readonly failed: readonly { readonly id: string; readonly detail: string }[];
  /** The delivery may have landed (an ambiguous host result, or a marker a crash left behind): recorded as unknown and not sent again. */
  readonly unknown: readonly string[];
  /** Reminders another scheduler pass holds or just moved; left to it, untouched. */
  readonly contended: readonly string[];
}

export interface CareReminderService {
  create(
    scope: TrustedTurnScope,
    input: {
      readonly kind: CareReminderKind;
      readonly title: string;
      readonly content: string;
      readonly schedule: CareReminderSchedule;
      readonly dueAt: string;
      readonly channelId: ChannelId | null;
    },
  ): Promise<Result<{ readonly reminder: CareReminder; readonly created: boolean }>>;
  /** Delivers due reminders through the host; run from the scheduler in a companion-internal turn. */
  deliverDue(scope: TrustedTurnScope): Promise<Result<ReminderDeliveryReport>>;
}

/** Host results that mean the message definitely did not go out. Anything else may have landed. */
const DEFINITE_REFUSALS: ReadonlySet<string> = new Set(['denied', 'invalid', 'not_found']);

/**
 * Care reminders: targeted like follow-ups (the current conversation or a
 * readable one), idempotent by target, text and due time, and delivered by
 * the scheduler through the host's channel delivery. A delivery is fenced:
 * it is marked, with its start time, before the host is asked. An ambiguous
 * outcome is reconciled as unknown, never re-sent; a marker is read as a
 * crash only once it is older than `inFlightMs`, so a delivery another
 * scheduler pass still has in flight is left alone. A daily reminder whose
 * occurrence is unknown moves on to the next day.
 */
export function createCareReminderService(deps: {
  readonly reminders: CareReminderPort;
  readonly catalog: SessionCatalogPort;
  readonly delivery: ReminderDeliveryPort;
  readonly clock: Clock;
  /** How long a `delivering` marker may stand before it is read as left by a crash. */
  readonly inFlightMs: number;
}): CareReminderService {
  const targetFor = conversationTarget(deps.catalog, 'a care reminder');
  const nowMs = () => deps.clock.now().getTime();

  /** The reminder after an occurrence whose outcome is unknown: a one-off ends there; a daily one moves to its next day. */
  const afterUnknown = (reminder: CareReminder): CareReminder =>
    reminder.schedule === 'daily'
      ? { ...reminder, state: 'pending', dueAt: nextDaily(reminder.dueAt, nowMs()), deliveryStartedAt: null, unknownDeliveries: reminder.unknownDeliveries + 1 }
      : { ...reminder, state: 'delivery_unknown', deliveryStartedAt: null, unknownDeliveries: reminder.unknownDeliveries + 1 };

  /** Compare-and-set; a lost race is reported as contended (`null`), anything else fails the pass. */
  const write = async (next: CareReminder, expectedRevision: number): Promise<Result<CareReminder | null>> => {
    const written = await deps.reminders.update({ ...next, revision: expectedRevision + 1 }, expectedRevision);
    if (written.ok) return written;
    return written.error.kind === 'conflict' && written.error.reason === 'stale_revision' ? ok(null) : written;
  };

  return {
    async create(scope, input) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'care reminders are companion-authored');
      const title = normalizeReminderText(input.title, 'title');
      if (!title.ok) return title;
      const content = normalizeReminderText(input.content, 'content');
      if (!content.ok) return content;
      const dueAt = normalizeDueAt(input.dueAt);
      if (!dueAt.ok) return dueAt;
      const target = await targetFor(scope, input.channelId);
      if (!target.ok) return target;
      return deps.reminders.create({
        id: careReminderId(target.value, title.value, content.value, dueAt.value),
        target: target.value,
        kind: input.kind,
        title: title.value,
        content: content.value,
        schedule: input.schedule,
        dueAt: dueAt.value,
        state: 'pending',
        author: authorOf(scope),
        createdAt: deps.clock.now().toISOString(),
        deliveries: 0,
        lastDeliveredAt: null,
        deliveryStartedAt: null,
        unknownDeliveries: 0,
        revision: 1,
      });
    },

    async deliverDue(scope) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      if (scope.audience.kind !== 'self' || scope.caller.kind !== 'companion_internal') {
        return denied('requires_self_audience', 'reminders are delivered from companion-internal turns');
      }
      const report = { delivered: [] as string[], failed: [] as { id: string; detail: string }[], unknown: [] as string[], contended: [] as string[] };
      const stranded = await deps.reminders.list({ states: ['delivering'], dueAtOrBefore: null, limit: DELIVERY_BATCH, after: null });
      if (!stranded.ok) return stranded;
      for (const reminder of stranded.value) {
        const started = reminder.deliveryStartedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(reminder.deliveryStartedAt);
        // Still within its in-flight window: another pass may be delivering it right now.
        if (nowMs() - started < deps.inFlightMs) continue;
        const marked = await write(afterUnknown(reminder), reminder.revision);
        if (!marked.ok) return marked;
        (marked.value === null ? report.contended : report.unknown).push(reminder.id);
      }
      const due = await deps.reminders.list({ states: ['pending'], dueAtOrBefore: deps.clock.now().toISOString(), limit: DELIVERY_BATCH, after: null });
      if (!due.ok) return due;
      for (const reminder of due.value) {
        const delivering = await write({ ...reminder, state: 'delivering', deliveryStartedAt: deps.clock.now().toISOString() }, reminder.revision);
        if (!delivering.ok) return delivering;
        if (delivering.value === null) {
          report.contended.push(reminder.id);
          continue;
        }
        const marked = delivering.value;
        const sent = await deps.delivery.deliver(marked);
        const at = deps.clock.now().toISOString();
        const definite = !sent.ok && DEFINITE_REFUSALS.has(sent.error.kind);
        const next: CareReminder = sent.ok
          ? reminder.schedule === 'daily'
            ? { ...marked, state: 'pending', dueAt: nextDaily(reminder.dueAt, nowMs()), deliveryStartedAt: null, deliveries: reminder.deliveries + 1, lastDeliveredAt: at }
            : { ...marked, state: 'delivered', deliveryStartedAt: null, deliveries: reminder.deliveries + 1, lastDeliveredAt: at }
          : definite
            ? { ...marked, state: 'pending', deliveryStartedAt: null }
            : afterUnknown(marked);
        const settled = await write(next, marked.revision);
        if (!settled.ok) return settled;
        // Another pass read the marker as stranded and already recorded the occurrence as unknown.
        if (settled.value === null) report.contended.push(reminder.id);
        else if (sent.ok) report.delivered.push(reminder.id);
        else if (definite) report.failed.push({ id: reminder.id, detail: sent.error.kind });
        else report.unknown.push(reminder.id);
      }
      return ok(report);
    },
  };
}

/** The next daily occurrence after now, so a missed day is not delivered twice in a row. */
function nextDaily(dueAt: string, nowMs: number): string {
  let next = Date.parse(dueAt) + DAY_MS;
  while (next <= nowMs) next += DAY_MS;
  return new Date(next).toISOString();
}
