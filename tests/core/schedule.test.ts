import { describe, expect, it } from 'vitest';
import type { CareReminder, ReflectionTemplate, ScheduledPrompt, TrustedTurnScope, WorkerRun } from '../../packages/core/src/index.ts';
import { fakeActivityWorld, SCHEDULER_IN_FLIGHT_MS } from './activity-world.ts';
import { kindOf } from './memory-world.ts';

type World = Awaited<ReturnType<typeof fakeActivityWorld>>;
const HOUR = 3_600_000;

async function tick(w: World, scope: TrustedTurnScope) {
  const ran = await w.scheduler.tick(scope);
  if (!ran.ok) throw new Error(JSON.stringify(ran.error));
  return ran.value;
}

const PROMPT = { scheduleId: 'garden-1', name: 'garden', prompt: 'Look back at the garden notes', at: '2030-01-01T09:30', timeZone: 'America/New_York' };

describe('self-scheduled prompts', () => {
  it('schedules in an explicit zone, idempotently, and refuses impossible or past times', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    const first = await w.must<{ prompt: ScheduledPrompt; created: boolean }>(self, 'free_time', 'schedule_prompt', PROMPT);
    expect(first).toMatchObject({ created: true, prompt: { runAt: '2030-01-01T14:30:00.000Z', state: 'pending', localTime: '2030-01-01T09:30' } });
    const again = await w.must<{ prompt: ScheduledPrompt; created: boolean }>(self, 'free_time', 'schedule_prompt', PROMPT);
    expect(again).toMatchObject({ created: false, prompt: { id: first.prompt.id } });
    const reused = await w.call(self, 'free_time', 'schedule_prompt', { ...PROMPT, prompt: 'Something else' });
    expect(reused.ok || reused.error).toMatchObject({ kind: 'conflict', reason: 'idempotency_mismatch' });
    // 02:30 does not exist in New York on the spring-forward day.
    expect(kindOf(await w.call(self, 'free_time', 'schedule_prompt', { ...PROMPT, scheduleId: 'dst', at: '2030-03-10T02:30' }))).toBe('invalid');
    expect(kindOf(await w.call(self, 'free_time', 'schedule_prompt', { ...PROMPT, scheduleId: 'tz', timeZone: 'Mars/Olympus' }))).toBe('invalid');
    expect(kindOf(await w.call(self, 'free_time', 'schedule_prompt', { ...PROMPT, scheduleId: 'past', at: '2029-12-31T09:30' }))).toBe('invalid');
    expect(w.scheduledPrompts.prompts.size).toBe(1);
  });

  it('fires a due prompt once in a companion turn and never repeats one a crash cut off', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    const { prompt } = await w.must<{ prompt: ScheduledPrompt }>(self, 'free_time', 'schedule_prompt', PROMPT);
    await w.must(self, 'free_time', 'schedule_prompt', { ...PROMPT, scheduleId: 'garden-2', at: '2030-01-01T10:30' });
    // Before it is due, ticks ask for nothing.
    await tick(w, self);
    expect(w.internalTurns.requests.filter((r) => r.purpose === 'scheduled_prompt')).toHaveLength(0);

    w.clock.advance(14 * HOUR + 31 * 60_000);
    const fired = await tick(w, self);
    expect(fired.schedule).toMatchObject({ ok: true, value: { prompts: [{ id: prompt.id, state: 'completed' }] } });
    const turns = w.internalTurns.requests.filter((r) => r.purpose === 'scheduled_prompt');
    expect(turns).toHaveLength(1);
    expect(turns[0]?.reference).toEqual({ kind: 'scheduled_prompt', id: prompt.id });
    await tick(w, self);
    expect(w.internalTurns.requests.filter((r) => r.purpose === 'scheduled_prompt')).toHaveLength(1);

    // The second prompt's turn dies mid-run; the next tick records it as interrupted and does not run it again.
    w.clock.advance(HOUR);
    w.internalTurns.script = (request) => (request.purpose === 'scheduled_prompt' ? Promise.reject(new Error('crash')) : Promise.resolve({ ok: true, value: { status: 'completed', reply: null } }));
    await expect(w.schedule.runDue(self)).rejects.toThrow('crash');
    w.internalTurns.script = () => Promise.resolve({ ok: true, value: { status: 'completed', reply: null } });
    // Inside its in-flight window the marker may still belong to a running pass, so it is left alone.
    const early = await w.schedule.runDue(self);
    expect(early.ok && early.value.prompts).toEqual([]);
    w.clock.advance(SCHEDULER_IN_FLIGHT_MS);
    const recovered = await w.schedule.runDue(self);
    expect(recovered.ok && recovered.value.prompts.map((p) => p.state)).toEqual(['interrupted']);
    expect(w.internalTurns.requests.filter((r) => r.purpose === 'scheduled_prompt')).toHaveLength(2);
  });

  it('runs scheduled work only from companion-internal turns', async () => {
    const w = await fakeActivityWorld();
    const denied = await w.schedule.runDue(await w.admit('primary-dm'));
    expect(denied.ok || denied.error).toMatchObject({ kind: 'denied', reason: 'requires_self_audience' });
  });
});

const DAILY = { templateId: 'evening', expectedRevision: 0, name: 'evening', prompt: 'What mattered today?', schedule: { kind: 'daily', localTime: '07:00', timeZone: 'UTC' } };

describe('reflection templates', () => {
  it('creates and updates with revisions, and a schedule that cannot be placed changes nothing', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    expect(kindOf(await w.call(self, 'free_time', 'update_template', { ...DAILY, schedule: { kind: 'daily', localTime: '07:00', timeZone: 'Mars/Olympus' } }))).toBe('invalid');
    expect(w.reflectionTemplates.templates.size).toBe(0);
    const created = await w.must<ReflectionTemplate>(self, 'free_time', 'update_template', DAILY);
    expect(created).toMatchObject({ revision: 1, enabled: true, nextRunAt: '2030-01-01T07:00:00.000Z' });
    expect(kindOf(await w.call(self, 'free_time', 'update_template', { templateId: 'evening', expectedRevision: 1, schedule: { kind: 'daily', localTime: '25:00', timeZone: 'UTC' } }))).toBe('invalid');
    expect(w.reflectionTemplates.templates.get('evening')).toEqual(created);
    const stale = await w.call(self, 'free_time', 'update_template', { templateId: 'evening', expectedRevision: 0, name: 'night' });
    expect(kindOf(stale)).toBe('conflict');
    const renamed = await w.must<ReflectionTemplate>(self, 'free_time', 'update_template', { templateId: 'evening', expectedRevision: 1, name: 'night' });
    expect(renamed).toMatchObject({ name: 'night', revision: 2, nextRunAt: created.nextRunAt });
  });

  it('defers a run requested outside a self turn, runs it once from the scheduler and replays by run id', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    const primary = await w.admit('primary-dm');
    await w.must(self, 'free_time', 'update_template', { ...DAILY, schedule: { kind: 'manual' } });
    w.templateModel.reply = 'Today the small things carried the most weight.';

    const deferred = await w.must<{ state: string }>(primary, 'free_time', 'run_template', { templateId: 'evening', runId: 'run-1' });
    expect(deferred.state).toBe('deferred');
    expect(w.templateModel.calls).toHaveLength(0);
    await tick(w, self);
    expect(w.templateModel.calls).toHaveLength(1);
    expect(w.templateModel.calls[0]?.attribution).toMatchObject({ output: 'companion_turn' });
    const replay = await w.must<{ state: string; replayed: boolean; reflectionId: string }>(self, 'free_time', 'run_template', { templateId: 'evening', runId: 'run-1' });
    expect(replay).toMatchObject({ state: 'completed', replayed: true });
    // The world's `reflections` is the self-model's reader over the journal store.
    const authored = await w.reflections.recent(5);
    expect(authored.ok && authored.value.map((r) => [r.id, r.text])).toEqual([[replay.reflectionId, 'Today the small things carried the most weight.']]);
    // Manual templates are not run by ticks on their own.
    await tick(w, self);
    expect(w.templateModel.calls).toHaveLength(1);
  });

  it('runs a daily template once per day and records a cut-off run as interrupted', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    await w.must(self, 'free_time', 'update_template', DAILY);
    await tick(w, self);
    expect(w.templateModel.calls).toHaveLength(0);
    w.clock.advance(7 * HOUR + 60_000);
    await tick(w, self);
    await tick(w, self);
    expect(w.templateModel.calls).toHaveLength(1);
    expect(w.reflectionTemplates.templates.get('evening')?.nextRunAt).toBe('2030-01-02T07:00:00.000Z');

    const current = w.reflectionTemplates.templates.get('evening') as ReflectionTemplate;
    w.reflectionTemplates.templates.set('evening', { ...current, lastRun: { key: 'scheduled:x', state: 'running', reflectionId: null, at: w.clock.now().toISOString(), detail: null } });
    const busy = await w.schedule.runDue(self);
    expect(busy.ok && busy.value.templates).toEqual([]);
    expect(w.reflectionTemplates.templates.get('evening')?.lastRun?.state).toBe('running');
    w.clock.advance(SCHEDULER_IN_FLIGHT_MS);
    const closed = await w.schedule.runDue(self);
    expect(closed.ok && closed.value.templates).toEqual([{ id: 'evening', state: 'interrupted' }]);
    expect(w.reflectionTemplates.templates.get('evening')?.lastRun?.state).toBe('interrupted');
    expect(w.templateModel.calls).toHaveLength(1);
  });
});

const REMINDER = { kind: 'check_in', title: 'Check in', content: 'Ask how the interview went', dueAt: '2030-01-01T12:00:00.000Z' };

describe('care reminders', () => {
  it('creates once per target, text and time, and only for the companion itself', async () => {
    const w = await fakeActivityWorld();
    const primary = await w.admit('primary-dm');
    const first = await w.must<{ reminder: CareReminder; created: boolean }>(primary, 'concern', 'reminder_create', REMINDER);
    expect(first).toMatchObject({ created: true, reminder: { state: 'pending', schedule: 'once', target: primary.audience } });
    const again = await w.must<{ reminder: CareReminder; created: boolean }>(primary, 'concern', 'reminder_create', REMINDER);
    expect(again).toMatchObject({ created: false, reminder: { id: first.reminder.id } });
    expect(kindOf(await w.call(primary, 'concern', 'reminder_create', { ...REMINDER, dueAt: 'tomorrow' }))).toBe('invalid');

    const spawned = await w.must<{ run: WorkerRun }>(primary, 'automata', 'spawn', { spawnId: 's-1', label: 'helper', task: 'Help', actions: ['memory.search'], maxTurns: 1, maxSensitivity: 'personal' });
    const worker = w.workerHost.latest().scope;
    expect(spawned.run.id).toBe(w.workerHost.latest().run.id);
    const viaService = await w.reminders.create(worker, { ...REMINDER, kind: 'check_in', schedule: 'once', channelId: null });
    expect(viaService.ok || viaService.error).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });
    expect(kindOf(await w.call(worker, 'concern', 'reminder_create', REMINDER))).toBe('denied');
    expect(w.careReminders.reminders.size).toBe(1);
  });

  it('delivers a due reminder once, keeps a refused one pending and re-arms a daily one', async () => {
    const w = await fakeActivityWorld();
    const primary = await w.admit('primary-dm');
    const self = await w.admit('free-time');
    const once = await w.must<{ reminder: CareReminder }>(primary, 'concern', 'reminder_create', REMINDER);
    const daily = await w.must<{ reminder: CareReminder }>(primary, 'concern', 'reminder_create', { ...REMINDER, kind: 'self_care', title: 'Water', content: 'Drink water', schedule: 'daily' });
    await tick(w, self);
    expect(w.reminderDelivery.delivered).toHaveLength(0);

    w.clock.advance(12 * HOUR);
    w.reminderDelivery.fail = true;
    const refused = await tick(w, self);
    expect(refused.reminders.ok && refused.reminders.value.failed.map((f) => f.id).sort()).toEqual([once.reminder.id, daily.reminder.id].sort());
    expect(w.careReminders.reminders.get(once.reminder.id)?.state).toBe('pending');

    w.reminderDelivery.fail = false;
    await tick(w, self);
    await tick(w, self);
    expect(w.reminderDelivery.delivered.map((r) => r.id).sort()).toEqual([once.reminder.id, daily.reminder.id].sort());
    expect(w.careReminders.reminders.get(once.reminder.id)).toMatchObject({ state: 'delivered', deliveries: 1 });
    expect(w.careReminders.reminders.get(daily.reminder.id)).toMatchObject({ state: 'pending', deliveries: 1, dueAt: '2030-01-02T12:00:00.000Z' });
    w.clock.advance(24 * HOUR);
    await tick(w, self);
    expect(w.reminderDelivery.delivered).toHaveLength(3);
  });

  it('records an ambiguous delivery as unknown and never sends it again; a daily one moves to its next day', async () => {
    const w = await fakeActivityWorld();
    const primary = await w.admit('primary-dm');
    const self = await w.admit('free-time');
    const once = await w.must<{ reminder: CareReminder }>(primary, 'concern', 'reminder_create', REMINDER);
    const daily = await w.must<{ reminder: CareReminder }>(primary, 'concern', 'reminder_create', { ...REMINDER, kind: 'self_care', title: 'Water', content: 'Drink water', schedule: 'daily' });
    w.clock.advance(12 * HOUR);
    w.reminderDelivery.ambiguous = true;
    const report = await tick(w, self);
    expect(report.reminders.ok && [...report.reminders.value.unknown].sort()).toEqual([once.reminder.id, daily.reminder.id].sort());
    w.reminderDelivery.ambiguous = false;
    await tick(w, self);
    await tick(w, self);
    expect(w.reminderDelivery.calls).toHaveLength(2);
    expect(w.careReminders.reminders.get(once.reminder.id)).toMatchObject({ state: 'delivery_unknown', deliveries: 0, unknownDeliveries: 1 });
    expect(w.careReminders.reminders.get(daily.reminder.id)).toMatchObject({ state: 'pending', dueAt: '2030-01-02T12:00:00.000Z', unknownDeliveries: 1 });
    w.clock.advance(24 * HOUR);
    await tick(w, self);
    expect(w.reminderDelivery.calls).toHaveLength(3);
    expect(w.reminderDelivery.calls.filter((r) => r.id === daily.reminder.id)).toHaveLength(2);
    expect(w.careReminders.reminders.get(daily.reminder.id)).toMatchObject({ state: 'pending', deliveries: 1, unknownDeliveries: 1, dueAt: '2030-01-03T12:00:00.000Z' });
  });

  it('leaves a delivery another pass has in flight alone, so it is neither marked unknown nor sent twice', async () => {
    const w = await fakeActivityWorld();
    const primary = await w.admit('primary-dm');
    const self = await w.admit('free-time');
    const { reminder } = await w.must<{ reminder: CareReminder }>(primary, 'concern', 'reminder_create', { ...REMINDER, schedule: 'daily' });
    w.clock.advance(12 * HOUR);
    let release = () => {};
    w.reminderDelivery.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = w.scheduler.tick(self);
    while (w.reminderDelivery.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const overlapping = await tick(w, self);
    expect(overlapping.reminders).toEqual({ ok: true, value: { delivered: [], failed: [], unknown: [], contended: [] } });
    release();
    w.reminderDelivery.hold = null;
    const held = await first;
    expect(held.ok && held.value.reminders).toMatchObject({ ok: true, value: { delivered: [reminder.id] } });
    expect(w.careReminders.reminders.get(reminder.id)).toMatchObject({ state: 'pending', deliveries: 1, unknownDeliveries: 0 });
    for (let day = 0; day < 3; day += 1) {
      w.clock.advance(24 * HOUR);
      await tick(w, self);
    }
    expect(w.reminderDelivery.calls).toHaveLength(4);
  });

  it('runs a due prompt once when two scheduler passes overlap', async () => {
    const w = await fakeActivityWorld();
    const self = await w.admit('free-time');
    const { prompt } = await w.must<{ prompt: ScheduledPrompt }>(self, 'free_time', 'schedule_prompt', PROMPT);
    w.clock.advance(14 * HOUR + 31 * 60_000);
    const [a, b] = await Promise.all([w.schedule.runDue(self), w.schedule.runDue(self)]);
    if (!a.ok || !b.ok) throw new Error('runDue');
    expect([...a.value.prompts, ...b.value.prompts]).toEqual([{ id: prompt.id, state: 'completed' }]);
    expect([...a.value.contended, ...b.value.contended]).toEqual([prompt.id]);
    expect(w.internalTurns.requests.filter((r) => r.purpose === 'scheduled_prompt')).toHaveLength(1);
  });

  it('never re-sends a delivery a crash left unconfirmed', async () => {
    const w = await fakeActivityWorld();
    const primary = await w.admit('primary-dm');
    const self = await w.admit('free-time');
    const { reminder } = await w.must<{ reminder: CareReminder }>(primary, 'concern', 'reminder_create', REMINDER);
    w.clock.advance(12 * HOUR);
    w.careReminders.reminders.set(reminder.id, { ...reminder, state: 'delivering', deliveryStartedAt: w.clock.now().toISOString(), revision: reminder.revision + 1 });
    // A marker inside its in-flight window may be another pass delivering right now.
    const early = await tick(w, self);
    expect(early.reminders.ok && early.reminders.value.unknown).toEqual([]);
    expect(w.careReminders.reminders.get(reminder.id)?.state).toBe('delivering');
    w.clock.advance(SCHEDULER_IN_FLIGHT_MS);
    const report = await tick(w, self);
    expect(report.reminders.ok && report.reminders.value.unknown).toEqual([reminder.id]);
    expect(w.careReminders.reminders.get(reminder.id)?.state).toBe('delivery_unknown');
    expect(w.reminderDelivery.delivered).toHaveLength(0);
  });
});
