import type { ActivityLogPort } from '../activity/index.ts';
import type { WorkerEffectPort, WorkerRunPort } from '../automata/index.ts';
import type { CareReminderPort } from '../intention/index.ts';
import type { FreeTimeBlockPort, FreeTimePolicy, ReflectionTemplatePort, RestStatePort, ScheduledPromptPort } from '../scheduler/index.ts';
import type { SessionCatalogPort, TurnLedgerPort } from '../sessions/index.ts';
import { invalid, ok, unavailable, type Clock, type IdSource, type Result } from '../shared/index.ts';
import { createActivityService, type ActivityService } from './activity.ts';
import { createAutomataService } from './automata-service.ts';
import { createCareReminderService, type CareReminderService } from './care-reminder-service.ts';
import { currentTurnOf } from './current-turn.ts';
import { createToolDispatcher, type ActionHandler, type ActionHandlers, type ToolDispatcher } from './dispatch.ts';
import { createFreeTimeService, type FreeTimeService } from './free-time-service.ts';
import { activityHandlers, automataHandlers } from './handlers-automata.ts';
import { freeTimeHandlers, reminderHandlers } from './handlers-scheduler.ts';
import type { InternalTurnPort, ModelPort, ReminderDeliveryPort } from './host-ports.ts';
import type { JournalService } from './journal-service.ts';
import type { MemoryAdministration } from './memory-administration.ts';
import { createScheduleService, type ScheduleService } from './schedule-service.ts';
import { createSchedulerTick, type SchedulerTick } from './scheduler-tick.ts';
import { TOOL_INVENTORY } from './tool-inventory.ts';
import { createWorkerReview, type WorkerReview } from './worker-review.ts';
import { createWorkerRunner, type WorkerRunner } from './worker-runner.ts';
import type { WorkerHostPort } from './worker-session.ts';

/** The ports the activity, automata and scheduler stack needs. Each service still takes only its own subset. */
export interface ActivityStackDeps {
  readonly activities: ActivityLogPort;
  readonly workerRuns: WorkerRunPort;
  readonly workerEffects: WorkerEffectPort;
  readonly restState: RestStatePort;
  readonly freeTimeBlocks: FreeTimeBlockPort;
  readonly scheduledPrompts: ScheduledPromptPort;
  readonly reflectionTemplates: ReflectionTemplatePort;
  readonly careReminders: CareReminderPort;
  readonly catalog: SessionCatalogPort;
  readonly ledger: TurnLedgerPort;
  readonly workerHost: WorkerHostPort;
  readonly internalTurns: InternalTurnPort;
  readonly reminderDelivery: ReminderDeliveryPort;
  readonly model: ModelPort;
  /** The memory stack's journal and administration: free time and templates record reflections, review decides staged writes. */
  readonly journal: JournalService;
  readonly memoryAdministration: MemoryAdministration;
  readonly freeTimePolicy: FreeTimePolicy;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** This host instance; worker leases name it. */
  readonly owner: string;
  readonly workerLeaseMs: number;
  readonly workerMaxAttempts: number;
  /**
   * Every other domain's handlers (continuity, self-state, memory). Workers
   * dispatch through the same dispatcher as the companion, so the stack
   * builds it over these and its own handlers.
   */
  readonly handlers: ActionHandlers;
}

export interface ActivityStack {
  /** The one dispatcher for every tool, including activity, automata, free_time and `concern.reminder_create`. */
  readonly dispatcher: ToolDispatcher;
  readonly handlers: ActionHandlers;
  readonly activity: ActivityService;
  readonly workers: WorkerRunner;
  readonly review: WorkerReview;
  readonly freeTime: FreeTimeService;
  readonly schedule: ScheduleService;
  readonly reminders: CareReminderService;
  readonly scheduler: SchedulerTick;
}

/**
 * Composes activity, bounded workers, free time, self-scheduling and care
 * reminders from explicit ports, and the dispatcher every surface and every
 * worker uses. There is no in-memory fallback for any port.
 */
export function createActivityStack(deps: ActivityStackDeps): Result<ActivityStack> {
  const { clock, ids } = deps;
  const locate = currentTurnOf({ catalog: deps.catalog, ledger: deps.ledger });
  const activity = createActivityService({ log: deps.activities, clock, ids });
  const reminders = createCareReminderService({ reminders: deps.careReminders, catalog: deps.catalog, delivery: deps.reminderDelivery, clock });
  const schedule = createScheduleService({
    prompts: deps.scheduledPrompts,
    templates: deps.reflectionTemplates,
    turns: deps.internalTurns,
    model: deps.model,
    journal: deps.journal,
    clock,
  });
  const freeTime = createFreeTimeService({
    blocks: deps.freeTimeBlocks,
    rest: deps.restState,
    activities: deps.activities,
    catalog: deps.catalog,
    locate,
    turns: deps.internalTurns,
    journal: deps.journal,
    policy: deps.freeTimePolicy,
    clock,
    ids,
  });

  // Workers dispatch through the dispatcher this stack builds; it exists once the handlers below do.
  let dispatcher: ToolDispatcher | null = null;
  const lateDispatcher: ToolDispatcher = {
    dispatch: (scope, call) => (dispatcher === null ? Promise.resolve(unavailable('dispatcher', 'the dispatcher is not built yet')) : dispatcher.dispatch(scope, call)),
  };
  const runner = createWorkerRunner({
    runs: deps.workerRuns,
    effects: deps.workerEffects,
    activities: deps.activities,
    dispatcher: lateDispatcher,
    host: deps.workerHost,
    locate,
    clock,
    owner: deps.owner,
    leaseMs: deps.workerLeaseMs,
    maxAttempts: deps.workerMaxAttempts,
  });
  if (!runner.ok) return runner;
  const automata = createAutomataService({ runner: runner.value, runs: deps.workerRuns, effects: deps.workerEffects, clock });

  const own: ActionHandlers = {
    activity: activityHandlers(activity, locate),
    automata: automataHandlers(automata),
    free_time: freeTimeHandlers(freeTime, schedule),
    concern: reminderHandlers(reminders),
  };
  const merged = mergeHandlers(deps.handlers, own);
  if (!merged.ok) return merged;
  const built = createToolDispatcher({ inventory: TOOL_INVENTORY, handlers: merged.value });
  if (!built.ok) return built;
  dispatcher = built.value;

  return ok({
    dispatcher: built.value,
    handlers: merged.value,
    activity,
    workers: runner.value,
    review: createWorkerReview({ runs: deps.workerRuns, memory: deps.memoryAdministration }),
    freeTime,
    schedule,
    reminders,
    scheduler: createSchedulerTick({ workers: runner.value, reminders, schedule, freeTime }),
  });
}

/** Merges handler maps per tool; two handlers for one action are refused, not overridden. */
export function mergeHandlers(...maps: readonly ActionHandlers[]): Result<ActionHandlers> {
  const out: Record<string, Record<string, ActionHandler>> = {};
  const issues: string[] = [];
  for (const map of maps) {
    for (const [tool, actions] of Object.entries(map)) {
      const target = (out[tool] ??= {});
      for (const [action, handler] of Object.entries(actions)) {
        if (Object.hasOwn(target, action)) issues.push(`two handlers for ${tool}.${action}`);
        target[action] = handler;
      }
    }
  }
  return issues.length > 0 ? invalid(...issues) : ok(out);
}
