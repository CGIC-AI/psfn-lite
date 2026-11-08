/**
 * Care reminders (donor `src/core/intention/care-reminders.ts`): something the
 * companion means to raise with someone at a set time, once or daily. A
 * reminder is identified by its target conversation, title, content and first
 * due time, so a retried create is the same reminder.
 */
import { createHash } from 'node:crypto';
import { conversationKey, invalid, ok, type Audience, type Author, type Result } from '../shared/index.ts';

export const CARE_REMINDER_KINDS = ['check_in', 'commitment', 'self_care', 'occasion'] as const;
export type CareReminderKind = (typeof CARE_REMINDER_KINDS)[number];
export const CARE_REMINDER_SCHEDULES = ['once', 'daily'] as const;
export type CareReminderSchedule = (typeof CARE_REMINDER_SCHEDULES)[number];
/**
 * `delivering` is recorded before the host is asked to deliver. One found
 * still delivering later becomes `delivery_unknown` and is not sent again.
 */
export const CARE_REMINDER_STATES = ['pending', 'delivering', 'delivered', 'delivery_unknown', 'dismissed'] as const;
export type CareReminderState = (typeof CARE_REMINDER_STATES)[number];

export const MAX_REMINDER_TITLE_CHARS = 160;
export const MAX_REMINDER_TEXT_CHARS = 500;

export interface CareReminder {
  readonly id: string;
  /** The conversation it will be raised in; reads follow `canViewerRead` on it. */
  readonly target: Audience;
  readonly kind: CareReminderKind;
  readonly title: string;
  readonly content: string;
  readonly schedule: CareReminderSchedule;
  readonly dueAt: string;
  readonly state: CareReminderState;
  readonly author: Author;
  readonly createdAt: string;
  readonly deliveries: number;
  readonly lastDeliveredAt: string | null;
  readonly revision: number;
}

export interface CareReminderCursor {
  readonly dueAt: string;
  readonly id: string;
}

export interface CareReminderPort {
  /** Idempotent by id: an existing id returns the stored reminder with `created: false`. */
  create(reminder: CareReminder): Promise<Result<{ readonly reminder: CareReminder; readonly created: boolean }>>;
  get(id: string): Promise<Result<CareReminder>>;
  /** One page, earliest due first. A page shorter than `limit` means the store is exhausted. */
  list(query: {
    readonly states: readonly CareReminderState[] | null;
    readonly dueAtOrBefore: string | null;
    readonly limit: number;
    readonly after: CareReminderCursor | null;
  }): Promise<Result<readonly CareReminder[]>>;
  update(next: CareReminder, expectedRevision: number): Promise<Result<CareReminder>>;
}

export function normalizeReminderText(raw: string, field: 'title' | 'content'): Result<string> {
  const max = field === 'title' ? MAX_REMINDER_TITLE_CHARS : MAX_REMINDER_TEXT_CHARS;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > max) return invalid(`${field} must be 1-${max} characters`);
  return ok(text);
}

export function careReminderId(target: Audience, title: string, content: string, dueAt: string): string {
  const digest = createHash('sha256').update(`${conversationKey(target)}\n${title.toLowerCase()}\n${content.toLowerCase()}\n${dueAt}`).digest('hex');
  return `care_reminder:${digest.slice(0, 32)}`;
}
