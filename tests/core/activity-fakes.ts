/**
 * Test-only fakes of the worker, scheduler and reminder ports, implementing
 * the documented compare-and-set, idempotency and extend-only contracts, and
 * scriptable hosts that count every inference they are asked for.
 */
import {
  conflict,
  denied,
  invalid,
  notFound,
  ok,
  OPEN_FREE_TIME_BLOCK_STATES,
  unavailable,
  type CareReminder,
  type CareReminderPort,
  type FreeTimeBlock,
  type FreeTimeBlockPort,
  type FreeTimeLane,
  type InternalTurnPort,
  type InternalTurnRequest,
  type InternalTurnResult,
  type ReflectionTemplate,
  type ReflectionTemplatePort,
  type ReminderDeliveryPort,
  type RestDecision,
  type RestStatePort,
  type Result,
  type ScheduledPrompt,
  type ScheduledPromptPort,
  type WorkerEffect,
  type WorkerEffectPort,
  type WorkerHostPort,
  type WorkerRun,
  type WorkerRunId,
  type WorkerRunPort,
  type WorkerSession,
} from '../../packages/core/src/index.ts';

const done = <T>(value: T): Promise<T> => Promise.resolve(value);
const stale = (what: string) => conflict('stale_revision', `${what} moved`);
/** As the Postgres stores do: an update advances exactly one revision. */
const skips = (next: { revision: number }, expected: number) => next.revision !== expected + 1;

export class FakeWorkerRuns implements WorkerRunPort {
  readonly runs = new Map<WorkerRunId, WorkerRun>();
  failNextUpdate = false;
  insert(run: WorkerRun) {
    if (this.runs.has(run.id)) return done(conflict('already_exists', `run ${run.id}`));
    this.runs.set(run.id, run);
    return done(ok(run));
  }
  get(id: WorkerRunId) {
    const run = this.runs.get(id);
    return done(run === undefined ? notFound(`worker run ${id}`) : ok(run));
  }
  list(query: Parameters<WorkerRunPort['list']>[0]) {
    const key = (r: { createdAt: string; id: string }) => `${r.createdAt}|${r.id}`;
    const rows = [...this.runs.values()]
      .filter((r) => query.statuses === null || query.statuses.includes(r.status))
      .sort((a, b) => (key(a) < key(b) ? 1 : -1))
      .filter((r) => query.after === null || key(r) < key(query.after));
    return done(ok(rows.slice(0, query.limit)));
  }
  expired(now: string, limit: number) {
    const rows = [...this.runs.values()]
      .filter((r) => r.status === 'running' && r.lease !== null && r.lease.until < now)
      .sort((a, b) => ((a.lease?.until ?? '') < (b.lease?.until ?? '') ? -1 : 1));
    return done(ok(rows.slice(0, limit)));
  }
  update(next: WorkerRun, expectedRevision: number) {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      return done(unavailable('worker_runs', 'store unavailable'));
    }
    if (skips(next, expectedRevision)) return done(invalid('a worker run update must advance one revision'));
    if (this.runs.get(next.id)?.revision !== expectedRevision) return done(stale(`run ${next.id}`));
    this.runs.set(next.id, next);
    return done(ok(next));
  }
}

export class FakeWorkerEffects implements WorkerEffectPort {
  readonly effects: WorkerEffect[] = [];
  /** Simulates a crash after the effect ran but before its outcome was recorded. */
  failNextSettle = false;
  begin(effect: WorkerEffect) {
    const existing = this.effects.find((e) => e.runId === effect.runId && e.effectKey === effect.effectKey);
    if (existing !== undefined) return done(ok({ effect: existing, created: false }));
    this.effects.push(effect);
    return done(ok({ effect, created: true }));
  }
  settle(next: WorkerEffect) {
    if (this.failNextSettle) {
      this.failNextSettle = false;
      return done(unavailable('worker_effects', 'crashed before the outcome was recorded'));
    }
    const index = this.effects.findIndex((e) => e.runId === next.runId && e.effectKey === next.effectKey);
    if (index === -1 || this.effects[index]?.phase !== 'started') return done(stale(`effect ${next.effectKey}`));
    this.effects[index] = next;
    return done(ok(next));
  }
  list(runId: WorkerRunId) {
    return done(ok(this.effects.filter((e) => e.runId === runId)));
  }
}

export class FakeRestState implements RestStatePort {
  readonly lanes = new Map<FreeTimeLane, RestDecision>();
  unavailable = false;
  read(lane: FreeTimeLane): Promise<Result<RestDecision | null>> {
    return done(this.unavailable ? unavailable('rest_state', 'down') : ok(this.lanes.get(lane) ?? null));
  }
  extend(lane: FreeTimeLane, decision: RestDecision) {
    const current = this.lanes.get(lane);
    if (current === undefined || current.until < decision.until) this.lanes.set(lane, decision);
    return done(ok(this.lanes.get(lane) ?? decision));
  }
}

export class FakeFreeTimeBlocks implements FreeTimeBlockPort {
  readonly blocks = new Map<string, FreeTimeBlock>();
  create(block: FreeTimeBlock) {
    if (this.blocks.has(block.id)) return done(conflict('already_exists', `block ${block.id}`));
    const open = (b: FreeTimeBlock) => (OPEN_FREE_TIME_BLOCK_STATES as readonly string[]).includes(b.state);
    if (open(block) && [...this.blocks.values()].some(open)) return done(conflict('turn_already_open', 'another free-time block is open'));
    this.blocks.set(block.id, block);
    return done(ok(block));
  }
  get(id: string) {
    const block = this.blocks.get(id);
    return done(block === undefined ? notFound(`free-time block ${id}`) : ok(block));
  }
  recent(lane: FreeTimeLane, limit: number) {
    const rows = [...this.blocks.values()].filter((b) => b.lane === lane).sort((a, b) => (`${a.invitedAt}|${a.id}` < `${b.invitedAt}|${b.id}` ? 1 : -1));
    return done(ok(rows.slice(0, limit)));
  }
  update(next: FreeTimeBlock, expectedRevision: number) {
    if (skips(next, expectedRevision)) return done(invalid('a free-time block update must advance one revision'));
    if (this.blocks.get(next.id)?.revision !== expectedRevision) return done(stale(`block ${next.id}`));
    this.blocks.set(next.id, next);
    return done(ok(next));
  }
}

export class FakeScheduledPrompts implements ScheduledPromptPort {
  readonly prompts = new Map<string, ScheduledPrompt>();
  create(prompt: ScheduledPrompt) {
    const existing = this.prompts.get(prompt.id);
    if (existing !== undefined) return done(ok({ prompt: existing, created: false }));
    this.prompts.set(prompt.id, prompt);
    return done(ok({ prompt, created: true }));
  }
  get(id: string) {
    const prompt = this.prompts.get(id);
    return done(prompt === undefined ? notFound(`scheduled prompt ${id}`) : ok(prompt));
  }
  list(query: Parameters<ScheduledPromptPort['list']>[0]) {
    const key = (p: { runAt: string; id: string }) => `${p.runAt}|${p.id}`;
    const rows = [...this.prompts.values()]
      .filter((p) => query.states === null || query.states.includes(p.state))
      .filter((p) => query.dueAtOrBefore === null || p.runAt <= query.dueAtOrBefore)
      .sort((a, b) => (key(a) < key(b) ? -1 : 1))
      .filter((p) => query.after === null || key(p) > key(query.after));
    return done(ok(rows.slice(0, query.limit)));
  }
  update(next: ScheduledPrompt, expectedRevision: number) {
    if (skips(next, expectedRevision)) return done(invalid('a scheduled prompt update must advance one revision'));
    if (this.prompts.get(next.id)?.revision !== expectedRevision) return done(stale(`prompt ${next.id}`));
    this.prompts.set(next.id, next);
    return done(ok(next));
  }
}

export class FakeTemplates implements ReflectionTemplatePort {
  readonly templates = new Map<string, ReflectionTemplate>();
  get(id: string) {
    const template = this.templates.get(id);
    return done(template === undefined ? notFound(`reflection template ${id}`) : ok(template));
  }
  list(limit: number) {
    return done(ok([...this.templates.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit)));
  }
  put(next: ReflectionTemplate, expectedRevision: number) {
    const actual = this.templates.get(next.id)?.revision ?? 0;
    if (skips(next, expectedRevision)) return done(invalid('a reflection template write must advance one revision'));
    if (actual !== expectedRevision) return done(stale(`template ${next.id}`));
    this.templates.set(next.id, next);
    return done(ok(next));
  }
}

export class FakeCareReminders implements CareReminderPort {
  readonly reminders = new Map<string, CareReminder>();
  create(reminder: CareReminder) {
    const existing = this.reminders.get(reminder.id);
    if (existing !== undefined) return done(ok({ reminder: existing, created: false }));
    this.reminders.set(reminder.id, reminder);
    return done(ok({ reminder, created: true }));
  }
  get(id: string) {
    const reminder = this.reminders.get(id);
    return done(reminder === undefined ? notFound(`care reminder ${id}`) : ok(reminder));
  }
  list(query: Parameters<CareReminderPort['list']>[0]) {
    const key = (r: { dueAt: string; id: string }) => `${r.dueAt}|${r.id}`;
    const rows = [...this.reminders.values()]
      .filter((r) => query.states === null || query.states.includes(r.state))
      .filter((r) => query.dueAtOrBefore === null || r.dueAt <= query.dueAtOrBefore)
      .sort((a, b) => (key(a) < key(b) ? -1 : 1))
      .filter((r) => query.after === null || key(r) > key(query.after));
    return done(ok(rows.slice(0, query.limit)));
  }
  update(next: CareReminder, expectedRevision: number) {
    if (skips(next, expectedRevision)) return done(invalid('a care reminder update must advance one revision'));
    if (this.reminders.get(next.id)?.revision !== expectedRevision) return done(stale(`reminder ${next.id}`));
    this.reminders.set(next.id, next);
    return done(ok(next));
  }
}

/**
 * Channel delivery. `fail` refuses definitely (nothing sent); `ambiguous`
 * sends and then reports a timeout, as a host would after a transport error;
 * `hold` parks each delivery until the test releases it.
 */
export class FakeReminderDelivery implements ReminderDeliveryPort {
  readonly delivered: CareReminder[] = [];
  /** Every call, whatever its outcome. */
  readonly calls: CareReminder[] = [];
  fail = false;
  ambiguous = false;
  hold: Promise<void> | null = null;
  async deliver(reminder: CareReminder): Promise<Result<void>> {
    this.calls.push(reminder);
    if (this.fail) return denied('blocked_contact', 'the channel refused the message');
    if (this.hold !== null) await this.hold;
    this.delivered.push(reminder);
    return this.ambiguous ? unavailable('channel', 'timeout after send') : ok(undefined);
  }
}

/**
 * A scripted harness for companion-internal turns. Each run is one model
 * inference; the script decides what the companion does in that turn (for
 * example calling free_time tools through the dispatcher).
 */
export class FakeInternalTurns implements InternalTurnPort {
  readonly requests: InternalTurnRequest[] = [];
  script: (request: InternalTurnRequest) => Promise<Result<InternalTurnResult>> = () => done(ok({ status: 'completed', reply: null }));
  run(request: InternalTurnRequest): Promise<Result<InternalTurnResult>> {
    this.requests.push(request);
    return this.script(request);
  }
}

/**
 * A scripted worker harness. `start` accepts the attempt and keeps the
 * session; `loop` runs it on demand, so tests can crash, retry or recover
 * between steps. Every turn begun is counted as one model call.
 */
export class FakeWorkerHost implements WorkerHostPort {
  readonly sessions: WorkerSession[] = [];
  readonly cancelled: WorkerRunId[] = [];
  refuse = false;
  /** Runs the session to completion inside `start` when set. */
  autoRun: ((session: WorkerSession) => Promise<void>) | null = null;
  async start(session: WorkerSession): Promise<Result<void>> {
    if (this.refuse) return unavailable('worker_host', 'no capacity');
    this.sessions.push(session);
    if (this.autoRun !== null) await this.autoRun(session);
    return ok(undefined);
  }
  cancel(runId: WorkerRunId) {
    this.cancelled.push(runId);
    return done(ok(undefined));
  }
  latest(): WorkerSession {
    const session = this.sessions.at(-1);
    if (session === undefined) throw new Error('no worker session started');
    return session;
  }
}
