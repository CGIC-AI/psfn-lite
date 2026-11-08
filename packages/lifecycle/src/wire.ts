/**
 * The bridge's JSON wire format. Request bodies are parsed strictly: unknown
 * keys, wrong types and malformed ids are refused, never defaulted. No body
 * field ever names the caller, the contact, the audience or the speaker;
 * those come from the transport credential through core ingress. Responses
 * keep core's attribution: every context entry carries the role and label
 * core derived from its origin.
 */
import {
  invalid,
  isRecord,
  ok,
  parseId,
  type ContextEntry,
  type DeliveryStatus,
  type IdempotencyKey,
  type Result,
  type TurnContextParts,
  type TurnId,
  type TurnOutcome,
  type TurnRecord,
} from './core.ts';

export interface PrepareBody {
  /** The host process's own instance name; it narrows turn ownership within one credential, never widens it. */
  readonly hostInstance: string;
  readonly idempotencyKey: IdempotencyKey;
  /** The participant's message; null for a delegated internal turn, whose trigger core already fixed. */
  readonly message: string | null;
}

export interface SettleBody {
  readonly hostInstance: string;
  readonly turnId: TurnId;
  readonly outcome: TurnOutcome;
  readonly toolCallCount: number;
}

export interface CheckpointBody {
  readonly turnIds: readonly TurnId[];
}

export interface ClaimBody {
  /** How long to wait for a delegated internal turn before answering with none. */
  readonly waitMs: number;
}

export interface ReleaseBody {
  readonly jobId: string;
  readonly error: { readonly code: string; readonly message: string };
}

const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JOB_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const DELIVERY: readonly DeliveryStatus[] = ['not_attempted', 'delivered', 'not_delivered', 'unknown'];
const INTERRUPTERS = ['participant', 'host', 'shutdown'] as const;
const MAX_MESSAGE_CHARS = 200_000;
export const MAX_CLAIM_WAIT_MS = 60_000;

class Fields {
  readonly issues: string[] = [];
  constructor(
    private readonly raw: Readonly<Record<string, unknown>>,
    private readonly at: string,
    allowed: readonly string[],
  ) {
    for (const key of Object.keys(raw)) if (!allowed.includes(key)) this.issues.push(`${this.name(key)} is not a known field`);
    for (const key of allowed) if (!Object.hasOwn(raw, key)) this.issues.push(`${this.name(key)} is required`);
  }
  name(key: string): string {
    return this.at === '' ? key : `${this.at}.${key}`;
  }
  get(key: string): unknown {
    return this.raw[key];
  }
  text(key: string, max: number, nullable: boolean): string | null {
    const value = this.raw[key];
    if (nullable && value === null) return null;
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= max) return value;
    if (Object.hasOwn(this.raw, key)) this.issues.push(`${this.name(key)} must be ${nullable ? 'null or ' : ''}a non-empty string of at most ${max} characters`);
    return null;
  }
  pattern(key: string, pattern: RegExp, description: string): string {
    const value = this.raw[key];
    if (typeof value === 'string' && pattern.test(value)) return value;
    if (Object.hasOwn(this.raw, key)) this.issues.push(`${this.name(key)} must be ${description}`);
    return '';
  }
  id<K extends string>(key: string, kind: K): ReturnType<typeof parseId<K>> {
    const parsed = parseId(kind, this.raw[key]);
    if (!parsed.ok && Object.hasOwn(this.raw, key)) this.issues.push(`${this.name(key)} must be an id of [A-Za-z0-9:._-] starting alphanumeric`);
    return parsed;
  }
  integer(key: string, min: number, max: number): number {
    const value = this.raw[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
    if (Object.hasOwn(this.raw, key)) this.issues.push(`${this.name(key)} must be an integer from ${min} to ${max}`);
    return min;
  }
  oneOf<T extends string>(key: string, options: readonly T[]): T {
    const value = this.raw[key];
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T;
    if (Object.hasOwn(this.raw, key)) this.issues.push(`${this.name(key)} must be one of ${options.join(', ')}`);
    return options[0] as T;
  }
}

function fields(raw: unknown, at: string, allowed: readonly string[]): Result<Fields> {
  if (!isRecord(raw)) return invalid(`${at === '' ? 'body' : at} must be a JSON object`);
  return ok(new Fields(raw, at, allowed));
}

function done<T>(f: Fields, value: () => T): Result<T> {
  return f.issues.length > 0 ? invalid(...f.issues) : ok(value());
}

export function parsePrepare(raw: unknown): Result<PrepareBody> {
  const f = fields(raw, '', ['hostInstance', 'idempotencyKey', 'message']);
  if (!f.ok) return f;
  const hostInstance = f.value.pattern('hostInstance', INSTANCE_PATTERN, '1-64 characters of [A-Za-z0-9._-]');
  const key = f.value.id('idempotencyKey', 'idempotency_key');
  const message = f.value.text('message', MAX_MESSAGE_CHARS, true);
  return done(f.value, () => ({ hostInstance, idempotencyKey: key.ok ? key.value : ('' as IdempotencyKey), message }));
}

export function parseSettle(raw: unknown): Result<SettleBody> {
  const f = fields(raw, '', ['hostInstance', 'turnId', 'outcome', 'toolCallCount']);
  if (!f.ok) return f;
  const hostInstance = f.value.pattern('hostInstance', INSTANCE_PATTERN, '1-64 characters of [A-Za-z0-9._-]');
  const turnId = f.value.id('turnId', 'turn');
  const toolCallCount = f.value.integer('toolCallCount', 0, 10_000);
  const outcome = Object.hasOwn(isRecord(raw) ? raw : {}, 'outcome') ? parseOutcome(f.value.get('outcome')) : null;
  if (outcome !== null && !outcome.ok) f.value.issues.push(...(outcome.error.kind === 'invalid' ? outcome.error.issues : ['outcome is invalid']));
  return done(f.value, () => ({ hostInstance, turnId: turnId.ok ? turnId.value : ('' as TurnId), outcome: (outcome as { value: TurnOutcome }).value, toolCallCount }));
}

function parseOutcome(raw: unknown): Result<TurnOutcome> {
  if (!isRecord(raw)) return invalid('outcome must be an object');
  const kind = raw['kind'];
  if (kind === 'completed') {
    const f = new Fields(raw, 'outcome', ['kind', 'reply', 'delivery']);
    const reply = f.text('reply', MAX_MESSAGE_CHARS, true);
    const delivery = f.oneOf('delivery', DELIVERY);
    return done(f, () => ({ kind: 'completed', reply, delivery }));
  }
  if (kind === 'interrupted') {
    const f = new Fields(raw, 'outcome', ['kind', 'by', 'partialReply', 'delivery']);
    const by = f.oneOf('by', INTERRUPTERS);
    const partialReply = f.text('partialReply', MAX_MESSAGE_CHARS, true);
    const delivery = f.oneOf('delivery', DELIVERY);
    return done(f, () => ({ kind: 'interrupted', by, partialReply, delivery }));
  }
  if (kind === 'failed') {
    const f = new Fields(raw, 'outcome', ['kind', 'error', 'partialReply', 'delivery']);
    const error = parseError(f.get('error'), 'outcome.error');
    if (!error.ok) f.issues.push(...(error.error.kind === 'invalid' ? error.error.issues : []));
    const partialReply = f.text('partialReply', MAX_MESSAGE_CHARS, true);
    const delivery = f.oneOf('delivery', DELIVERY);
    return done(f, () => ({ kind: 'failed', error: (error as { value: { code: string; message: string } }).value, partialReply, delivery }));
  }
  return invalid('outcome.kind must be completed, interrupted or failed');
}

function parseError(raw: unknown, at: string): Result<{ readonly code: string; readonly message: string }> {
  const f = fields(raw, at, ['code', 'message']);
  if (!f.ok) return f;
  const code = f.value.pattern('code', /^[a-z][a-z0-9_]{0,63}$/, '1-64 characters of [a-z0-9_] starting with a letter');
  const message = f.value.text('message', 2_000, false) ?? '';
  return done(f.value, () => ({ code, message }));
}

export function parseCheckpoint(raw: unknown): Result<CheckpointBody> {
  const f = fields(raw, '', ['turnIds']);
  if (!f.ok) return f;
  const list = f.value.get('turnIds');
  const turnIds: TurnId[] = [];
  if (!Array.isArray(list)) {
    if (isRecord(raw) && Object.hasOwn(raw, 'turnIds')) f.value.issues.push('turnIds must be an array of turn ids');
  } else {
    list.forEach((item: unknown, index) => {
      const id = parseId('turn', item);
      if (id.ok) turnIds.push(id.value);
      else f.value.issues.push(`turnIds[${index}] must be a turn id`);
    });
  }
  return done(f.value, () => ({ turnIds }));
}

export function parseClaim(raw: unknown): Result<ClaimBody> {
  const f = fields(raw, '', ['waitMs']);
  if (!f.ok) return f;
  const waitMs = f.value.integer('waitMs', 0, MAX_CLAIM_WAIT_MS);
  return done(f.value, () => ({ waitMs }));
}

export function parseRelease(raw: unknown): Result<ReleaseBody> {
  const f = fields(raw, '', ['jobId', 'error']);
  if (!f.ok) return f;
  const jobId = f.value.pattern('jobId', JOB_PATTERN, 'a job id');
  const error = Object.hasOwn(isRecord(raw) ? raw : {}, 'error') ? parseError(f.value.get('error'), 'error') : null;
  if (error !== null && !error.ok) f.value.issues.push(...(error.error.kind === 'invalid' ? error.error.issues : []));
  return done(f.value, () => ({ jobId, error: (error as { value: { code: string; message: string } }).value }));
}

/** Context with core's labels and roles kept, for the host to render as labelled text. */
export function renderContext(parts: TurnContextParts): Readonly<Record<string, unknown>> {
  const entry = (e: ContextEntry) => ({ role: e.role, label: e.label, origin: e.origin.kind, text: e.text });
  return {
    layers: parts.layers,
    orientation: parts.orientation.map((b) => ({ name: b.name, text: b.text })),
    internal: parts.internal.map(entry),
    activity: parts.activity.map(entry),
    history: parts.history.map(entry),
  };
}

export function renderRecord(record: TurnRecord): Readonly<Record<string, unknown>> {
  const outcome = record.settlement?.outcome ?? null;
  return {
    turnId: record.turnId,
    sessionId: record.sessionId,
    status: outcome === null ? 'open' : outcome.kind,
    reply: outcome === null ? null : outcome.kind === 'completed' ? outcome.reply : outcome.partialReply,
  };
}
