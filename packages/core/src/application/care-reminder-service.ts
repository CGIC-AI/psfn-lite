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
  /** Delivery was refused or failed definitely; the reminder stays pending for the next tick. */
  readonly failed: readonly { readonly id: string; readonly detail: string }[];
  /** A delivery a crash left unconfirmed: recorded as unknown and not sent again. */
  readonly unknown: readonly string[];
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

/**
 * Care reminders: targeted like follow-ups (the current conversation or a
 * readable one), idempotent by target, text and due time, and delivered by
 * the scheduler through the host's channel delivery. A delivery is fenced: it
 * is marked before the host is asked, so a crash never sends it twice.
 */
export function createCareReminderService(deps: {
  readonly reminders: CareReminderPort;
  readonly catalog: SessionCatalogPort;
  readonly delivery: ReminderDeliveryPort;
  readonly clock: Clock;
}): CareReminderService {
  const targetFor = conversationTarget(deps.catalog, 'a care reminder');
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
        revision: 1,
      });
    },

    async deliverDue(scope) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      if (scope.audience.kind !== 'self' || scope.caller.kind !== 'companion_internal') {
        return denied('requires_self_audience', 'reminders are delivered from companion-internal turns');
      }
      const report = { delivered: [] as string[], failed: [] as { id: string; detail: string }[], unknown: [] as string[] };
      const stranded = await deps.reminders.list({ states: ['delivering'], dueAtOrBefore: null, limit: DELIVERY_BATCH, after: null });
      if (!stranded.ok) return stranded;
      for (const reminder of stranded.value) {
        const marked = await deps.reminders.update({ ...reminder, state: 'delivery_unknown', revision: reminder.revision + 1 }, reminder.revision);
        if (!marked.ok) return marked;
        report.unknown.push(reminder.id);
      }
      const due = await deps.reminders.list({ states: ['pending'], dueAtOrBefore: deps.clock.now().toISOString(), limit: DELIVERY_BATCH, after: null });
      if (!due.ok) return due;
      for (const reminder of due.value) {
        const delivering = await deps.reminders.update({ ...reminder, state: 'delivering', revision: reminder.revision + 1 }, reminder.revision);
        if (!delivering.ok) return delivering;
        const sent = await deps.delivery.deliver(delivering.value);
        const at = deps.clock.now().toISOString();
        const next: CareReminder = sent.ok
          ? reminder.schedule === 'daily'
            ? { ...delivering.value, state: 'pending', dueAt: nextDaily(reminder.dueAt, deps.clock.now().getTime()), deliveries: reminder.deliveries + 1, lastDeliveredAt: at }
            : { ...delivering.value, state: 'delivered', deliveries: reminder.deliveries + 1, lastDeliveredAt: at }
          : { ...delivering.value, state: 'pending' };
        const settled = await deps.reminders.update({ ...next, revision: delivering.value.revision + 1 }, delivering.value.revision);
        if (!settled.ok) return settled;
        if (sent.ok) report.delivered.push(reminder.id);
        else report.failed.push({ id: reminder.id, detail: sent.error.kind === 'unavailable' ? sent.error.detail : sent.error.kind });
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
