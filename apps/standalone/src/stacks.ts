/**
 * Every core stack over the adapters: continuity (sessions, contacts,
 * identity), memory/episodes/journals, self-state, and the activity stack
 * whose dispatcher serves the companion and every worker. Core's own
 * constructors do the work; this only passes each the ports it names.
 */
import {
  createActivityStack,
  createConcernService,
  createContactAdministration,
  createContactAuthority,
  createContactService,
  createContinuityHandlers,
  createEmotionService,
  createFollowUpService,
  createIdentityAdministration,
  createMemoryStack,
  createOrientationService,
  createSelfStateContext,
  createSelfStateHandlers,
  createSessionService,
  createTrustedIngress,
  createTurnLifecycle,
  createValuesService,
  ok,
  unavailable,
  type AffectEstimatorPort,
  type ApprovalPort,
  type CallerAuthenticatorPort,
  type Clock,
  type EmbeddingPort,
  type IdSource,
  type InternalTurnPort,
  type ModelPort,
  type ReminderDeliveryPort,
  type WorkerHostPort,
} from './core.ts';
import type { LiteConfig } from './config.ts';
import type { LiteStorage } from './storage.ts';

export interface StackInputs {
  readonly config: LiteConfig;
  readonly storage: LiteStorage;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly authenticator: CallerAuthenticatorPort;
  readonly approvals: ApprovalPort;
  readonly model: ModelPort;
  readonly estimator: AffectEstimatorPort;
  readonly embeddings: EmbeddingPort;
  readonly workerHost: WorkerHostPort;
  readonly internalTurns: InternalTurnPort;
  readonly reminderDelivery: ReminderDeliveryPort;
  /** This process; turn and worker leases name it. */
  readonly instance: string;
}

export function buildStacks(input: StackInputs) {
  const { config, storage, clock, ids } = input;
  const { state, archive } = storage;

  const ingress = createTrustedIngress({
    companionId: config.companionId,
    authenticator: input.authenticator,
    contacts: createContactAuthority(state.contacts),
    policy: config.policies.disclosure,
  });
  if (!ingress.ok) return ingress;
  const lifecycle = createTurnLifecycle({ ledger: state.ledger, archive, sessions: state.sessions, clock, ids, turnLeaseMs: config.harness.turnLeaseMs });
  if (!lifecycle.ok) return lifecycle;

  const sessions = createSessionService({
    catalog: state.sessions,
    archive,
    projection: state.projection,
    continuity: state.continuity,
    focus: state.focus,
    model: input.model,
    clock,
    ids,
  });
  const contacts = createContactService({ store: state.contacts, approvals: input.approvals, clock, ids });
  const orientation = createOrientationService({ blocks: state.blocks, layers: state.layers, persona: state.persona, approvals: input.approvals, clock });
  const values = createValuesService({ values: state.values, northStar: state.northStar, clock, ids });

  const memory = createMemoryStack({
    ...storage.memory,
    contacts: state.contacts,
    catalog: state.sessions,
    archive,
    approvals: input.approvals,
    model: input.model,
    embedding: { port: input.embeddings, space: config.embedding.space },
    clock,
    ids,
    endedAfterMs: config.memory.endedAfterMs,
  });
  if (!memory.ok) return memory;

  const emotion = createEmotionService({
    states: storage.selfState.emotionStates,
    appraisals: storage.selfState.appraisals,
    selfReports: storage.selfState.selfReports,
    concerns: storage.selfState.concerns,
    estimator: input.estimator,
    model: input.model,
    ledger: state.ledger,
    archive,
    policy: config.policies.emotion,
    clock,
    ids,
  });
  const concerns = createConcernService({ concerns: storage.selfState.concerns, emotion, clock, ids });
  const followUps = createFollowUpService({ followUps: storage.selfState.followUps, catalog: state.sessions, concerns: storage.selfState.concerns, clock });
  const selfState = createSelfStateContext({ emotion, concerns, followUps, values, reflections: memory.value.reflections });

  const activity = createActivityStack({
    ...storage.activity,
    catalog: state.sessions,
    ledger: state.ledger,
    workerHost: input.workerHost,
    internalTurns: input.internalTurns,
    reminderDelivery: input.reminderDelivery,
    model: input.model,
    journal: memory.value.journal,
    memoryAdministration: memory.value.administration,
    freeTimePolicy: config.policies.freeTime,
    clock,
    ids,
    owner: input.instance,
    workerLeaseMs: config.workers.leaseMs,
    workerMaxAttempts: config.workers.maxAttempts,
    workerResumeGraceMs: config.workers.resumeGraceMs,
    schedulerInFlightMs: config.scheduler.inFlightMs,
    handlers: {
      ...createContinuityHandlers({ sessions, contacts, orientation, values }),
      ...createSelfStateHandlers({ emotion, concerns, followUps }),
      ...memory.value.handlers,
    },
  });
  if (!activity.ok) return activity;

  return ok({
    ingress: ingress.value,
    lifecycle: lifecycle.value,
    sessions,
    contacts,
    contactAdmin: createContactAdministration({ store: state.contacts, clock, ids }),
    contactAuthority: createContactAuthority(state.contacts),
    orientation,
    identityAdmin: createIdentityAdministration({ layers: state.layers, persona: state.persona, clock }),
    values,
    memory: memory.value,
    emotion,
    concerns,
    followUps,
    selfState,
    activity: activity.value,
  });
}

export type LiteStacks = Extract<ReturnType<typeof buildStacks>, { ok: true }>['value'];

/** Standalone has no approval queue yet: a protected change is refused visibly instead of being applied or dropped. */
export function refusingApprovals(): ApprovalPort {
  return {
    submit: () => Promise.resolve(unavailable('approval_queue', 'the standalone host has no approval queue; protected changes are refused')),
  };
}
