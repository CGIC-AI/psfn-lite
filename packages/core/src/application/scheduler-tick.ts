import { FREE_TIME_LANES } from '../scheduler/index.ts';
import { denied, ok, type Result } from '../shared/index.ts';
import type { CareReminderService, ReminderDeliveryReport } from './care-reminder-service.ts';
import type { FreeTimeRunReport, FreeTimeService } from './free-time-service.ts';
import type { ScheduleRunReport, ScheduleService } from './schedule-service.ts';
import { isTrustedTurnScope, type TrustedTurnScope } from './trusted-scope.ts';
import type { SweepReport, WorkerRunner } from './worker-runner.ts';

/** What one tick did. Each part reports its own failure; one failing part does not hide the others. */
export interface SchedulerTickReport {
  readonly workers: Result<SweepReport>;
  readonly resumedWorkers: Result<number>;
  readonly reminders: Result<ReminderDeliveryReport>;
  readonly schedule: Result<ScheduleRunReport>;
  readonly freeTime: readonly Result<FreeTimeRunReport>[];
}

export interface SchedulerTick {
  /** One pass in a companion-internal turn. With nothing due, it makes no model call and opens no turn. */
  tick(scope: TrustedTurnScope): Promise<Result<SchedulerTickReport>>;
}

/**
 * The scheduler pass the host runs on a timer: recover expired worker
 * attempts and resume queued scheduled workers through the shared runner,
 * deliver due care reminders, run due self-prompts and reflection templates,
 * then offer free time on each lane through its deterministic gate.
 */
export function createSchedulerTick(deps: {
  readonly workers: WorkerRunner;
  readonly reminders: CareReminderService;
  readonly schedule: ScheduleService;
  readonly freeTime: FreeTimeService;
}): SchedulerTick {
  return {
    async tick(scope) {
      if (!isTrustedTurnScope(scope) || scope.audience.kind !== 'self' || scope.caller.kind !== 'companion_internal') {
        return denied('requires_self_audience', 'the scheduler runs in companion-internal turns');
      }
      const workers = await deps.workers.sweep();
      const resumed = await deps.workers.resume(scope);
      const reminders = await deps.reminders.deliverDue(scope);
      const schedule = await deps.schedule.runDue(scope);
      const freeTime: Result<FreeTimeRunReport>[] = [];
      for (const lane of FREE_TIME_LANES) freeTime.push(await deps.freeTime.runLane(scope, lane));
      return ok({ workers, resumedWorkers: resumed.ok ? ok(resumed.value.length) : resumed, reminders, schedule, freeTime });
    },
  };
}
