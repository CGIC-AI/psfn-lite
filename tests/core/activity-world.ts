/**
 * The memory world plus self-state and the real activity, automata and
 * scheduler stack, with the one dispatcher it builds over every domain's
 * handlers. Ports are pluggable so the same wiring runs over the fakes here
 * and over the Postgres stores in integration tests.
 */
import {
  BASELINE_FREE_TIME_POLICY,
  createActivityStack,
  createContinuityHandlers,
  createSelfStateHandlers,
  type ActivityLogPort,
  type CareReminderPort,
  type FreeTimeBlockPort,
  type FreeTimePolicy,
  type ReflectionTemplatePort,
  type RestStatePort,
  type ScheduledPromptPort,
  type TrustedTurnScope,
  type WorkerEffectPort,
  type WorkerRunPort,
} from '../../packages/core/src/index.ts';
import {
  FakeCareReminders,
  FakeFreeTimeBlocks,
  FakeInternalTurns,
  FakeReminderDelivery,
  FakeRestState,
  FakeScheduledPrompts,
  FakeTemplates,
  FakeWorkerEffects,
  FakeWorkerHost,
  FakeWorkerRuns,
} from './activity-fakes.ts';
import { FakeModel } from './continuity-fakes.ts';
import { FakeActivityLog } from './fakes.ts';
import { fakeMemoryPorts, memoryWorld, type MemoryPorts } from './memory-world.ts';
import { fakeSelfStatePorts, wireSelfState } from './self-state-world.ts';

export interface ActivityPorts {
  readonly activities: ActivityLogPort;
  readonly workerRuns: WorkerRunPort;
  readonly workerEffects: WorkerEffectPort;
  readonly restState: RestStatePort;
  readonly freeTimeBlocks: FreeTimeBlockPort;
  readonly scheduledPrompts: ScheduledPromptPort;
  readonly reflectionTemplates: ReflectionTemplatePort;
  readonly careReminders: CareReminderPort;
}

export function fakeActivityPorts() {
  return {
    activities: new FakeActivityLog(),
    workerRuns: new FakeWorkerRuns(),
    workerEffects: new FakeWorkerEffects(),
    restState: new FakeRestState(),
    freeTimeBlocks: new FakeFreeTimeBlocks(),
    scheduledPrompts: new FakeScheduledPrompts(),
    reflectionTemplates: new FakeTemplates(),
    careReminders: new FakeCareReminders(),
  };
}

/** Hosts the world runs against; each counts the inference it is asked for. */
export function fakeHosts() {
  return { workerHost: new FakeWorkerHost(), internalTurns: new FakeInternalTurns(), reminderDelivery: new FakeReminderDelivery(), templateModel: new FakeModel() };
}

export const WORKER_LEASE_MS = 60_000;
/** A queued run nothing drives for this long settles as `not_resumed`. */
export const WORKER_RESUME_GRACE_MS = 15 * 60_000;
export const SCHEDULER_IN_FLIGHT_MS = 10 * 60_000;

export async function activityWorld<A extends ActivityPorts, M extends MemoryPorts>(
  activityPorts: A,
  memoryPorts: M,
  options: { readonly policy?: FreeTimePolicy; readonly owner?: string; readonly hosts?: ReturnType<typeof fakeHosts> } = {},
) {
  const base = await memoryWorld(memoryPorts);
  const selfState = wireSelfState(base, fakeSelfStatePorts());
  const hosts = options.hosts ?? fakeHosts();
  const stack = createActivityStack({
    ...activityPorts,
    catalog: base.catalog,
    ledger: base.ledger,
    workerHost: hosts.workerHost,
    internalTurns: hosts.internalTurns,
    reminderDelivery: hosts.reminderDelivery,
    model: hosts.templateModel,
    journal: base.journal,
    memoryAdministration: base.administration,
    freeTimePolicy: options.policy ?? BASELINE_FREE_TIME_POLICY,
    clock: base.clock,
    ids: base.ids,
    owner: options.owner ?? 'host-a',
    workerLeaseMs: WORKER_LEASE_MS,
    workerMaxAttempts: 2,
    workerResumeGraceMs: WORKER_RESUME_GRACE_MS,
    schedulerInFlightMs: SCHEDULER_IN_FLIGHT_MS,
    handlers: {
      ...createContinuityHandlers({ sessions: base.sessions, contacts: base.contacts, orientation: base.orientation, values: base.values }),
      ...createSelfStateHandlers({ emotion: selfState.emotion, concerns: selfState.concerns, followUps: selfState.followUps }),
      ...base.handlers,
    },
  });
  if (!stack.ok) throw new Error(JSON.stringify(stack.error));
  const call = (scope: TrustedTurnScope, tool: string, action: string, args: Record<string, unknown> = {}) =>
    stack.value.dispatcher.dispatch(scope, { tool, action, args });
  const must = async <T = unknown>(scope: TrustedTurnScope, tool: string, action: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await call(scope, tool, action, args);
    if (!result.ok) throw new Error(`${tool}.${action} failed: ${JSON.stringify(result.error)}`);
    return result.value.content as T;
  };
  return { ...base, ...selfState, ...hosts, ...activityPorts, ...stack.value, stack: stack.value, call, must };
}

export const fakeActivityWorld = (options: Parameters<typeof activityWorld>[2] = {}) => activityWorld(fakeActivityPorts(), fakeMemoryPorts(), options);
