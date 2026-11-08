/**
 * The Postgres activity, worker, free-time and scheduling ports over a pool
 * whose schema is already migrated, named as `createActivityStack` takes them
 * so a host can spread them in. Callers see only core port types.
 */
import type pg from 'pg';
import type {
  ActivityLogPort,
  CareReminderPort,
  FreeTimeBlockPort,
  ReflectionTemplatePort,
  RestStatePort,
  ScheduledPromptPort,
  WorkerEffectPort,
  WorkerRunPort,
} from '../core.ts';
import { createPostgresActivityLog, createPostgresWorkerEffects, createPostgresWorkerRuns } from './automata-stores.ts';
import {
  createPostgresCareReminders,
  createPostgresFreeTimeBlocks,
  createPostgresReflectionTemplates,
  createPostgresRestState,
  createPostgresScheduledPrompts,
} from './scheduler-stores.ts';

export interface PostgresActivityStores {
  readonly activities: ActivityLogPort;
  readonly workerRuns: WorkerRunPort;
  readonly workerEffects: WorkerEffectPort;
  readonly restState: RestStatePort;
  readonly freeTimeBlocks: FreeTimeBlockPort;
  readonly scheduledPrompts: ScheduledPromptPort;
  readonly reflectionTemplates: ReflectionTemplatePort;
  readonly careReminders: CareReminderPort;
}

export function createPostgresActivityStores(pool: pg.Pool): PostgresActivityStores {
  return {
    activities: createPostgresActivityLog(pool),
    workerRuns: createPostgresWorkerRuns(pool),
    workerEffects: createPostgresWorkerEffects(pool),
    restState: createPostgresRestState(pool),
    freeTimeBlocks: createPostgresFreeTimeBlocks(pool),
    scheduledPrompts: createPostgresScheduledPrompts(pool),
    reflectionTemplates: createPostgresReflectionTemplates(pool),
    careReminders: createPostgresCareReminders(pool),
  };
}
