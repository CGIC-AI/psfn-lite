/**
 * Follow-up identity and content rules (donor `src/core/intention/pending-follow-ups.ts`).
 * A follow-up is identified by the conversation it targets, its normalized
 * content and its due time, so a retried create cannot enqueue a duplicate.
 */
import { createHash } from 'node:crypto';
import { conversationKey, invalid, ok, type Audience, type Result } from '../shared/index.ts';

export const MAX_FOLLOW_UP_CHARS = 500;

export function normalizeFollowUpContent(raw: string): Result<string> {
  const content = raw.replace(/\s+/g, ' ').trim();
  if (content.length === 0 || content.length > MAX_FOLLOW_UP_CHARS) return invalid(`content must be 1-${MAX_FOLLOW_UP_CHARS} characters`);
  return ok(content);
}

/** Canonical ISO form of a due time; anything unparseable is invalid. */
export function normalizeDueAt(raw: string): Result<string> {
  const ms = Date.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !Number.isFinite(ms)) return invalid('dueAt must be an ISO 8601 timestamp');
  return ok(new Date(ms).toISOString());
}

export function followUpId(target: Audience, content: string, dueAt: string): string {
  const digest = createHash('sha256').update(`${conversationKey(target)}\n${content.toLowerCase()}\n${dueAt}`).digest('hex');
  return `follow_up:${digest.slice(0, 32)}`;
}
