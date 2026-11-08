/**
 * Wall-clock arithmetic in an explicit IANA time zone (donor
 * `src/shared/time/daily-window.ts`). Nothing falls back to the host's zone:
 * an unknown zone or a local time that does not exist there is invalid.
 */
import { invalid, ok, type Result } from '../shared/index.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone.length > 0;
  } catch {
    return false;
  }
}

/** Minutes since local midnight of `HH:MM`. */
export function parseLocalTime(raw: string): Result<number> {
  const match = LOCAL_TIME.exec(raw);
  if (match === null) return invalid('local time must be HH:MM (24-hour)');
  return ok(Number(match[1]) * 60 + Number(match[2]));
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function partsAt(ms: number, zone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** `YYYY-MM-DD` of an instant in a zone. */
export function localDay(ms: number, zone: string): string {
  const p = partsAt(ms, zone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Minutes since local midnight of an instant in a zone. */
export function localMinute(ms: number, zone: string): number {
  const p = partsAt(ms, zone);
  return p.hour * 60 + p.minute;
}

/** Whether a minute of the day falls in [start, end), wrapping past midnight when end <= start. */
export function inDailyWindow(minute: number, start: number, end: number): boolean {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function offsetAt(ms: number, zone: string): number {
  const p = partsAt(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** The instant a local `YYYY-MM-DDTHH:MM` names in a zone; a time skipped by a clock change is invalid. */
export function zonedInstant(localDateTime: string, zone: string): Result<number> {
  if (!isTimeZone(zone)) return invalid(`unknown time zone ${zone}`);
  const match = LOCAL_DATE_TIME.exec(localDateTime);
  if (match === null) return invalid('local time must be YYYY-MM-DDTHH:MM');
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall - offsetAt(wall, zone);
  guess = wall - offsetAt(guess, zone);
  const back = partsAt(guess, zone);
  if (back.year !== y || back.month !== mo || back.day !== d || back.hour !== h || back.minute !== mi) {
    return invalid(`${localDateTime} does not exist in ${zone}`);
  }
  return ok(guess);
}

/** The first instant strictly after `afterMs` whose local time in `zone` is `HH:MM`. */
export function nextDailyInstant(localTime: string, zone: string, afterMs: number): Result<number> {
  if (!isTimeZone(zone)) return invalid(`unknown time zone ${zone}`);
  const minute = parseLocalTime(localTime);
  if (!minute.ok) return minute;
  for (let day = 0; day <= 2; day += 1) {
    const candidateDay = localDay(afterMs + day * DAY_MS, zone);
    const at = zonedInstant(`${candidateDay}T${localTime}`, zone);
    if (at.ok && at.value > afterMs) return at;
  }
  return invalid(`${localTime} does not occur in ${zone} in the next two days`);
}
