import { deepFreeze, invalid, isRecord, ok, type Result } from '../shared/index.ts';
import { isTimeZone, parseLocalTime } from './time.ts';

/**
 * Owner-versioned free-time policy (donor `FreeTimeConfig` and the
 * episodic-processing rest window). Every threshold is explicit; nothing is
 * defaulted from the host environment.
 */
export interface FreeTimePolicy {
  readonly version: number;
  readonly timeZone: string;
  /** The quiet-hours lane runs only inside this local window; it may wrap midnight. */
  readonly quietHours: { readonly start: string; readonly end: string };
  readonly minIntervalMinutes: number;
  readonly maxBlocksPerDay: number;
  /** A participant conversation active this recently closes both lanes. */
  readonly partnerQuietMinutes: number;
  readonly restMinutes: number;
  readonly maxRestMinutes: number;
  readonly maxDeferMinutes: number;
  /** How long a failed invitation keeps the lane quiet; recorded as a system failure. */
  readonly failureQuietMinutes: number;
  /** An unanswered invitation older than this lapses; it is never treated as a choice. */
  readonly inviteTtlMinutes: number;
  /** A chosen activity still open after this long was cut off (a crash); it is marked interrupted, never re-run. */
  readonly blockLeaseMinutes: number;
  readonly maxResumeOptions: number;
}

export const BASELINE_FREE_TIME_POLICY: FreeTimePolicy = deepFreeze({
  version: 1,
  timeZone: 'UTC',
  quietHours: { start: '01:00', end: '06:00' },
  minIntervalMinutes: 180,
  maxBlocksPerDay: 3,
  partnerQuietMinutes: 30,
  restMinutes: 360,
  maxRestMinutes: 1440,
  maxDeferMinutes: 720,
  failureQuietMinutes: 60,
  inviteTtlMinutes: 30,
  blockLeaseMinutes: 120,
  maxResumeOptions: 3,
});

const BOUNDED: readonly (readonly [keyof FreeTimePolicy, number, number])[] = [
  ['minIntervalMinutes', 1, 10_080],
  ['maxBlocksPerDay', 1, 48],
  ['partnerQuietMinutes', 0, 1_440],
  ['restMinutes', 1, 10_080],
  ['maxRestMinutes', 1, 10_080],
  ['maxDeferMinutes', 1, 10_080],
  ['failureQuietMinutes', 1, 10_080],
  ['inviteTtlMinutes', 1, 1_440],
  ['blockLeaseMinutes', 1, 1_440],
  ['maxResumeOptions', 0, 10],
];

/** Validates owner configuration; unknown keys and out-of-range values reject. */
export function parseFreeTimePolicy(raw: unknown): Result<FreeTimePolicy> {
  if (!isRecord(raw)) return invalid('free-time policy must be an object');
  const known = new Set(['version', 'timeZone', 'quietHours', ...BOUNDED.map(([k]) => k)]);
  const issues = Object.keys(raw)
    .filter((k) => !known.has(k))
    .map((k) => `unknown free-time policy key ${k}`);
  const { version, timeZone, quietHours } = raw;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) issues.push('version must be a positive integer');
  if (typeof timeZone !== 'string' || !isTimeZone(timeZone)) issues.push('timeZone must be an IANA time zone');
  if (!isRecord(quietHours) || Object.keys(quietHours).some((k) => k !== 'start' && k !== 'end')) {
    issues.push('quietHours must be { start, end }');
  } else {
    for (const edge of ['start', 'end'] as const) {
      const value = quietHours[edge];
      if (typeof value !== 'string' || !parseLocalTime(value).ok) issues.push(`quietHours.${edge} must be HH:MM`);
    }
    if (quietHours['start'] === quietHours['end']) issues.push('quietHours must not be empty');
  }
  for (const [key, min, max] of BOUNDED) {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) issues.push(`${key} must be an integer from ${min} to ${max}`);
  }
  if (typeof raw['restMinutes'] === 'number' && typeof raw['maxRestMinutes'] === 'number' && raw['restMinutes'] > raw['maxRestMinutes']) {
    issues.push('restMinutes must not exceed maxRestMinutes');
  }
  if (issues.length > 0) return invalid(...issues);
  return ok(deepFreeze({ ...(raw as unknown as FreeTimePolicy) }));
}
