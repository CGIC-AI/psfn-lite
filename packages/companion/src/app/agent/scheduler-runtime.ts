// Lite cut (seam 3.11, extraction/cuts.tsv): the donor agent scheduler
// runtime minus the database backup lane, the runtime health detector
// scheduler, the CogSec blind-review lane, the multi-companion shared-world
// wiki caretaker, the companion presence heartbeat beat and the fleet
// maintenance baton. The gateway client is replaced by the in-process
// LLMProviderPort and the embedding dimension.
import { randomUUID } from 'node:crypto';

import { wirePostTurnActionRuntime } from '../startup/composition/post-turn-actions.js';
import type { PostTurnActionRuntime } from '../../core/agent/post-turn-action-runtime.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { SalienceDecay } from '../../faculties/memory/decay.js';
import type {
  BiographyStageControl,
  BiographySynthesisService,
} from '../../faculties/memory/biographical/synthesis-service.js';
import type { BiographyCompanionReviewService } from '../../faculties/memory/biographical/companion-review-service.js';
import { createDefaultBiographicalDepthPolicy } from '../../system/config/biographical-depth-policy.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { resolveHealthEventOwner } from '../../shared/contracts/health-event.js';
import {
  registerAmbientPresenceOperation,
} from '../../core/scheduler/ambient-presence.js';
import {
  BackgroundMaintenanceRegistry,
  type BackgroundMaintenanceRegistrar,
} from '../../core/scheduler/background-maintenance.js';
import {
  registerConcernGroomingOperation,
  resolveCurrentInternalStateConcernVAD,
} from '../../core/intention/concern-grooming.js';
import { createDefaultConcernRouteDispatcher } from './concern-route-wiring.js';
import type { ConcernStorePort } from '../../core/intention/concern-store-port.js';
import {
  registerConcernReviewSupervisorTask,
  type ConcernReviewSupervisorWorkerPort,
} from '../../core/intention/concern-review-supervisor.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { DoingMirrorService } from '../../core/doing-mirror/service.js';
import {
  SocialGraphBuilderWorker,
  createSocialGraphBuilderMemoryReader,
  SOCIAL_GRAPH_BUILDER_OPERATION_ID,
} from '../../faculties/memory/social-graph/graph-builder-worker.js';
import type {
  SocialGraphProposalStore,
  SocialGraphBuilderWatermarkStore,
} from '../../faculties/memory/social-graph/proposals.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { CompanionAvailabilityRuntime } from '../../core/agent/companion-availability.js';
import { emitGardenQueueChanged } from '../../shared/garden-queue-change.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { SessionManager } from '../../core/session/manager.js';
import {
  createCompressionGuidelineEvolution,
  type CompressionGuidelineEvolutionPort,
} from '../../core/session/compression-guideline-evolution.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import {
  BACKGROUND_WORK_SUPERVISOR_TASK_ID,
  registerDurableBackgroundWorkSupervisorTask,
} from '../../core/agent/background-work/scheduler-task.js';
import type { SchedulerRuntimeConfig } from '../../system/config/scheduler-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { SENSITIVITY_LEVELS } from '../../system/trust/types.js';
import type { AutomataBusReviewerTaskPort } from '../../faculties/automata/bus/reviewer-service.js';
import type { ProductionAutomataClassId } from '../../faculties/automata/registry-contract.js';
import {
  runGovernedAutomataClass,
  type AutomataClassLifecycleRuntime,
  type AutomataClassWorkResult,
} from '../../faculties/automata/bus/class-lifecycle.js';
import {
  resolvePostTurnActionQueuePath,
  type RuntimePathSnapshot,
} from '../../persistence/layout.js';

const log = createComponentLogger('Agent');
export { BACKGROUND_WORK_SUPERVISOR_TASK_ID };
export const AUTOMATA_BUS_REVIEWER_TASK_ID = 'automata-bus-reviewer';
const AUTOMATA_BUS_REVIEWER_CLASS: ProductionAutomataClassId = 'scheduler.automata_bus_reviewer';
const AUTOMATA_BUS_REVIEWER_BRIEFING_QUERY = 'automata bus evidence review consistency';
const SOCIAL_GRAPH_BUILDER_CLASS: ProductionAutomataClassId = 'memory.social_graph_builder';
const SOCIAL_GRAPH_BUILDER_BRIEFING_QUERY = 'social graph proposal evidence scan';
const BIOGRAPHY_SYNTHESIS_CLASS: ProductionAutomataClassId = 'memory.biography_synthesis';
const BIOGRAPHY_SYNTHESIS_BRIEFING_QUERY = 'portable biography candidate synthesis evidence';
const BIOGRAPHY_REVIEW_CLASS: ProductionAutomataClassId = 'memory.biography_review';
const BIOGRAPHY_REVIEW_BRIEFING_QUERY = 'companion biography candidate self review';
export const AUTOMATA_RETENTION_OPERATION_ID = 'automata-raw-session-retention';

export interface AgentSchedulerRuntime {
  scheduler: Scheduler;
  postTurnActions: PostTurnActionRuntime;
  backgroundMaintenance: BackgroundMaintenanceRegistrar;
  compressionGuidelineEvolution: CompressionGuidelineEvolutionPort;
}

export interface BuildAgentSchedulerRuntimeOptions {
  eventBus: EventBus;
  eligibilityGate: EligibilityGate;
  config: SubstrateConfig;
  schedulerConfig: SchedulerRuntimeConfig;
  sessionManager: SessionManager;
  llmProvider: LLMProviderPort;
  /** Embedding dimension, for the startup log line (donor: gateway.dims). */
  embeddingDims: number;
  memoryStore: MemoryStorePort;
  agentLoop: SubstrateAgent;
  concernStore?: ConcernStorePort | null;
  concernReviewWorker?: ConcernReviewSupervisorWorkerPort | null;
  pathSnapshot: RuntimePathSnapshot;
  // ── Social-graph builder worker (E4.2) ──
  contactStore?: ContactStorePort | null;
  socialGraphProposalStore?: SocialGraphProposalStore | null;
  socialGraphWatermarkStore?: SocialGraphBuilderWatermarkStore | null;
  companionAvailability?: Pick<CompanionAvailabilityRuntime, 'run'>;
  automataReviewer?: {
    task: AutomataBusReviewerTaskPort;
    companionId: string;
  };
  /** Composition-owned governed Bus lifecycle shared by this file's automata lanes. */
  automataLifecycle?: AutomataClassLifecycleRuntime;
  automataRetention?: { runBounded(nowMs?: number): Promise<unknown> };
  /** Cross-silo biography candidate synthesis lane (o61vb.12). */
  biographySynthesis?: Pick<BiographySynthesisService, 'run'>;
  /** Companion protected self-review of biography candidates (o61vb.13). */
  biographyCompanionReview?: Pick<BiographyCompanionReviewService, 'run'>;
  /** Doing-mirror disposition lifecycle whose Letter deliveries this lane redrives. */
  doingMirrorService: Pick<DoingMirrorService, 'drainPendingLetters'>;
}

export function registerAutomataBusReviewerTask(input: {
  scheduler: Scheduler;
  task: AutomataBusReviewerTaskPort;
  automataLifecycle: AutomataClassLifecycleRuntime;
  companionId: string;
}): void {
  if (!input.task.enabled) return;
  input.scheduler.register({
    id: AUTOMATA_BUS_REVIEWER_TASK_ID,
    name: 'Automata Bus Evidence Reviewer',
    description:
      'Nominates bounded Bus consistency candidates and appends only complete evidence-citing review decisions.',
    scheduleSource: 'automata-policy.json > bus.reviewer.cadenceMs',
    type: 'every',
    intervalMs: input.task.cadenceMs,
    availability: 'do_not_disturb',
    state: 'idle',
    handler: async () => {
      const runId = `automata-bus-review:${randomUUID()}`;
      await runGovernedAutomataClass({
        runtime: input.automataLifecycle,
        spec: {
          automatonClass: AUTOMATA_BUS_REVIEWER_CLASS,
          runId,
          workerId: AUTOMATA_BUS_REVIEWER_TASK_ID,
          taskId: AUTOMATA_BUS_REVIEWER_TASK_ID,
          taskLabel: 'Review Automata Bus evidence',
          taskSummary: 'Nominate and review a bounded batch of duplicate, contradiction, stale-evidence, and orphan-provenance candidates.',
        },
        briefingQuery: AUTOMATA_BUS_REVIEWER_BRIEFING_QUERY,
        work: async () => {
          const report = await input.task.run({
            companionId: input.companionId,
            runId,
            audience: 'operator',
            maxSensitivity: SENSITIVITY_LEVELS.at(-1)!,
          });
          // The reviewer writes its decisions through the governed mutation
          // adapters rather than the worker tool, so the run would otherwise
          // settle as a typed no-finding. The class-authored process summary is
          // what makes its terminal handoff useful and queryable.
          return {
            value: report,
            summary: `Automata Bus review: attempted=${report.attempted} `
              + `skippedHandled=${report.skippedHandled} health=${report.health}`,
          };
        },
      });
    },
  }, { skipFirstRun: true });
}

export function registerSalienceDecayOperation(input: {
  backgroundMaintenance: BackgroundMaintenanceRegistrar;
  memoryStore: MemoryStorePort;
  config?: SubstrateConfig;
}): void {
  const salienceDecay = new SalienceDecay(input.memoryStore, {
    ...(input.config
      ? { memoryRetrievalPolicy: () => input.config?.memoryRetrievalPolicy }
      : {}),
  });
  input.backgroundMaintenance.registerOperation({
    id: 'salience-decay',
    name: 'Memory Salience Decay',
    description: 'Applies the configured memory weight decay pass to durable memories.',
    handler: () => salienceDecay.run(),
    eligibility: { requiredTokens: ['memory.write'] },
  });
}

export const BIOGRAPHY_COMPANION_REVIEW_TASK_ID = 'biography-companion-review';

/**
 * Companion protected self-review of biography candidates (o61vb.13).
 *
 * This is the companion's own pass over proposals about itself, so it runs as
 * its own protected task rather than on the shared maintenance lane: the
 * `do_not_disturb` availability keeps it out of live conversation, and the
 * cadence is the owner-file biography refresh interval rather than a new
 * tuning value. It stages review decisions only; activation stays with owner
 * policy and human review.
 */
/**
 * Fleet-serialized ownership for one biography stage (o61vb.16).
 *
 * Both stages are heavy background cognition, so exactly one companion in the
 * fleet runs one at a time. The stage keeps its own content and durable
 * cursors; this helper owns only the baton, the safe-boundary checkpoints, and
 * translating the result into a governed terminal handoff. A pass that never
 * won the baton did no work and settles as a typed no-finding rather than a
 * useful one.
 *
 * Resume cadence limit: a scheduler `every` task has no per-run reschedule
 * hook, so a preempted or baton-blocked pass resumes on the next owner-file
 * biography tick rather than after `retryDelayMs`. Nothing is lost — the
 * durable stage cursors hold the progress — but the remainder waits a full
 * cadence.
 */
async function runBiographyStageUnderBaton<
  T extends { readonly outcome: 'complete' | 'yield' },
>(input: {
  phase: string;
  label: string;
  run: (control: BiographyStageControl) => Promise<T>;
  summarize: (telemetry: T) => string;
}): Promise<AutomataClassWorkResult<T | undefined>> {
  // Lite: a single-companion deployment has no baton to contend for, so no
  // safe-boundary hook is supplied and the stage cannot be asked to yield
  // (the donor's no-fleetMaintenance branch).
  const telemetry = await input.run({});
  if (telemetry.outcome === 'yield') {
    throw new Error(
      `${input.label} yielded without fleet maintenance authority to yield to`,
    );
  }
  return { value: telemetry, summary: input.summarize(telemetry) };
}

export function registerBiographyCompanionReviewTask(input: {
  scheduler: Scheduler;
  review: Pick<BiographyCompanionReviewService, 'run'>;
  intervalMs: number;
  automataLifecycle?: AutomataClassLifecycleRuntime;
  eventBus?: EventBus;
}): void {
  input.scheduler.register({
    id: BIOGRAPHY_COMPANION_REVIEW_TASK_ID,
    name: 'Companion Biography Review',
    description:
      'The companion reviews staged biography candidates about itself and its relationships, '
      + 'with agency to approve, refuse, revise, reassign, split, merge, or flag. '
      + 'Runs as a governed automata class under the fleet maintenance baton.',
    scheduleSource: 'settings.json > biographicalDepthPolicy.full.refreshIntervalMs',
    type: 'every',
    intervalMs: input.intervalMs,
    availability: 'do_not_disturb',
    state: 'idle',
    handler: async () => {
      const runId = `biography-review:${randomUUID()}`;
      const governed = await runGovernedAutomataClass({
        runtime: input.automataLifecycle,
        spec: {
          automatonClass: BIOGRAPHY_REVIEW_CLASS,
          runId,
          workerId: BIOGRAPHY_COMPANION_REVIEW_TASK_ID,
          taskId: BIOGRAPHY_COMPANION_REVIEW_TASK_ID,
          taskLabel: 'Review my own biography proposals',
          taskSummary:
            'Decide a bounded batch of staged biography candidates about myself and my relationships.',
        },
        briefingQuery: BIOGRAPHY_REVIEW_BRIEFING_QUERY,
        work: async () => await runBiographyStageUnderBaton({
          phase: 'biography_companion_review',
          label: 'Companion biography review',
          run: async control => await input.review.run(control),
          // Counts only: no candidate id, claim value, or review reasoning
          // reaches the Bus or the event bus from this lane.
          summarize: telemetry => (
            `considered=${telemetry.candidatesConsidered} approved=${telemetry.approved} `
            + `rejected=${telemetry.rejected} escalated=${telemetry.escalatedToHumanReview} `
            + `remaining=${telemetry.candidatesRemaining}`
          ),
        }),
      });
      if (governed.status === 'replayed' || governed.value === undefined) return;
      void input.eventBus?.emit('memory.biography.companion_review', {
        ...governed.value,
        timestamp: Date.now(),
      });
    },
  }, { skipFirstRun: true });
}

export const BIOGRAPHY_SYNTHESIS_TASK_ID = 'biography-candidate-synthesis';

/**
 * Cross-silo portable biography candidate synthesis (o61vb.12/.16).
 *
 * This is heavy cognition over authorized memory silos, so it is NOT on the
 * shared background-maintenance lane: that lane is per-companion sequential and
 * would let every companion in a fleet scan at once. It is its own
 * `do_not_disturb` task, opened as a governed automata class and run under the
 * fleet maintenance baton so exactly one companion synthesizes at a time. It
 * only ever stages review candidates, so a preempted pass delays review rather
 * than changing what the companion may say.
 */
export function registerBiographySynthesisTask(input: {
  scheduler: Scheduler;
  synthesis: Pick<BiographySynthesisService, 'run'>;
  intervalMs: number;
  automataLifecycle?: AutomataClassLifecycleRuntime;
  eventBus?: EventBus;
}): void {
  input.scheduler.register({
    id: BIOGRAPHY_SYNTHESIS_TASK_ID,
    name: 'Biography Candidate Synthesis',
    description:
      'Mines subject-authorized memory silos for typed biography candidates and stages them '
      + 'for companion and human review. Never activates a claim.',
    scheduleSource: 'settings.json > biographicalDepthPolicy.full.refreshIntervalMs',
    type: 'every',
    intervalMs: input.intervalMs,
    availability: 'do_not_disturb',
    state: 'idle',
    handler: async () => {
      const runId = `biography-synthesis:${randomUUID()}`;
      const governed = await runGovernedAutomataClass({
        runtime: input.automataLifecycle,
        spec: {
          automatonClass: BIOGRAPHY_SYNTHESIS_CLASS,
          runId,
          workerId: BIOGRAPHY_SYNTHESIS_TASK_ID,
          taskId: BIOGRAPHY_SYNTHESIS_TASK_ID,
          taskLabel: 'Synthesize portable biography candidates',
          taskSummary:
            'Scan changed subject-authorized silos for typed biography candidates and stage them for review.',
        },
        briefingQuery: BIOGRAPHY_SYNTHESIS_BRIEFING_QUERY,
        work: async () => await runBiographyStageUnderBaton({
          phase: 'biography_synthesis',
          label: 'Biography synthesis',
          run: async control => await input.synthesis.run(control),
          // Counts only: no subject id, claim value, or source body ever
          // reaches the Bus or the event bus from this lane.
          summarize: telemetry => (
            `targets=${telemetry.targetsScanned} unchanged=${telemetry.targetsUnchanged} `
            + `staged=${telemetry.candidatesStaged} remaining=${telemetry.targetsRemaining}`
          ),
        }),
      });
      if (governed.status === 'replayed' || governed.value === undefined) return;
      void input.eventBus?.emit('memory.biography.synthesis', {
        ...governed.value,
        timestamp: Date.now(),
      });
    },
  }, { skipFirstRun: true });
}

export const DOING_MIRROR_LETTER_DRAIN_OPERATION_ID = 'doing-mirror-letter-drain';

/**
 * Redrives doing-mirror Letter deliveries that never reached the bin because
 * `LetterService.compose` failed after the disposition transition committed.
 * Without this the row stays pending forever and recovery depends on the
 * operator resubmitting the identical Garden form.
 */
export function registerDoingMirrorLetterDrainOperation(input: {
  backgroundMaintenance: BackgroundMaintenanceRegistrar;
  doingMirrorService: Pick<DoingMirrorService, 'drainPendingLetters'>;
  batchSize: number;
  maxDeliveryFailures: number;
}): void {
  input.backgroundMaintenance.registerOperation({
    id: DOING_MIRROR_LETTER_DRAIN_OPERATION_ID,
    name: 'Doing-Mirror Letter Redelivery',
    description:
      'Redelivers a bounded batch of doing-mirror dispositions whose Partner-authored Letter '
      + 'never reached the bin; delivery is idempotent on the stored canonical Letter id. '
      + 'A row past the owner-file consecutive-failure bound is quarantined out of the batch '
      + 'and waits for an explicit operator retry in Garden.',
    handler: async () => {
      const result = await input.doingMirrorService.drainPendingLetters(
        input.batchSize,
        input.maxDeliveryFailures,
      );
      if (result.drained > 0 || result.quarantined > 0) {
        log.info('Doing-mirror pending Letter deliveries redriven', result);
      }
    },
    // Deliberately ungated: the Garden transition route that creates these
    // pending rows carries no capability gate, so gating the drain would let a
    // tier without the token strand rows exactly as before this operation
    // existed.
  });
}

export function buildAgentSchedulerRuntime(
  options: BuildAgentSchedulerRuntimeOptions,
): AgentSchedulerRuntime {
  const scheduler = new Scheduler(
    options.eventBus,
    {
      tickIntervalMs: options.schedulerConfig.tickIntervalMs,
      heartbeatIntervalMs: options.schedulerConfig.heartbeatIntervalMs,
    },
    {
      eligibilityGate: options.eligibilityGate,
      // Agent-process scheduler: task failures enter the health plane owned by
      // the companion this agent serves (system-owned for a shard identity,
      // which has no core tenancy of its own).
      healthEventSource: {
        owner: resolveHealthEventOwner(options.config.companionId),
        process: 'agent',
      },
      // The owner-file budget that defines a stuck scheduler task also bounds
      // each attempt: past it the handler is aborted and recorded failed.
      taskBudgetMs: options.schedulerConfig.healthDetectors.stuckJobs.schedulerTaskBudgetMs,
      ...(options.companionAvailability
        ? {
            runProtectedTask: (state, handler) =>
              options.companionAvailability!.run(state, handler),
          }
        : {}),
    },
  );
  registerDurableBackgroundWorkSupervisorTask({
    agentLoop: options.agentLoop,
    intervalMs: options.schedulerConfig.tickIntervalMs,
    scheduler,
  });
  if (options.concernReviewWorker) {
    registerConcernReviewSupervisorTask({
      scheduler,
      worker: options.concernReviewWorker,
      intervalMs: options.schedulerConfig.tickIntervalMs,
    });
  }
  if (options.automataReviewer && options.automataLifecycle) {
    registerAutomataBusReviewerTask({
      scheduler,
      task: options.automataReviewer.task,
      automataLifecycle: options.automataLifecycle,
      companionId: options.automataReviewer.companionId,
    });
  }

  const backgroundMaintenance = new BackgroundMaintenanceRegistry({
    scheduler,
    eligibilityGate: options.eligibilityGate,
    intervalMs: options.schedulerConfig.backgroundMaintenance.intervalMs,
  });
  const compressionGuidelineEvolution = createCompressionGuidelineEvolution({
    eligibilityGate: options.eligibilityGate,
    llmProvider: options.llmProvider,
  });

  if (options.automataRetention) {
    backgroundMaintenance.registerOperation({
      id: AUTOMATA_RETENTION_OPERATION_ID,
      name: 'Automata Raw Session Retention',
      description: 'Revalidates durable terminal evidence and purges only exact eligible sessions.',
      handler: async () => {
        await options.automataRetention!.runBounded();
      },
    });
  }

  registerSalienceDecayOperation({
    backgroundMaintenance,
    memoryStore: options.memoryStore,
    config: options.config,
  });

  const biographyRefreshIntervalMs = (
    options.config.biographicalDepthPolicy ?? createDefaultBiographicalDepthPolicy()
  ).full.refreshIntervalMs;
  if (options.biographyCompanionReview) {
    registerBiographyCompanionReviewTask({
      scheduler,
      review: options.biographyCompanionReview,
      intervalMs: biographyRefreshIntervalMs,
      ...(options.automataLifecycle ? { automataLifecycle: options.automataLifecycle } : {}),
      eventBus: options.eventBus,
    });
  }

  if (options.biographySynthesis) {
    registerBiographySynthesisTask({
      scheduler,
      synthesis: options.biographySynthesis,
      intervalMs: biographyRefreshIntervalMs,
      ...(options.automataLifecycle ? { automataLifecycle: options.automataLifecycle } : {}),
      eventBus: options.eventBus,
    });
  }

  registerDoingMirrorLetterDrainOperation({
    backgroundMaintenance,
    doingMirrorService: options.doingMirrorService,
    batchSize: options.schedulerConfig.backgroundMaintenance.doingMirrorLetters.batchSize,
    maxDeliveryFailures:
      options.schedulerConfig.backgroundMaintenance.doingMirrorLetters.maxDeliveryFailures,
  });

  scheduler.registerHeartbeat(async () => {
    const now = Date.now();
    await options.eventBus.emit('schedule.healthcheck', {
      timestamp: now,
      taskCount: scheduler.taskCount,
    });
  });
  registerAmbientPresenceOperation({
    backgroundMaintenance,
    sessionManager: options.sessionManager,
    restWindow: options.schedulerConfig.episodicProcessing,
    eventBus: options.eventBus,
    minIdleMs:
      options.schedulerConfig.backgroundMaintenance.ambientPresence.minIdleMinutes * 60_000,
    minNoteIntervalMs:
      options.schedulerConfig.backgroundMaintenance.ambientPresence.minNoteIntervalMinutes * 60_000,
  });
  if (options.concernStore) {
    registerConcernGroomingOperation({
      backgroundMaintenance,
      concernStore: options.concernStore,
      eventBus: options.eventBus,
      maxActiveConcerns:
        options.schedulerConfig.backgroundMaintenance.concernGrooming.maxActiveConcerns,
      routeDispatcher: createDefaultConcernRouteDispatcher({
        companionDataDir: options.pathSnapshot.companionDataDir,
        eventBus: options.eventBus,
      }),
      // Resolution-as-appraisal (vw3w.1): grooming resolves off-turn, so it
      // reads the agent's live internal VAD to snapshot resolutionVAD.
      resolutionVadProvider: (concern, asOf) => resolveCurrentInternalStateConcernVAD(
        concern,
        options.agentLoop.getCurrentInternalState(),
        asOf,
      ),
    });
  }

  // ── Social-graph builder worker (E4.2, memory-agent lane) ──
  // Background job that proposes social-graph edges from accumulated room
  // evidence. Purely heuristic (no LLM call, so no model charge); it runs on the
  // same background-maintenance posture as sleeptime/salience-decay via the
  // scheduler eligibility gate. NEVER inline in the chat path. Law 31: results
  // land in the durable proposal store and are surfaced in Garden — never silent.
  if (
    options.contactStore
    && options.socialGraphProposalStore
    && options.socialGraphWatermarkStore
  ) {
    const contactStore = options.contactStore;
    const memoryStore = options.memoryStore;
    const builderCadence = options.schedulerConfig.socialGraphBuilder;
    const socialGraphBuilder = new SocialGraphBuilderWorker({
      memoryReader: createSocialGraphBuilderMemoryReader({
        listRoomChannelIds: async () => (
          await contactStore.listKnownRooms({ limit: builderCadence.scanMemoryLimit })
        ).map(room => room.channelId),
        getMemoriesByChannel: (channelId, limit) => memoryStore.getMemoriesByChannel(channelId, limit),
      }),
      contacts: contactStore,
      proposalStore: options.socialGraphProposalStore,
      watermarkStore: options.socialGraphWatermarkStore,
      config: {
        coPresenceMinSessions: builderCadence.coPresenceMinSessions,
        coPresenceWindowMinutes: builderCadence.coPresenceWindowMinutes,
        scanMemoryLimit: builderCadence.scanMemoryLimit,
      },
      onComplete: (telemetry) => {
        void options.eventBus.emit('memory.social_graph.builder', {
          ...telemetry,
          timestamp: Date.now(),
        });
        if (telemetry.proposed > 0 || telemetry.conflicts > 0) {
          emitGardenQueueChanged(options.eventBus, 'graph-proposals');
        }
      },
    });
    const automataLifecycle = options.automataLifecycle;
    backgroundMaintenance.registerOperation({
      id: SOCIAL_GRAPH_BUILDER_OPERATION_ID,
      name: 'Social Graph Builder',
      description:
        'Scans bounded room-memory evidence and creates operator-reviewed social-graph proposals.',
      // The heuristic scan itself is unchanged; only run identity, briefing,
      // tool formation, and settlement move into the governed Bus lifecycle.
      handler: async () => {
        await runGovernedAutomataClass({
          runtime: automataLifecycle,
          spec: {
            automatonClass: SOCIAL_GRAPH_BUILDER_CLASS,
            runId: `social-graph-builder:${randomUUID()}`,
            workerId: SOCIAL_GRAPH_BUILDER_OPERATION_ID,
            taskId: SOCIAL_GRAPH_BUILDER_OPERATION_ID,
            taskLabel: 'Build social-graph proposals',
            taskSummary:
              'Scan bounded room-memory evidence and propose operator-reviewed social-graph edges.',
          },
          briefingQuery: SOCIAL_GRAPH_BUILDER_BRIEFING_QUERY,
          work: async () => {
            const telemetry = await socialGraphBuilder.run();
            // Counts only: contact identifiers, memory text, and evidence never
            // reach the Bus, which carries process findings and not people.
            return {
              value: telemetry,
              summary: `Social-graph builder: scanned=${telemetry.scanned} `
                + `proposed=${telemetry.proposed} conflicts=${telemetry.conflicts} `
                + `deduped=${telemetry.deduped}`,
            };
          },
        });
      },
      eligibility: { requiredTokens: ['memory.write'] },
    });
    log.info('Social-graph builder worker registered', {
      intervalMs: options.schedulerConfig.backgroundMaintenance.intervalMs,
      coPresenceMinSessions: builderCadence.coPresenceMinSessions,
    });
  }

  const postTurnActions = wirePostTurnActionRuntime({
    eventBus: options.eventBus,
    scheduler,
    agentLoop: options.agentLoop,
    eligibilityGate: options.eligibilityGate,
    persistencePath: resolvePostTurnActionQueuePath(options.pathSnapshot.companionDataDir),
  });
  log.info(`Memory system enabled (${options.embeddingDims}d embeddings)`);
  return {
    scheduler,
    postTurnActions,
    backgroundMaintenance,
    compressionGuidelineEvolution,
  };
}
