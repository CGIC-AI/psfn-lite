/**
 * The real core stacks over the in-memory fakes, with the Pi harness as the
 * host: the companion harness runs participant and internal turns, and the
 * Pi worker host runs workers, all over a faux model. Integration tests run
 * the same harness over Postgres through the standalone composition.
 */
import {
  BASELINE_FREE_TIME_POLICY,
  createActivityStack,
  createContinuityHandlers,
  createSelfStateHandlers,
  createTurnLifecycle,
  unavailable,
  type InternalTurnPort,
  type Result,
  type TrustedTurnScope,
} from '../../packages/core/src/index.ts';
import {
  createCompanionHarness,
  createPiWorkerHost,
  type CompanionHarness,
  type HarnessLimits,
  type WorkerDiagnostic,
} from '../../packages/pi/src/index.ts';
import { FakeCareReminders, FakeFreeTimeBlocks, FakeReminderDelivery, FakeRestState, FakeScheduledPrompts, FakeTemplates, FakeWorkerEffects, FakeWorkerRuns } from '../core/activity-fakes.ts';
import { FakeModel } from '../core/continuity-fakes.ts';
import { FakeActivityLog, PI } from '../core/fakes.ts';
import { fakeMemoryPorts, memoryWorld } from '../core/memory-world.ts';
import { fakeSelfStatePorts, wireSelfState } from '../core/self-state-world.ts';
import { fauxRuntime, type Brain } from './faux-brain.ts';

export const TURN_LEASE_MS = 60_000;
export const LIMITS: HarnessLimits = { historyEntries: 50, selfStateItems: 10, maxModelCalls: 4, maxToolResultChars: 4_000 };

export async function piWorld(brain: Brain, options: { readonly tokensPerSecond?: number; readonly instance?: string } = {}) {
  const base = await memoryWorld(fakeMemoryPorts());
  base.clock.advance(12 * 3_600_000); // Midday: outside the default quiet hours.
  const selfState = wireSelfState(base, fakeSelfStatePorts());
  const model = fauxRuntime(brain, options);
  const delivered: { scope: TrustedTurnScope; reply: string }[] = [];
  const diagnostics: WorkerDiagnostic[] = [];
  const workerHost = createPiWorkerHost({ runtime: model.runtime, maxToolResultChars: LIMITS.maxToolResultChars, onDiagnostic: (d) => diagnostics.push(d) });

  let harness: CompanionHarness | null = null;
  const internalTurns: InternalTurnPort = {
    run: (request) => (harness === null ? Promise.resolve(unavailable('internal_turns', 'not built')) : harness.internalTurns.run(request)),
  };
  const activity = {
    activities: new FakeActivityLog(),
    workerRuns: new FakeWorkerRuns(),
    workerEffects: new FakeWorkerEffects(),
    restState: new FakeRestState(),
    freeTimeBlocks: new FakeFreeTimeBlocks(),
    scheduledPrompts: new FakeScheduledPrompts(),
    reflectionTemplates: new FakeTemplates(),
    careReminders: new FakeCareReminders(),
  };
  const stack = createActivityStack({
    ...activity,
    catalog: base.catalog,
    ledger: base.ledger,
    workerHost,
    internalTurns,
    reminderDelivery: new FakeReminderDelivery(),
    model: new FakeModel(),
    journal: base.journal,
    memoryAdministration: base.administration,
    freeTimePolicy: BASELINE_FREE_TIME_POLICY,
    clock: base.clock,
    ids: base.ids,
    owner: options.instance ?? 'pi-test',
    workerLeaseMs: 60_000,
    workerMaxAttempts: 2,
    workerResumeGraceMs: 15 * 60_000,
    schedulerInFlightMs: 10 * 60_000,
    handlers: {
      ...createContinuityHandlers({ sessions: base.sessions, contacts: base.contacts, orientation: base.orientation, values: base.values }),
      ...createSelfStateHandlers({ emotion: selfState.emotion, concerns: selfState.concerns, followUps: selfState.followUps }),
      ...base.handlers,
    },
  });
  if (!stack.ok) throw new Error(JSON.stringify(stack.error));
  const lifecycle = createTurnLifecycle({ ledger: base.ledger, archive: base.archive, sessions: base.catalog, clock: base.clock, ids: base.ids, turnLeaseMs: TURN_LEASE_MS });
  if (!lifecycle.ok) throw new Error(JSON.stringify(lifecycle.error));
  const owner = { surface: PI, instance: options.instance ?? 'pi-test' };
  const built = createCompanionHarness({
    ingress: base.ingress,
    lifecycle: lifecycle.value,
    sessions: base.sessions,
    ledger: base.ledger,
    context: { orientation: base.orientation, selfState: selfState.context, archive: base.archive },
    dispatcher: stack.value.dispatcher,
    emotion: selfState.emotion,
    workers: stack.value.workers,
    runtime: model.runtime,
    owner,
    delivery: {
      deliver(scope, reply) {
        delivered.push({ scope, reply });
        return Promise.resolve({ ok: true, value: undefined } as Result<void>);
      },
    },
    limits: LIMITS,
  });
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  harness = built.value;
  const must = async <T = unknown>(scope: TrustedTurnScope, tool: string, action: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await stack.value.dispatcher.dispatch(scope, { tool, action, args });
    if (!result.ok) throw new Error(`${tool}.${action} failed: ${JSON.stringify(result.error)}`);
    return result.value.content as T;
  };
  return { ...base, selfState, stack: stack.value, activity, harness: built.value, lifecycle: lifecycle.value, owner, model, delivered, diagnostics, must };
}

/** All archived entries of a session, oldest first. */
export async function history(w: Awaited<ReturnType<typeof piWorld>>, sessionId: Parameters<typeof w.archive.readTail>[0]) {
  const tail = await w.archive.readTail(sessionId, 1_000);
  if (!tail.ok) throw new Error(JSON.stringify(tail.error));
  return tail.value.map((e) => ({ origin: e.origin.kind, text: e.text }));
}
