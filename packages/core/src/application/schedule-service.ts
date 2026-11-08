import {
  isTimeZone,
  nextDailyInstant,
  zonedInstant,
  type ReflectionTemplate,
  type ReflectionTemplatePort,
  type ScheduledPrompt,
  type ScheduledPromptPort,
  type TemplateSchedule,
} from '../scheduler/index.ts';
import { conflict, denied, invalid, notFound, ok, unavailable, type Clock, type Result } from '../shared/index.ts';
import type { InternalTurnPort, ModelPort } from './host-ports.ts';
import type { JournalService } from './journal-service.ts';
import { collectPaged } from './paging.ts';
import { authorOf, isTrustedTurnScope, type TrustedTurnScope } from './trusted-scope.ts';
import { digest } from './turn-history.ts';

const NAME_MAX = 120;
const PROMPT_MAX = 4_000;
const TEMPLATE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TEMPLATES_MAX = 100;
const DUE_BATCH = 20;
const REFLECTION_TOKENS = 800;

export type TemplateRunOutcome =
  | { readonly state: 'completed'; readonly template: ReflectionTemplate; readonly reflectionId: string; readonly replayed: boolean }
  | { readonly state: 'deferred'; readonly template: ReflectionTemplate }
  | { readonly state: 'failed' | 'interrupted'; readonly template: ReflectionTemplate; readonly detail: string | null };

export interface ScheduleRunReport {
  readonly prompts: readonly { readonly id: string; readonly state: ScheduledPrompt['state'] }[];
  readonly templates: readonly { readonly id: string; readonly state: TemplateRunOutcome['state'] }[];
}

export interface ScheduleService {
  list(scope: TrustedTurnScope, input: { readonly limit: number }): Promise<Result<{ readonly prompts: readonly ScheduledPrompt[]; readonly templates: readonly ReflectionTemplate[] }>>;
  schedulePrompt(
    scope: TrustedTurnScope,
    input: { readonly key: string; readonly name: string; readonly prompt: string; readonly at: string; readonly timeZone: string },
  ): Promise<Result<{ readonly prompt: ScheduledPrompt; readonly created: boolean }>>;
  updateTemplate(
    scope: TrustedTurnScope,
    input: {
      readonly templateId: string;
      readonly expectedRevision: number;
      readonly name: string | null;
      readonly prompt: string | null;
      readonly schedule: TemplateSchedule | null;
      readonly enabled: boolean | null;
    },
  ): Promise<Result<ReflectionTemplate>>;
  runTemplate(scope: TrustedTurnScope, input: { readonly templateId: string; readonly key: string }): Promise<Result<TemplateRunOutcome>>;
  /** Runs due self-prompts and templates; called by the scheduler in a companion-internal turn. */
  runDue(scope: TrustedTurnScope): Promise<Result<ScheduleRunReport>>;
}

/**
 * Self-scheduled time (donor `src/core/scheduler/schedule-tool.ts`,
 * `scheduled-prompts.ts`, `reflection-policy.ts`). Times carry an explicit
 * IANA zone. Every run is fenced the same way: marked running before the
 * work, so a crash leaves it `interrupted` and it is never repeated. A
 * template is run inline only from the companion's own self turn and when no
 * other run of it is in flight; otherwise the run is deferred to the
 * scheduler.
 */
export function createScheduleService(deps: {
  readonly prompts: ScheduledPromptPort;
  readonly templates: ReflectionTemplatePort;
  readonly turns: InternalTurnPort;
  readonly model: ModelPort;
  readonly journal: JournalService;
  readonly clock: Clock;
}): ScheduleService {
  const nowIso = () => deps.clock.now().toISOString();
  const isSelf = (scope: TrustedTurnScope) => scope.audience.kind === 'self' && scope.caller.kind === 'companion_internal';
  const trusted = (scope: TrustedTurnScope): Result<void> =>
    isTrustedTurnScope(scope) ? ok(undefined) : denied('unknown_authority', 'scope was not admitted by ingress');

  const putTemplate = (template: ReflectionTemplate, changes: Partial<ReflectionTemplate>) =>
    deps.templates.put({ ...template, ...changes, updatedAt: nowIso(), revision: template.revision + 1 }, template.revision);

  /** One fenced template run in a self turn: running, then the companion's reflection, then completed. */
  const runNow = async (scope: TrustedTurnScope, template: ReflectionTemplate, key: string, changes: Partial<ReflectionTemplate> = {}): Promise<Result<TemplateRunOutcome>> => {
    const reflectionId = `reflection:${template.id}:${digest(key).slice(0, 24)}`;
    const running = await putTemplate(template, { ...changes, pendingRun: null, lastRun: { key, state: 'running', reflectionId: null, at: nowIso(), detail: null } });
    if (!running.ok) return running;
    const reply = await deps.model.complete({
      attribution: { purpose: `reflection_template:${template.id}`, turnId: null, output: 'companion_turn' },
      messages: [{ role: 'labelled_context', label: `reflection template ${template.name}`, text: template.prompt }],
      maxOutputTokens: REFLECTION_TOKENS,
    });
    const text = reply.ok ? reply.value.text.trim() : '';
    const recorded = reply.ok && text.length > 0 ? await deps.journal.recordReflection(scope, { reflectionId, templateId: template.id, kind: 'companion_reflection', text }) : null;
    if (recorded === null || !recorded.ok) {
      const detail = !reply.ok ? `model ${reply.error.kind}` : recorded === null ? 'the reflection was empty' : `journal ${recorded.error.kind}`;
      const failed = await putTemplate(running.value, { lastRun: { key, state: 'failed', reflectionId: null, at: nowIso(), detail } });
      return failed.ok ? ok({ state: 'failed', template: failed.value, detail }) : failed;
    }
    const done = await putTemplate(running.value, { lastRun: { key, state: 'completed', reflectionId: recorded.value.id, at: nowIso(), detail: null } });
    return done.ok ? ok({ state: 'completed', template: done.value, reflectionId: recorded.value.id, replayed: false }) : done;
  };

  /** A run left `running` by a crash: recorded as interrupted, never resumed. */
  const closeStranded = async (template: ReflectionTemplate): Promise<Result<ReflectionTemplate>> => {
    if (template.lastRun?.state !== 'running') return ok(template);
    return putTemplate(template, { lastRun: { ...template.lastRun, state: 'interrupted', detail: 'the run was cut off; not repeated' } });
  };

  const parseSchedule = (schedule: TemplateSchedule): Result<string | null> => {
    if (schedule.kind === 'manual') return ok(null);
    const next = nextDailyInstant(schedule.localTime, schedule.timeZone, deps.clock.now().getTime());
    return next.ok ? ok(new Date(next.value).toISOString()) : next;
  };

  return {
    async list(scope, input) {
      const t = trusted(scope);
      if (!t.ok) return t;
      const prompts = await collectPaged({
        fetch: (after, pageSize) => deps.prompts.list({ states: null, dueAtOrBefore: null, limit: pageSize, after }),
        cursorOf: (p: ScheduledPrompt) => ({ runAt: p.runAt, id: p.id }),
        keep: () => true,
        limit: input.limit,
      });
      if (!prompts.ok) return prompts;
      const templates = await deps.templates.list(TEMPLATES_MAX);
      return templates.ok ? ok({ prompts: prompts.value, templates: templates.value }) : templates;
    },

    async schedulePrompt(scope, input) {
      const t = trusted(scope);
      if (!t.ok) return t;
      if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'scheduled prompts are companion-authored');
      const name = input.name.trim();
      const prompt = input.prompt.trim();
      if (name.length === 0 || name.length > NAME_MAX) return invalid(`name must be 1-${NAME_MAX} characters`);
      if (prompt.length === 0 || prompt.length > PROMPT_MAX) return invalid(`prompt must be 1-${PROMPT_MAX} characters`);
      const at = zonedInstant(input.at, input.timeZone);
      if (!at.ok) return at;
      if (at.value <= deps.clock.now().getTime()) return invalid('a scheduled prompt must be in the future');
      const requestDigest = digest({ name, prompt, at: input.at, timeZone: input.timeZone });
      const created = await deps.prompts.create({
        id: `scheduled_prompt:${digest(input.key).slice(0, 32)}`,
        requestDigest,
        name,
        prompt,
        runAt: new Date(at.value).toISOString(),
        timeZone: input.timeZone,
        localTime: input.at,
        state: 'pending',
        author: authorOf(scope),
        createdAt: nowIso(),
        firedAt: null,
        outcome: null,
        revision: 1,
      });
      if (!created.ok) return created;
      if (!created.value.created && created.value.prompt.requestDigest !== requestDigest) {
        return conflict('idempotency_mismatch', 'this schedule key was already used for a different prompt');
      }
      return created;
    },

    async updateTemplate(scope, input) {
      const t = trusted(scope);
      if (!t.ok) return t;
      if (!TEMPLATE_ID.test(input.templateId)) return invalid('templateId must be 1-64 characters of [a-z0-9_-]');
      if (input.name !== null && (input.name.trim().length === 0 || input.name.length > NAME_MAX)) return invalid(`name must be 1-${NAME_MAX} characters`);
      if (input.prompt !== null && (input.prompt.trim().length === 0 || input.prompt.length > PROMPT_MAX)) return invalid(`prompt must be 1-${PROMPT_MAX} characters`);
      if (input.schedule?.kind === 'daily' && !isTimeZone(input.schedule.timeZone)) return invalid(`unknown time zone ${input.schedule.timeZone}`);
      const existing = await deps.templates.get(input.templateId);
      if (!existing.ok && existing.error.kind !== 'not_found') return existing;
      // The next run is computed before anything is written, so a schedule that cannot be placed changes nothing.
      if (!existing.ok) {
        if (input.expectedRevision !== 0) return notFound(`reflection template ${input.templateId}`);
        if (input.name === null || input.prompt === null || input.schedule === null) return invalid('a new template needs name, prompt and schedule');
        const next = parseSchedule(input.schedule);
        if (!next.ok) return next;
        return deps.templates.put(
          {
            id: input.templateId,
            name: input.name.trim(),
            prompt: input.prompt.trim(),
            schedule: input.schedule,
            enabled: input.enabled ?? true,
            nextRunAt: next.value,
            lastRun: null,
            pendingRun: null,
            updatedAt: nowIso(),
            revision: 1,
          },
          0,
        );
      }
      const template = existing.value;
      if (template.revision !== input.expectedRevision) {
        return conflict('stale_revision', `reflection template ${template.id} moved`, { expectedRevision: input.expectedRevision, actualRevision: template.revision });
      }
      const schedule = input.schedule ?? template.schedule;
      const next = input.schedule === null ? ok(template.nextRunAt) : parseSchedule(schedule);
      if (!next.ok) return next;
      return putTemplate(template, {
        name: input.name?.trim() ?? template.name,
        prompt: input.prompt?.trim() ?? template.prompt,
        schedule,
        enabled: input.enabled ?? template.enabled,
        nextRunAt: next.value,
      });
    },

    async runTemplate(scope, input) {
      const t = trusted(scope);
      if (!t.ok) return t;
      if (input.key.trim().length === 0 || input.key.length > 200) return invalid('key must be 1-200 characters');
      const found = await deps.templates.get(input.templateId);
      if (!found.ok) return found;
      const template = found.value;
      const last = template.lastRun;
      if (last?.key === input.key) {
        if (last.state === 'completed') {
          return last.reflectionId === null
            ? unavailable('reflection_template', `run ${input.key} completed without a reflection id`)
            : ok({ state: 'completed', template, reflectionId: last.reflectionId, replayed: true });
        }
        if (last.state !== 'running') return ok({ state: last.state, template, detail: last.detail });
      }
      if (!template.enabled) return invalid(`reflection template ${template.id} is disabled`);
      if (template.pendingRun?.key === input.key) return ok({ state: 'deferred', template });
      // Busy: another run of this template is in flight, or this is not the companion's own self turn.
      if (!isSelf(scope) || last?.state === 'running') {
        const deferred = await putTemplate(template, { pendingRun: { key: input.key, requestedAt: nowIso() } });
        return deferred.ok ? ok({ state: 'deferred', template: deferred.value }) : deferred;
      }
      return runNow(scope, template, input.key);
    },

    async runDue(scope) {
      if (!isTrustedTurnScope(scope) || !isSelf(scope)) return denied('requires_self_audience', 'scheduled work runs in companion-internal turns');
      const report = { prompts: [] as { id: string; state: ScheduledPrompt['state'] }[], templates: [] as { id: string; state: TemplateRunOutcome['state'] }[] };

      const stranded = await deps.prompts.list({ states: ['running'], dueAtOrBefore: null, limit: DUE_BATCH, after: null });
      if (!stranded.ok) return stranded;
      for (const prompt of stranded.value) {
        const closed = await deps.prompts.update({ ...prompt, state: 'interrupted', outcome: 'the run was cut off; not repeated', revision: prompt.revision + 1 }, prompt.revision);
        if (!closed.ok) return closed;
        report.prompts.push({ id: prompt.id, state: 'interrupted' });
      }
      const due = await deps.prompts.list({ states: ['pending'], dueAtOrBefore: nowIso(), limit: DUE_BATCH, after: null });
      if (!due.ok) return due;
      for (const prompt of due.value) {
        const running = await deps.prompts.update({ ...prompt, state: 'running', firedAt: nowIso(), revision: prompt.revision + 1 }, prompt.revision);
        if (!running.ok) return running;
        const ran = await deps.turns.run({ scope, purpose: 'scheduled_prompt', prompt: `Scheduled for ${prompt.localTime} ${prompt.timeZone} (${prompt.name}): ${prompt.prompt}`, reference: { kind: 'scheduled_prompt', id: prompt.id } });
        const state = ran.ok && ran.value.status === 'completed' ? 'completed' : ran.ok && ran.value.status === 'interrupted' ? 'interrupted' : 'failed';
        const outcome = ran.ok ? `turn ${ran.value.status}` : `turn could not run: ${ran.error.kind}`;
        const settled = await deps.prompts.update({ ...running.value, state, outcome, revision: running.value.revision + 1 }, running.value.revision);
        if (!settled.ok) return settled;
        report.prompts.push({ id: prompt.id, state });
      }

      const templates = await deps.templates.list(TEMPLATES_MAX);
      if (!templates.ok) return templates;
      const nowMs = deps.clock.now().getTime();
      for (const listed of templates.value) {
        const template = await closeStranded(listed);
        if (!template.ok) return template;
        if (listed.lastRun?.state === 'running') report.templates.push({ id: listed.id, state: 'interrupted' });
        const t = template.value;
        if (!t.enabled) continue;
        const scheduledDue = t.nextRunAt !== null && Date.parse(t.nextRunAt) <= nowMs;
        if (t.pendingRun === null && !scheduledDue) continue;
        const key = t.pendingRun?.key ?? `scheduled:${t.nextRunAt ?? ''}`;
        let nextRunAt = t.nextRunAt;
        if (scheduledDue && t.schedule.kind === 'daily') {
          const next = nextDailyInstant(t.schedule.localTime, t.schedule.timeZone, nowMs);
          if (!next.ok) return next;
          nextRunAt = new Date(next.value).toISOString();
        }
        const ran = await runNow(scope, t, key, { nextRunAt });
        if (!ran.ok) return ran;
        report.templates.push({ id: t.id, state: ran.value.state });
      }
      return ok(report);
    },
  };
}
