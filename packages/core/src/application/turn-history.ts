import { createHash } from 'node:crypto';
import type { SessionEntry, TurnOwner, TurnRecord } from '../sessions/index.ts';

/**
 * Attributed history entries for a turn, derived only from its ledger record.
 * Because they are a pure function of the record, re-appending them after a
 * failed append writes identical entries.
 */
export function turnEntries(record: TurnRecord): SessionEntry[] {
  return [triggerEntry(record), ...settlementEntries(record)];
}

export function triggerEntry(record: TurnRecord): SessionEntry {
  const { trigger } = record;
  return {
    entryId: `${record.turnId}:trigger`,
    sessionId: record.sessionId,
    turnId: record.turnId,
    origin: trigger.kind === 'participant_message' ? { kind: 'participant_speech', speaker: trigger.speaker } : trigger.origin,
    text: trigger.text,
    at: record.openedAt,
  };
}

function settlementEntries(record: TurnRecord): SessionEntry[] {
  const { settlement } = record;
  if (settlement === null) return [];
  const { outcome } = settlement;
  const base = { sessionId: record.sessionId, turnId: record.turnId, at: settlement.settledAt };
  const reply = outcome.kind === 'completed' ? outcome.reply : outcome.partialReply;
  const entries: SessionEntry[] = [];
  if (reply !== null) {
    entries.push({ ...base, entryId: `${record.turnId}:reply`, origin: { kind: 'companion_speech' }, text: reply });
  }
  if (outcome.kind !== 'completed') {
    const recovered = sameOwner(settlement.settledBy, record.owner) ? '' : `; recovered by ${settlement.settledBy.surface}`;
    const text =
      outcome.kind === 'interrupted'
        ? `turn interrupted by ${outcome.by}${recovered}`
        : `turn failed: ${outcome.error.code}: ${outcome.error.message}`;
    entries.push({ ...base, entryId: `${record.turnId}:outcome`, origin: { kind: 'system_note', source: 'turn_lifecycle' }, text });
  }
  return entries;
}

export function sameOwner(a: TurnOwner, b: TurnOwner): boolean {
  return a.surface === b.surface && a.instance === b.instance;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}
