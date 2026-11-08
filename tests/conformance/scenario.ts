/**
 * The continuity conformance contract shared by every runner. A scenario is
 * plain JSON (tests/conformance/scenarios/*.json), so the TypeScript runner
 * and the Python runner inside the pinned Hermes read the same file. Steps
 * name a surface role (`a`, `b`) or a fixed surface (`pi`, `hermes`); a
 * scenario whose `orders` is `both` runs once as a=pi,b=hermes and once as
 * a=hermes,b=pi. The expectation vocabulary is deliberately small:
 * substrings of the canonical JSON of a result (`has`, `lacks`, `count`),
 * error kind and reason, and what the companion was shown (`sees`, `hides`,
 * `speech`, `notSpeech`). `{{name}}` in any string resolves a variable:
 * `turn.<stepId>` is the Lite turn id of a turn step, `contact.operator` and
 * `contact.friend` the seeded contacts, and `capture` adds more from a
 * result. Python mirrors `resolveTemplates`, `captureInto` and the checks in
 * integrations/hermes/tests/conformance_runner.py; keep them in step.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Surface = 'pi' | 'hermes';
export type Role = 'a' | 'b';
export type Speaker = 'operator' | 'friend';

export interface ResultExpect {
  readonly ok?: boolean;
  /** Core error kind (denied, not_found, conflict, invalid, unavailable). */
  readonly error?: string;
  readonly reason?: string;
  readonly has?: readonly string[];
  readonly lacks?: readonly string[];
  /** Exact number of occurrences of each substring. */
  readonly count?: Readonly<Record<string, number>>;
}

export interface PlannedCall {
  readonly tool: string;
  readonly action: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly expect?: ResultExpect;
  /** Variable name to a regular expression with one group, matched on the canonical result. */
  readonly capture?: Readonly<Record<string, string>>;
}

export interface TurnStep {
  readonly do: 'turn';
  readonly id: string;
  readonly on: Role | Surface;
  readonly as?: Speaker;
  readonly say: string;
  /** Governed tool calls the companion makes in the turn, in order, before it replies. */
  readonly calls?: readonly PlannedCall[];
  readonly reply?: string;
  /** The host running the turn dies mid-turn (Pi: the host process is killed; Hermes: no settlement ever arrives). */
  readonly abandon?: boolean;
  /** The Lite host process is killed while a worker this turn spawned is mid model call; a successor starts over the same state. */
  readonly crash?: 'worker';
  /** Lite refuses to open the turn at all. */
  readonly refused?: { readonly error: string; readonly reason?: string };
  readonly sees?: readonly string[];
  readonly hides?: readonly string[];
  /** Text the surface must present to the companion as participant speech. */
  readonly speech?: readonly string[];
  /** Text the companion must be shown, but never as participant speech. */
  readonly notSpeech?: readonly string[];
}

export interface HostStep {
  readonly do: 'host';
  readonly id: string;
  readonly op: HostOp;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly expect?: ResultExpect;
  readonly capture?: Readonly<Record<string, string>>;
}

/** Steps a runner performs itself: `crash` kills the host process and starts a successor over the same state. */
export interface RunnerStep {
  readonly do: 'crash';
  readonly id: string;
}

export type Step = TurnStep | HostStep | RunnerStep;

export const HOST_OPS = [
  'advance',
  'tick',
  'maintain',
  'consent',
  'worker_plan',
  'worker_results',
  'inventory',
  'dispatch',
  'history',
  'backup_restore',
  'restart',
  'pi_tools',
  'model_calls',
] as const;
export type HostOp = (typeof HOST_OPS)[number];

export interface Scenario {
  readonly name: string;
  readonly invariant: string;
  readonly orders: 'both' | 'fixed';
  readonly internalTurns: 'harness' | 'delegated';
  readonly steps: readonly Step[];
}

/** One way a scenario runs: which surface plays each role. */
export interface Order {
  readonly a: Surface;
  readonly b: Surface;
}

export function ordersOf(scenario: Scenario): readonly Order[] {
  return scenario.orders === 'both'
    ? [
        { a: 'pi', b: 'hermes' },
        { a: 'hermes', b: 'pi' },
      ]
    : [{ a: 'pi', b: 'hermes' }];
}

export function surfaceOf(on: TurnStep['on'], order: Order): Surface {
  return on === 'a' || on === 'b' ? order[on] : on;
}

export const SCENARIO_DIR = join(import.meta.dirname, 'scenarios');

export function loadScenarios(): readonly Scenario[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseScenario(JSON.parse(readFileSync(join(SCENARIO_DIR, f), 'utf8')) as unknown, f));
}

/** Strict enough that a typo in a scenario fails loudly instead of checking nothing. */
export function parseScenario(raw: unknown, file: string): Scenario {
  const fail = (why: string): never => {
    throw new Error(`${file}: ${why}`);
  };
  if (!isObject(raw)) return fail('a scenario is an object');
  exactKeys(raw, ['name', 'invariant', 'orders', 'internalTurns', 'steps'], file);
  const steps = raw['steps'];
  if (!Array.isArray(steps) || steps.length === 0) return fail('steps must be a non-empty list');
  const ids = new Set<string>();
  for (const [index, step] of (steps as unknown[]).entries()) {
    const at = `${file} step ${String(index)}`;
    if (!isObject(step) || typeof step['id'] !== 'string' || step['id'] === '') return fail(`step ${String(index)} needs an id`);
    if (ids.has(step['id'])) return fail(`duplicate step id ${step['id']}`);
    ids.add(step['id']);
    if (step['do'] === 'turn') {
      exactKeys(step, ['do', 'id', 'on', 'as', 'say', 'calls', 'reply', 'abandon', 'crash', 'refused', 'sees', 'hides', 'speech', 'notSpeech'], at);
      if (!['a', 'b', 'pi', 'hermes'].includes(String(step['on']))) fail(`${at}: on must be a, b, pi or hermes`);
      if (step['as'] === 'friend' && step['on'] !== 'hermes') fail(`${at}: only Hermes binds a friend; the standalone host vouches for the operator alone`);
      for (const call of (step['calls'] as unknown[] | undefined) ?? []) {
        if (!isObject(call)) return fail(`${at}: a call is an object`);
        exactKeys(call, ['tool', 'action', 'args', 'expect', 'capture'], at);
        if (isObject(call['expect'])) exactKeys(call['expect'], ['ok', 'error', 'reason', 'has', 'lacks', 'count'], at);
      }
    } else if (step['do'] === 'host') {
      exactKeys(step, ['do', 'id', 'op', 'args', 'expect', 'capture'], at);
      if (!(HOST_OPS as readonly string[]).includes(String(step['op']))) fail(`${at}: unknown host op ${String(step['op'])}`);
      if (isObject(step['expect'])) exactKeys(step['expect'], ['ok', 'error', 'reason', 'has', 'lacks', 'count'], at);
    } else if (step['do'] === 'crash') {
      exactKeys(step, ['do', 'id'], at);
    } else {
      fail(`${at}: do must be turn, host or crash`);
    }
  }
  if (raw['orders'] !== 'both' && raw['orders'] !== 'fixed') fail('orders must be both or fixed');
  if (raw['internalTurns'] !== 'harness' && raw['internalTurns'] !== 'delegated') fail('internalTurns must be harness or delegated');
  return raw as unknown as Scenario;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw new Error(`${at}: unknown keys ${unknown.join(', ')}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// -- variables -----------------------------------------------------------

export type Vars = Record<string, string>;

/** Replaces `{{name}}` in every string of a JSON value; an unknown name is an error, never left in place. */
export function resolveTemplates<T>(value: T, vars: Readonly<Vars>): T {
  if (typeof value === 'string') {
    return value.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, name: string) => {
      const found = vars[name];
      if (found === undefined) throw new Error(`unknown scenario variable {{${name}}}`);
      return found;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v: unknown) => resolveTemplates(v, vars)) as T;
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, vars)])) as T;
  return value;
}

export function captureInto(vars: Vars, canonical: string, patterns: Readonly<Record<string, string>> | undefined): void {
  for (const [name, pattern] of Object.entries(patterns ?? {})) {
    const match = new RegExp(pattern).exec(canonical);
    if (match?.[1] === undefined) throw new Error(`capture ${name}: /${pattern}/ did not match ${canonical.slice(0, 400)}`);
    vars[name] = match[1];
  }
}

// -- observations and checks ------------------------------------------------

export interface CoreErrorShape {
  readonly kind: string;
  readonly reason?: string;
}

export type CallResult = { readonly ok: true; readonly content: unknown } | { readonly ok: false; readonly error: CoreErrorShape };

/** What a surface showed the companion and what its tool calls returned. */
export interface TurnObservation {
  readonly turnId: string | null;
  readonly refused: CoreErrorShape | null;
  /** Every piece of context text the companion was shown, as one string. */
  readonly seen: string;
  /** Texts the surface presented as participant speech. */
  readonly speech: readonly string[];
  readonly results: readonly CallResult[];
  /** Variables the turn's calls captured. */
  readonly vars?: Vars;
}

/** The text expectations match: canonical JSON, as JSON.stringify and Python's compact json.dumps both write it. */
export function canonical(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

export function checkResult(expect: ResultExpect | undefined, result: CallResult, at: string): string[] {
  const issues: string[] = [];
  const wantOk = expect?.ok ?? (expect?.error === undefined);
  if (result.ok !== wantOk) {
    issues.push(`${at}: expected ${wantOk ? 'success' : 'a refusal'}, got ${result.ok ? canonical(result.content).slice(0, 300) : JSON.stringify(result.error)}`);
    return issues;
  }
  if (!result.ok) {
    if (expect?.error !== undefined && result.error.kind !== expect.error) issues.push(`${at}: expected error ${expect.error}, got ${JSON.stringify(result.error)}`);
    if (expect?.reason !== undefined && result.error.reason !== expect.reason) issues.push(`${at}: expected reason ${expect.reason}, got ${JSON.stringify(result.error)}`);
    return issues;
  }
  issues.push(...checkText(expect, canonical(result.content), at));
  return issues;
}

export function checkText(expect: Pick<ResultExpect, 'has' | 'lacks' | 'count'> | undefined, text: string, at: string): string[] {
  const issues: string[] = [];
  for (const s of expect?.has ?? []) if (!text.includes(s)) issues.push(`${at}: missing ${JSON.stringify(s)} in ${text.slice(0, 600)}`);
  for (const s of expect?.lacks ?? []) if (text.includes(s)) issues.push(`${at}: must not contain ${JSON.stringify(s)}`);
  for (const [s, n] of Object.entries(expect?.count ?? {})) {
    const found = text.split(s).length - 1;
    if (found !== n) issues.push(`${at}: expected ${String(n)} of ${JSON.stringify(s)}, found ${String(found)} in ${text.slice(0, 1200)}`);
  }
  return issues;
}

export function checkTurn(step: TurnStep, observed: TurnObservation, at: string): string[] {
  const issues: string[] = [];
  if (step.refused !== undefined) {
    if (observed.refused === null) return [`${at}: expected Lite to refuse the turn (${step.refused.error})`];
    if (observed.refused.kind !== step.refused.error) issues.push(`${at}: expected refusal ${step.refused.error}, got ${JSON.stringify(observed.refused)}`);
    if (step.refused.reason !== undefined && observed.refused.reason !== step.refused.reason) issues.push(`${at}: expected reason ${step.refused.reason}, got ${JSON.stringify(observed.refused)}`);
    return issues;
  }
  if (observed.refused !== null) return [`${at}: Lite refused the turn: ${JSON.stringify(observed.refused)}`];
  for (const s of step.sees ?? []) if (!observed.seen.includes(s)) issues.push(`${at}: the companion was not shown ${JSON.stringify(s)}`);
  for (const s of step.hides ?? []) if (observed.seen.includes(s)) issues.push(`${at}: the companion was shown ${JSON.stringify(s)}`);
  for (const s of step.speech ?? []) if (!observed.speech.some((t) => t.includes(s))) issues.push(`${at}: ${JSON.stringify(s)} was not presented as participant speech`);
  for (const s of step.notSpeech ?? []) {
    if (!observed.seen.includes(s)) issues.push(`${at}: ${JSON.stringify(s)} was not shown at all`);
    if (observed.speech.some((t) => t.includes(s))) issues.push(`${at}: ${JSON.stringify(s)} was presented as participant speech`);
  }
  if (step.abandon !== true && step.crash === undefined) {
    const calls = step.calls ?? [];
    if (observed.results.length !== calls.length) issues.push(`${at}: ${String(calls.length)} calls planned, ${String(observed.results.length)} results`);
    calls.forEach((call, i) => {
      const result = observed.results[i];
      if (result !== undefined) issues.push(...checkResult(call.expect, result, `${at} ${call.tool}.${call.action}`));
    });
  }
  return issues;
}

/** Participant-speech blocks of text rendered as labelled blocks (the Pi harness and the Hermes plugin render alike). */
export function participantBlocks(rendered: string): string[] {
  const blocks: string[] = [];
  const pattern = /(?:^|\n\n)\[participant speech\]\n([\s\S]*?)(?=\n\n\[[^\]\n]+\]\n|$)/g;
  // The Pi harness quotes a label-like line inside a block as `\[`; the speech it carries is the unquoted text.
  for (const match of rendered.matchAll(pattern)) if (match[1] !== undefined) blocks.push(match[1].replace(/^([ \t]*)\\\[/gm, '$1['));
  return blocks;
}
