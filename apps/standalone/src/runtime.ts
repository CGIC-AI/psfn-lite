/**
 * The standalone composition root: open storage, build every core stack,
 * wire the Pi harness as the host of conversation turns, internal turns and
 * workers, and run the scheduler. `createLiteRuntime` is the one entry; a
 * tool transport can be mounted on the runtime's dispatcher and ingress.
 */
import {
  ok,
  unavailable,
  type Clock,
  type ContactId,
  type EmbeddingPort,
  type IdSource,
  type InternalPurpose,
  type InternalTurnPort,
  type MaintenanceReport,
  type Result,
  type SchedulerTickReport,
  type ToolDispatcher,
  type TrustedIngress,
  type TrustedTurnScope,
  type TurnOwner,
} from './core.ts';
import {
  createCompanionHarness,
  createPiAffectEstimator,
  createPiModelPort,
  createPiWorkerHost,
  type CompanionHarness,
  type PiModelRuntime,
  type TurnReport,
  type WorkerDiagnostic,
} from './harness.ts';
import type { LiteConfig } from './config.ts';
import { createLocalHost, type LocalHost, type OperatorChannel } from './local-host.ts';
import { createTickLoop, type TickLoop } from './tick-loop.ts';
import { buildStacks, refusingApprovals, type LiteStacks } from './stacks.ts';
import { openLiteStorage, type LiteStorage } from './storage.ts';

const OPERATOR_ACTOR = 'standalone:config';

/** What the host supplies: time, ids, the model, embeddings and the operator's channel. */
export interface LiteHostCapabilities {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly model: PiModelRuntime;
  readonly embeddings: EmbeddingPort;
  readonly channel: OperatorChannel;
  /** Names this process lifetime in turn and worker leases; a restart takes a new one. */
  readonly instance: string;
  /** Anything no durable record carries: idle pool errors, worker host notes, background tick results. */
  readonly onDiagnostic: (diagnostic: LiteDiagnostic) => void;
}

export type LiteDiagnostic =
  | { readonly kind: 'pool_idle_error'; readonly message: string }
  | ({ readonly kind: 'worker_host' } & WorkerDiagnostic)
  | { readonly kind: 'tick'; readonly report: Result<LiteTickReport> };

export interface LiteTickReport {
  readonly scheduler: Result<SchedulerTickReport>;
  /** Null on ticks where maintenance is not due. */
  readonly maintenance: Result<MaintenanceReport> | null;
}

export interface LiteRuntime {
  readonly config: LiteConfig;
  readonly owner: TurnOwner;
  readonly storage: LiteStorage;
  readonly stacks: LiteStacks;
  readonly harness: CompanionHarness;
  /** The one governed dispatcher and ingress; a tool transport mounts here. */
  readonly dispatcher: ToolDispatcher;
  readonly ingress: TrustedIngress;
  readonly host: LocalHost;
  /** Registers the configured operator once; an existing contact is left exactly as it is. */
  ensureOperator(): Promise<Result<{ readonly contactId: ContactId; readonly created: boolean }>>;
  /** One operator turn in their direct conversation. */
  converse(input: { readonly text: string; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<Result<TurnReport>>;
  /** A freshly admitted companion-internal scope. */
  internalScope(purpose: InternalPurpose): Promise<Result<TrustedTurnScope>>;
  /** One scheduler pass, plus memory maintenance on every `maintenanceEveryTicks`th tick. */
  tick(): Promise<Result<LiteTickReport>>;
  maintain(): Promise<Result<MaintenanceReport>>;
  /** Runs `tick` every `tickIntervalMs` until `close`. */
  startScheduler(): void;
  /** Stops the scheduler, interrupts running turns (recorded as shutdown), waits for them to settle and closes storage. */
  close(): Promise<void>;
}

export async function createLiteRuntime(input: {
  readonly config: LiteConfig;
  readonly databaseUrl: string;
  readonly host: LiteHostCapabilities;
}): Promise<Result<LiteRuntime>> {
  const { config, host } = input;
  const local = createLocalHost({ surface: config.surface, operator: config.operator, channel: host.channel });
  if (!local.ok) return local;
  const storage = await openLiteStorage({
    storage: config.storage,
    databaseUrl: input.databaseUrl,
    space: config.embedding.space,
    onIdleError: (error) => host.onDiagnostic({ kind: 'pool_idle_error', message: error.message }),
  });
  if (!storage.ok) return storage;

  const model = createPiModelPort(host.model);
  const workerHost = createPiWorkerHost({
    runtime: host.model,
    maxToolResultChars: config.harness.maxToolResultChars,
    onDiagnostic: (diagnostic) => host.onDiagnostic({ kind: 'worker_host', ...diagnostic }),
  });
  // Core's free time and schedules ask for internal turns through this port; the harness exists once the dispatcher does.
  let harness: CompanionHarness | null = null;
  const internalTurns: InternalTurnPort = {
    run: (request) => (harness === null ? Promise.resolve(unavailable('internal_turns', 'the harness is not built yet')) : harness.internalTurns.run(request)),
  };
  const stacks = buildStacks({
    config,
    storage: storage.value,
    clock: host.clock,
    ids: host.ids,
    authenticator: local.value.authenticator,
    approvals: refusingApprovals(),
    model,
    estimator: createPiAffectEstimator(host.model),
    embeddings: host.embeddings,
    workerHost,
    internalTurns,
    reminderDelivery: local.value.reminders,
    instance: host.instance,
  });
  if (!stacks.ok) {
    await storage.value.close();
    return stacks;
  }
  const owner: TurnOwner = { surface: config.surface, instance: host.instance };
  const built = createCompanionHarness({
    ingress: stacks.value.ingress,
    lifecycle: stacks.value.lifecycle,
    sessions: stacks.value.sessions,
    ledger: storage.value.state.ledger,
    context: { orientation: stacks.value.orientation, selfState: stacks.value.selfState, archive: storage.value.archive },
    dispatcher: stacks.value.activity.dispatcher,
    emotion: stacks.value.emotion,
    workers: stacks.value.activity.workers,
    runtime: host.model,
    owner,
    delivery: local.value.replies,
    limits: config.harness,
  });
  if (!built.ok) {
    await storage.value.close();
    return built;
  }
  harness = built.value;
  return ok(assemble({ config, host, local: local.value, storage: storage.value, stacks: stacks.value, harness: built.value, owner }));
}

function assemble(parts: {
  readonly config: LiteConfig;
  readonly host: LiteHostCapabilities;
  readonly local: LocalHost;
  readonly storage: LiteStorage;
  readonly stacks: LiteStacks;
  readonly harness: CompanionHarness;
  readonly owner: TurnOwner;
}): LiteRuntime {
  const { config, host, local, storage, stacks, harness } = parts;
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;
  let ticks = 0;
  let loop: TickLoop | null = null;

  /** Runs work unless the runtime is closing, and keeps it visible to `close`. */
  const track = <T>(work: () => Promise<Result<T>>): Promise<Result<T>> => {
    if (closed) return Promise.resolve(unavailable('lite_runtime', 'the runtime is closed'));
    const running = work();
    inFlight.add(running);
    void running.finally(() => inFlight.delete(running));
    return running;
  };
  const internalScope = (purpose: InternalPurpose) => stacks.ingress.admit(local.internalEvidence(purpose));
  const maintain = () =>
    track(async () => {
      const scope = await internalScope('maintenance');
      if (!scope.ok) return scope;
      return stacks.memory.maintenance.run(scope.value, {
        sessionLimit: config.scheduler.maintenanceSessionLimit,
        maxEntries: config.scheduler.maintenanceMaxEntries,
      });
    });
  const tick = () =>
    track(async (): Promise<Result<LiteTickReport>> => {
      const scope = await internalScope('free_time');
      if (!scope.ok) return scope;
      const scheduler = await stacks.activity.scheduler.tick(scope.value);
      ticks += 1;
      const maintenance = ticks % config.scheduler.maintenanceEveryTicks === 0 ? await maintain() : null;
      return ok({ scheduler, maintenance });
    });

  return {
    config,
    owner: parts.owner,
    storage,
    stacks,
    harness,
    dispatcher: stacks.activity.dispatcher,
    ingress: stacks.ingress,
    host: local,
    ensureOperator: () =>
      track(async (): Promise<Result<{ readonly contactId: ContactId; readonly created: boolean }>> => {
        const identity = { channelKind: config.operator.channelKind, externalId: config.operator.externalId };
        const resolved = await stacks.contactAuthority.resolve(identity);
        if (!resolved.ok) return resolved;
        if (resolved.value.kind === 'known') return ok({ contactId: resolved.value.contactId, created: false });
        if (resolved.value.kind !== 'unknown') {
          return unavailable('operator_contact', `the operator identity resolves as ${resolved.value.kind}; an operator must change it, not the config`);
        }
        const registered = await stacks.contactAdmin.register(OPERATOR_ACTOR, {
          displayName: config.operator.displayName,
          identity,
          trust: config.operator.trust,
          relationship: config.operator.relationship,
          consent: 'granted',
          sensitivity: config.operator.sensitivity,
        });
        return registered.ok ? ok({ contactId: registered.value.contactId, created: true }) : registered;
      }),
    converse: (request) =>
      track(() =>
        harness.converse({
          evidence: local.operatorEvidence(),
          text: request.text,
          idempotencyKey: request.idempotencyKey,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
      ),
    internalScope,
    tick,
    maintain,
    startScheduler() {
      if (closed || loop !== null) return;
      loop = createTickLoop({ intervalMs: config.scheduler.tickIntervalMs, tick: async () => host.onDiagnostic({ kind: 'tick', report: await tick() }) });
      loop.start();
    },
    async close() {
      if (closed) return;
      await loop?.stop();
      closed = true;
      harness.interruptAll('shutdown');
      await Promise.allSettled([...inFlight]);
      await storage.close();
    },
  };
}
