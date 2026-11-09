/**
 * The bridge's JSON wire format. Request bodies are parsed strictly: unknown
 * keys, wrong types and malformed ids are refused, never defaulted. No body
 * field names the caller, the contact or the audience; those come from the
 * transport credential. The response context is the donor's own assembled
 * model request (system prompt, history with the donor's message classes,
 * active tools), so the host renders exactly what a SubstrateAgent turn's
 * model would have seen.
 */
import { invalid, isRecord, ok, type Result } from './mcp.ts';
import type { HostOutcome } from './bridge.ts';
import type { HostTurnContext } from './host-turns.ts';

export interface PrepareBody {
  /** The host process's own instance name; it narrows turn ownership within one credential, never widens it. */
  readonly hostInstance: string;
  readonly idempotencyKey: string;
  /** The host's conversation; with the principal it names the donor channel. */
  readonly sessionId: string;
  readonly message: string;
}

export interface SettleBody {
  readonly hostInstance: string;
  readonly turnId: string;
  readonly outcome: HostOutcome;
  /** The host's failure text, for the operator log only (the donor records the code). */
  readonly errorMessage: string | null;
}

export interface CheckpointBody {
  readonly sessionId: string;
  readonly turnIds: readonly string[];
}

const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
/** The donor's turn ids are UUIDv7 (core/turns/id.ts). */
const TURN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_CHECKPOINT_TURNS = 1_000;

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
  has(key: string): boolean {
    return Object.hasOwn(this.raw, key);
  }
  text(key: string, max: number): string {
    const value = this.raw[key];
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= max) return value;
    if (this.has(key)) this.issues.push(`${this.name(key)} must be a non-empty string of at most ${max} characters`);
    return '';
  }
  pattern(key: string, pattern: RegExp, description: string): string {
    const value = this.raw[key];
    if (typeof value === 'string' && pattern.test(value)) return value;
    if (this.has(key)) this.issues.push(`${this.name(key)} must be ${description}`);
    return '';
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
  const f = fields(raw, '', ['hostInstance', 'idempotencyKey', 'sessionId', 'message']);
  if (!f.ok) return f;
  const hostInstance = f.value.pattern('hostInstance', INSTANCE_PATTERN, '1-64 characters of [A-Za-z0-9._-]');
  const idempotencyKey = f.value.pattern('idempotencyKey', KEY_PATTERN, '1-256 characters of [A-Za-z0-9:._-] starting alphanumeric');
  const sessionId = f.value.pattern('sessionId', SESSION_PATTERN, '1-256 characters of [A-Za-z0-9:._-] starting alphanumeric');
  const message = f.value.text('message', MAX_MESSAGE_CHARS);
  return done(f.value, () => ({ hostInstance, idempotencyKey, sessionId, message }));
}

export function parseSettle(raw: unknown): Result<SettleBody> {
  const f = fields(raw, '', ['hostInstance', 'turnId', 'outcome']);
  if (!f.ok) return f;
  const hostInstance = f.value.pattern('hostInstance', INSTANCE_PATTERN, '1-64 characters of [A-Za-z0-9._-]');
  const turnId = f.value.pattern('turnId', TURN_PATTERN, 'a turn id');
  let outcome: Result<{ outcome: HostOutcome; errorMessage: string | null }> | null = null;
  if (f.value.has('outcome')) {
    outcome = parseOutcome(f.value.get('outcome'));
    if (!outcome.ok) f.value.issues.push(...(outcome.error.kind === 'invalid' ? outcome.error.issues : ['outcome is invalid']));
  }
  return done(f.value, () => {
    const parsed = (outcome as { value: { outcome: HostOutcome; errorMessage: string | null } }).value;
    return { hostInstance, turnId, outcome: parsed.outcome, errorMessage: parsed.errorMessage };
  });
}

function parseOutcome(raw: unknown): Result<{ outcome: HostOutcome; errorMessage: string | null }> {
  if (!isRecord(raw)) return invalid('outcome must be an object');
  const kind = raw['kind'];
  if (kind === 'completed') {
    const f = new Fields(raw, 'outcome', ['kind', 'reply']);
    const reply = f.text('reply', MAX_MESSAGE_CHARS);
    return done(f, () => ({ outcome: { kind: 'completed', reply }, errorMessage: null }));
  }
  if (kind === 'interrupted') {
    const f = new Fields(raw, 'outcome', ['kind']);
    return done(f, () => ({ outcome: { kind: 'interrupted' }, errorMessage: null }));
  }
  if (kind === 'failed') {
    const f = new Fields(raw, 'outcome', ['kind', 'error']);
    const error = f.has('error') ? fields(f.get('error'), 'outcome.error', ['code', 'message']) : null;
    let code = '';
    let message = '';
    if (error !== null) {
      if (!error.ok) f.issues.push(...(error.error.kind === 'invalid' ? error.error.issues : []));
      else {
        code = error.value.pattern('code', CODE_PATTERN, '1-64 characters of [a-z0-9_] starting with a letter');
        message = error.value.text('message', 2_000);
        f.issues.push(...error.value.issues);
      }
    }
    return done(f, () => ({ outcome: { kind: 'failed', code }, errorMessage: message }));
  }
  return invalid('outcome.kind must be completed, interrupted or failed');
}

export function parseCheckpoint(raw: unknown): Result<CheckpointBody> {
  const f = fields(raw, '', ['sessionId', 'turnIds']);
  if (!f.ok) return f;
  const sessionId = f.value.pattern('sessionId', SESSION_PATTERN, '1-256 characters of [A-Za-z0-9:._-] starting alphanumeric');
  const list = f.value.get('turnIds');
  const turnIds: string[] = [];
  if (!Array.isArray(list) || list.length > MAX_CHECKPOINT_TURNS) {
    if (f.value.has('turnIds')) f.value.issues.push(`turnIds must be an array of at most ${MAX_CHECKPOINT_TURNS} turn ids`);
  } else {
    list.forEach((item: unknown, index) => {
      if (typeof item === 'string' && TURN_PATTERN.test(item)) turnIds.push(item);
      else f.value.issues.push(`turnIds[${index}] must be a turn id`);
    });
  }
  return done(f.value, () => ({ sessionId, turnIds }));
}

/** The donor's assembled request, as JSON. */
export function renderContext(context: HostTurnContext): Readonly<Record<string, unknown>> {
  return {
    systemPrompt: context.systemPrompt,
    messages: context.messages.map((m) => ({
      role: m.role,
      text: m.text,
      ...(m.messageClass === undefined ? {} : { messageClass: m.messageClass }),
      ...(m.toolName === undefined ? {} : { toolName: m.toolName }),
    })),
    tools: context.tools.map((t) => t.name),
  };
}
