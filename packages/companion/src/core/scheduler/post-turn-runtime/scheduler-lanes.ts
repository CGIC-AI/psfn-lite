import { randomUUID } from 'node:crypto';

import { createComponentLogger } from '../../../shared/logger.js';
import type { DeterministicGateEvent } from '../../../shared/event-bus.js';
import { inferSessionChannelType } from '../../session/session-id.js';
import {
  ContactTrustDriftReviewLane,
  CONTACT_TRUST_DRIFT_REVIEW_ACTION_KIND,
  CONTACT_TRUST_DRIFT_REVIEW_CHANNEL_ID,
  type ContactTrustDriftReviewStore,
} from '../../contacts/trust-drift-review-lane.js';
import {
  SleeptimeMemoryAgent,
  SLEEPTIME_MEMORY_ACTION_KIND,
} from '../../../faculties/memory/sleeptime-agent.js';
import {
  NearTurnMemoryLane,
  NEAR_TURN_MEMORY_ACTION_KIND,
  type NearTurnMemoryCadenceTelemetry,
} from '../../../faculties/memory/near-turn-memory-lane.js';
import {
  EpisodeSynthesisLane,
  EPISODE_SYNTHESIS_ACTION_KIND,
  EPISODE_SYNTHESIS_TIMER_TASK_ID,
  type EpisodeSynthesisGateEvent,
} from '../../../faculties/memory/episodic/synthesis-lane.js';
import { toInferredPostTurnActions } from '../../intention/appraisal.js';
import { MAINTENANCE_REFLECTION_RUNTIME_CLASS } from '../../agent/worker-lanes.js';
import type {
  ReflectionAgent,
  ReflectionRuntimeOptions,
} from '../reflection-runtime-contracts.js';
import type { Scheduler } from '../scheduler.js';
import type { DailyRecurringCadence, RecurringCadenceTimezone } from '../types.js';
import { FleetMaintenanceFenceLostError } from '../fleet-maintenance-coordinator.js';
import { runWithFleetMaintenanceBaton } from '../fleet-maintenance-runner.js';
import {
  runGovernedAutomataClass,
  type AutomataClassWorkResult,
} from '../../../faculties/automata/bus/class-lifecycle.js';
import type { ProductionAutomataClassId } from '../../../faculties/automata/registry-contract.js';
import type {
  PostTurnActionHandler,
  PostTurnActionHandlerResult,
} from '../../agent/post-turn-action-runtime.js';

const log = createComponentLogger('PostTurnRuntime');
const SLEEPTIME_CLASS: ProductionAutomataClassId = 'memory.sleeptime';
const SLEEPTIME_TASK_LABEL = 'Sleeptime memory maintenance';
const SLEEPTIME_TASK_SUMMARY =
  'Run one bounded sleeptime consolidation pass over changed sessions.';
const SLEEPTIME_BRIEFING_QUERY = 'sleeptime memory consolidation pass';

type PostTurnActionHandlerAction = Parameters<PostTurnActionHandler>[0];
const DAY_MS = 24 * 60 * 60_000;

function wallClockSlot(
  localTime: string,
  timezone: RecurringCadenceTimezone,
): DailyRecurringCadence {
  const [hourText, minuteText] = localTime.split(':');
  return {
    kind: 'daily',
    hour: Number(hourText),
    minute: Number(minuteText),
    timezone,
  };
}

export const SLEEPTIME_REST_WINDOW_OPERATION_ID = 'memory.sleeptime.rest-window';
export const CONTACT_TRUST_DRIFT_REVIEW_OPERATION_ID = 'contacts.trust-drift-review.rest-window';

export interface SchedulerOwnedPostTurnLanes {
  sleeptimeAgent: SleeptimeMemoryAgent | null;
  nearTurnLane: NearTurnMemoryLane | null;
  episodeSynthesisLane: EpisodeSynthesisLane | null;
  driftReviewLane: ContactTrustDriftReviewLane | null;
}

interface CreateSchedulerOwnedPostTurnLanesOptions {
  agentLoop: ReflectionAgent;
  runtimeOptions: ReflectionRuntimeOptions;
}

interface RegisterSchedulerOwnedPostTurnLanesOptions extends CreateSchedulerOwnedPostTurnLanesOptions {
  scheduler: Scheduler;
  lanes: SchedulerOwnedPostTurnLanes;
  postTurnActions: NonNullable<ReflectionRuntimeOptions['postTurnActions']>;
}

function resolveContactTrustDriftReviewStore(
  runtimeOptions: ReflectionRuntimeOptions,
): ContactTrustDriftReviewStore | null {
  const driftContactStore = runtimeOptions.contactStore;
  return (
    driftContactStore
    && driftContactStore.listAll
    && driftContactStore.countVerifiedIdentityLinks
    && driftContactStore.getContactMaintenanceWatermark
    && driftContactStore.setContactMaintenanceWatermark
  )
    ? {
      listAll: driftContactStore.listAll.bind(driftContactStore),
      getEmotionalTimeSeries: driftContactStore.getEmotionalTimeSeries.bind(driftContactStore),
      countVerifiedIdentityLinks: driftContactStore.countVerifiedIdentityLinks.bind(driftContactStore),
      getContactMaintenanceWatermark: driftContactStore.getContactMaintenanceWatermark.bind(driftContactStore),
      setContactMaintenanceWatermark: driftContactStore.setContactMaintenanceWatermark.bind(driftContactStore),
    }
    : null;
}

export function createSchedulerOwnedPostTurnLanes(
  options: CreateSchedulerOwnedPostTurnLanesOptions,
): SchedulerOwnedPostTurnLanes {
  const { agentLoop, runtimeOptions } = options;
  const telemetryEventBus = runtimeOptions.eventBus;

  // True sleeptime: heavy passes (sleep consolidation, arc weaving, dream
  // meaning, orientation rewrite) are scheduler-owned rest-window work. The
  // agent is intentionally NOT reachable from the post-turn inferer below —
  // its only trigger surface is the rest-window scheduler task. The review
  // itself runs through HER loop (1gpol): agentLoop, not a raw provider.
  const sleeptimeAgent = (
    runtimeOptions.episodicReviewStore
    && runtimeOptions.memoryWriter
    && runtimeOptions.sessionManager
    && runtimeOptions.conversationalActivityWorkset
    && runtimeOptions.coreMemoryStore
    && runtimeOptions.resolvedConcernStore
    && runtimeOptions.episodicProcessingRestWindow
    && runtimeOptions.sleepConsolidator
    && runtimeOptions.arcWeaver
    && runtimeOptions.dreamMeaningPass
    && runtimeOptions.sleeptimeWikiPass
  )
    ? new SleeptimeMemoryAgent({
      agent: agentLoop,
      episodicStore: runtimeOptions.episodicReviewStore,
      sessionManager: runtimeOptions.sessionManager,
      conversationalActivityWorkset: runtimeOptions.conversationalActivityWorkset,
      coreMemoryStore: runtimeOptions.coreMemoryStore,
      resolvedConcernStore: runtimeOptions.resolvedConcernStore,
      memoryWriter: runtimeOptions.memoryWriter,
      promptRegistry: runtimeOptions.promptRegistry ?? null,
      ...(runtimeOptions.concernCandidateReview
        ? { concernCandidates: runtimeOptions.concernCandidateReview }
        : {}),
      restWindow: runtimeOptions.episodicProcessingRestWindow,
      ...(runtimeOptions.orientationRewriteGate
        ? { orientationRewriteGate: runtimeOptions.orientationRewriteGate }
        : {}),
      ...(telemetryEventBus
        ? {
          onGateEvent: (event: DeterministicGateEvent): void => {
            void telemetryEventBus.emit('memory.orientation_rewrite.gate', event);
          },
        }
        : {}),
      sleepConsolidator: runtimeOptions.sleepConsolidator,
      arcWeaver: runtimeOptions.arcWeaver,
      dreamMeaningPass: runtimeOptions.dreamMeaningPass,
      sleeptimeWikiPass: runtimeOptions.sleeptimeWikiPass,
      memoryMaintenanceStore: runtimeOptions.memoryMaintenanceStore,
      episodicDiagnosticsStore: runtimeOptions.episodicDiagnosticsStore,
    })
    : null;

  // Lightweight near-turn memory lane (no LLM provider: structurally zero
  // token spend). Fires on the JSON-owned nearTurnMemory cadence.
  const nearTurnLane = (
    runtimeOptions.sessionManager
    && runtimeOptions.nearTurnMemoryCadence
  )
    ? new NearTurnMemoryLane({
      sessionManager: runtimeOptions.sessionManager,
      cadence: runtimeOptions.nearTurnMemoryCadence,
      scopeClassifier: runtimeOptions.memoryScopeClassifier ?? null,
      memoryMaintenanceStore: runtimeOptions.memoryMaintenanceStore ?? null,
      ...(telemetryEventBus
        ? {
          onCadenceTelemetry: (event: NearTurnMemoryCadenceTelemetry): void => {
            telemetryEventBus.emit('memory.near_turn.cadence', {
              channelId: event.channelId,
              sessionId: event.sessionId,
              scope: event.scope,
              turnCount: event.turnCount,
              newEntriesSinceLastRun: event.newEntriesSinceLastRun,
              firedAtMs: event.firedAtMs,
              firesLastHour: event.firesLastHour,
              timestamp: Date.now(),
            }).catch((error) => {
              log.warn('Near-turn cadence telemetry emit failed', {
                channelId: event.channelId,
                scope: event.scope,
                error: String(error),
              });
            });
          },
        }
        : {}),
    })
    : null;

  // Candidate-episode synthesis lane: timer-or-turn-threshold trigger with a
  // deterministic gate (E5.3). Zero LLM spend when the gate is closed.
  const episodeSynthesisLane = (
    runtimeOptions.sessionManager
    && runtimeOptions.episodicSynthesizer
    && runtimeOptions.episodicWatermarkStore
    && runtimeOptions.conversationalActivityWorkset
    && runtimeOptions.episodeSynthesis
  )
    ? new EpisodeSynthesisLane({
      sessionManager: runtimeOptions.sessionManager,
      synthesizer: runtimeOptions.episodicSynthesizer,
      watermarkStore: runtimeOptions.episodicWatermarkStore,
      behavioralSummaryStore: runtimeOptions.episodicWatermarkStore,
      workset: runtimeOptions.conversationalActivityWorkset,
      config: runtimeOptions.episodeSynthesis,
      scopeClassifier: runtimeOptions.memoryScopeClassifier ?? null,
      ...(runtimeOptions.companionNames ? { companionNames: runtimeOptions.companionNames } : {}),
      ...(runtimeOptions.companionAuthorIds ? { companionAuthorIds: runtimeOptions.companionAuthorIds } : {}),
      memoryWriter: runtimeOptions.memoryWriter ?? null,
      ...(telemetryEventBus
        ? {
          onGateEvent: (event: EpisodeSynthesisGateEvent): void => {
            telemetryEventBus.emit('memory.episode_synthesis.gate', {
              sessionId: event.sessionId,
              channelId: event.channelId,
              trigger: event.trigger,
              outcome: event.outcome,
              ...(event.reason ? { reason: event.reason } : {}),
              newEntryCount: event.newEntryCount,
              relevantTurnCount: event.relevantTurnCount,
              minRelevantTurns: event.minRelevantTurns,
              timestamp: event.timestamp,
            }).catch((error) => {
              log.warn('Episode-synthesis gate telemetry emit failed', {
                sessionId: event.sessionId,
                outcome: event.outcome,
                error: String(error),
              });
            });
          },
        }
        : {}),
    })
    : null;

  const driftReviewStore = resolveContactTrustDriftReviewStore(runtimeOptions);
  const driftReviewLane = (
    driftReviewStore
    && runtimeOptions.episodicProcessingRestWindow
    && agentLoop.followUp
  )
    ? new ContactTrustDriftReviewLane({
      contactStore: driftReviewStore,
      restWindow: runtimeOptions.episodicProcessingRestWindow,
      ...(runtimeOptions.dyadRelationshipAdvisoryProvider
        ? { dyadAdvisoryProvider: runtimeOptions.dyadRelationshipAdvisoryProvider }
        : {}),
      deliverReview: (review) => {
        agentLoop.followUp?.({
          id: `contact-drift-review:${Date.now()}`,
          channelId: CONTACT_TRUST_DRIFT_REVIEW_CHANNEL_ID,
          channelType: 'terminal',
          authorId: 'scheduler',
          authorName: 'Contact Trust Review',
          content: review.content,
          timestamp: new Date(),
        });
      },
    })
    : null;

  return {
    sleeptimeAgent,
    nearTurnLane,
    episodeSynthesisLane,
    driftReviewLane,
  };
}

export function registerSchedulerOwnedPostTurnLanes(
  options: RegisterSchedulerOwnedPostTurnLanesOptions,
): void {
  const {
    agentLoop,
    scheduler,
    runtimeOptions,
    lanes,
    postTurnActions,
  } = options;
  const telemetryEventBus = runtimeOptions.eventBus;

  if (lanes.sleeptimeAgent) {
    const sleeptimeAgent = lanes.sleeptimeAgent;
    if (telemetryEventBus && runtimeOptions.backgroundMaintenance) {
      runtimeOptions.backgroundMaintenance.registerOperation({
        id: SLEEPTIME_REST_WINDOW_OPERATION_ID,
        name: 'Sleeptime Rest-Window Check',
        description: 'Checks whether rest-window heavy memory passes have become eligible.',
        handler: async () => {
          const actions = await sleeptimeAgent.inferIdlePostTurnActions();
          for (const action of actions) {
            const payload = action.payload ?? {};
            const channelId = typeof payload.sourceChannelId === 'string'
              ? payload.sourceChannelId
              : typeof payload.sessionId === 'string'
                ? payload.sessionId
                : 'api:sleeptime';
            const inferredChannelType = inferSessionChannelType(channelId);
            const channelType = inferredChannelType && inferredChannelType !== 'subagent'
              ? inferredChannelType
              : 'api';
            const syntheticMessage = {
              id: `sleeptime-idle:${channelId}:${Date.now()}`,
              channelId,
              channelType,
              authorId: 'system:sleeptime',
              authorName: 'Sleeptime',
              content: 'Sleeptime rest-window maintenance became eligible.',
              timestamp: new Date(),
            };
            await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
              message: syntheticMessage,
              response: {
                content: '',
                channelId,
                metadata: {
                  model: 'scheduler:sleeptime-idle',
                  inputTokens: 0,
                  outputTokens: 0,
                  durationMs: 0,
                },
              },
              actions: toInferredPostTurnActions([action], syntheticMessage),
            });
          }
        },
        eligibility: { requiredTokens: ['memory.write'] },
      });
    }
    postTurnActions.registerHandler(
      SLEEPTIME_MEMORY_ACTION_KIND,
      async (action) => {
        // The sleeptime stack is unchanged; only its durable run identity,
        // bounded briefing, governed tool, and settlement move into the shared
        // Bus lifecycle. Each scheduled attempt is its own bounded run, because
        // a yielded or baton-blocked attempt is legitimately re-attempted later.
        const governed = await runGovernedAutomataClass({
          runtime: runtimeOptions.automataClassLifecycle,
          spec: {
            automatonClass: SLEEPTIME_CLASS,
            runId: `sleeptime:${action.id}:${randomUUID()}`,
            workerId: SLEEPTIME_MEMORY_ACTION_KIND,
            taskId: action.dedupeKey,
            taskLabel: SLEEPTIME_TASK_LABEL,
            taskSummary: SLEEPTIME_TASK_SUMMARY,
          },
          briefingQuery: SLEEPTIME_BRIEFING_QUERY,
          work: async () => await runSleeptimeAttempt(action),
        });
        if (governed.status === 'replayed') return undefined;
        return governed.value;
      },
      {
        executionMode: 'background',
        runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
        coalescing: 'dedupe_key_with_durable_watermark',
      },
    );
    async function runSleeptimeAttempt(
      action: PostTurnActionHandlerAction,
    ): Promise<AutomataClassWorkResult<PostTurnActionHandlerResult | undefined>> {
        const fleetMaintenance = runtimeOptions.fleetMaintenance;
        const batonRun = fleetMaintenance
          ? await runWithFleetMaintenanceBaton({
              coordinator: fleetMaintenance.coordinator,
              leaseDurationMs: fleetMaintenance.leaseDurationMs,
              retryDelayMs: fleetMaintenance.retryDelayMs,
              phase: 'sleeptime',
              run: control => sleeptimeAgent.execute(action, {
                onSafeBoundary: input => control.checkpoint({
                  phase: `sleeptime:${input.stage}`,
                  checkpointRef: null,
                }),
                isYieldError: error => error instanceof FleetMaintenanceFenceLostError,
              }),
            })
          : null;
        if (batonRun?.outcome === 'waiting') {
          return {
            value: {
              rescheduleAt: batonRun.retryAtMs,
              detail: 'Sleeptime is waiting for the fleet maintenance baton',
            },
            // No summary: an attempt that never won the baton did no work, so
            // it settles as a typed no-finding rather than a useful handoff.
            lifecycleState: 'cancelled',
            outcome: 'cancelled',
            resultKind: 'none',
          };
        }
        const outcome = batonRun?.result ?? await sleeptimeAgent.execute(action);
        if (outcome.outcome === 'retry') {
          throw new AggregateError(
            outcome.failures.map(failure => new Error(
              `${failure.logicalSessionId}/${failure.stage}: ${failure.message}`,
            )),
            `Sleeptime workset has ${outcome.failures.length} session failure(s)`,
          );
        }
        if (outcome.outcome === 'yield') {
          const delayMs = fleetMaintenance
            ? fleetMaintenance.retryDelayMs
            : runtimeOptions.episodicProcessingRestWindow!.inactivityThresholdMinutes * 60_000;
          return {
            value: {
              rescheduleAt: Date.now() + delayMs,
              detail: `Sleeptime yielded with ${outcome.remainingSessions} session(s) remaining`,
            },
            outcome: 'budget_limited',
            resultKind: 'partial',
            summary: `Sleeptime yielded with ${outcome.remainingSessions} session(s) remaining`,
          };
        }
        // Session counts only: no episode, memory, or transcript content
        // reaches the Bus.
        return {
          value: {
            detail: `Sleeptime completed ${outcome.completedSessions} changed session(s)`,
          },
          summary: `Sleeptime completed ${outcome.completedSessions} changed session(s)`,
        };
    }
  } else {
    log.info('Sleeptime memory agent wiring skipped: missing post-turn dependencies', {
      hasPostTurnActions: Boolean(runtimeOptions.postTurnActions),
      hasLLMProvider: Boolean(runtimeOptions.llmProvider),
      hasMemoryWriter: Boolean(runtimeOptions.memoryWriter),
      hasSessionManager: Boolean(runtimeOptions.sessionManager),
      hasConversationalActivityWorkset: Boolean(runtimeOptions.conversationalActivityWorkset),
      hasCoreMemoryStore: Boolean(runtimeOptions.coreMemoryStore),
      hasRestWindow: Boolean(runtimeOptions.episodicProcessingRestWindow),
      hasSleepConsolidator: Boolean(runtimeOptions.sleepConsolidator),
      hasArcWeaver: Boolean(runtimeOptions.arcWeaver),
      hasDreamMeaningPass: Boolean(runtimeOptions.dreamMeaningPass),
      hasSleeptimeWikiPass: Boolean(runtimeOptions.sleeptimeWikiPass),
    });
  }

  if (lanes.driftReviewLane) {
    const driftReviewLane = lanes.driftReviewLane;
    if (telemetryEventBus && runtimeOptions.backgroundMaintenance) {
      runtimeOptions.backgroundMaintenance.registerOperation({
        id: CONTACT_TRUST_DRIFT_REVIEW_OPERATION_ID,
        name: 'Contact Trust-Drift Rest-Window Check',
        description: 'Checks whether the nightly contact trust-drift review has become eligible.',
        handler: async () => {
          const actions = await driftReviewLane.inferIdleActions();
          for (const action of actions) {
            const syntheticMessage = {
              id: `contact-drift-review-poll:${Date.now()}`,
              channelId: CONTACT_TRUST_DRIFT_REVIEW_CHANNEL_ID,
              channelType: 'terminal' as const,
              authorId: 'system:contact-drift-review',
              authorName: 'Contact Trust Review',
              content: 'Nightly contact trust-drift review became eligible.',
              timestamp: new Date(),
            };
            await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
              message: syntheticMessage,
              response: {
                content: '',
                channelId: CONTACT_TRUST_DRIFT_REVIEW_CHANNEL_ID,
                metadata: {
                  model: 'scheduler:contact-drift-review',
                  inputTokens: 0,
                  outputTokens: 0,
                  durationMs: 0,
                },
              },
              actions: toInferredPostTurnActions([action], syntheticMessage),
            });
          }
        },
        eligibility: { requiredTokens: ['identity.read'] },
      });
    }
    postTurnActions.registerHandler(
      CONTACT_TRUST_DRIFT_REVIEW_ACTION_KIND,
      async (action) => {
        await driftReviewLane.execute(action);
      },
      {
        executionMode: 'background',
        runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      },
    );
  } else {
    const driftContactStore = runtimeOptions.contactStore;
    log.info('Contact trust-drift review wiring skipped: missing post-turn dependencies', {
      hasContactStore: Boolean(runtimeOptions.contactStore),
      hasDriftStoreSurface: Boolean(driftContactStore?.listAll && driftContactStore.setContactMaintenanceWatermark),
      hasRestWindow: Boolean(runtimeOptions.episodicProcessingRestWindow),
      hasFollowUp: Boolean(agentLoop.followUp),
    });
  }

  if (lanes.nearTurnLane) {
    const nearTurnLane = lanes.nearTurnLane;
    postTurnActions.registerHandler(
      NEAR_TURN_MEMORY_ACTION_KIND,
      async (action) => {
        await nearTurnLane.execute(action);
      },
      {
        executionMode: 'background',
        runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      },
    );
  } else {
    log.info('Near-turn memory lane wiring skipped: missing dependencies', {
      hasSessionManager: Boolean(runtimeOptions.sessionManager),
      hasCadence: Boolean(runtimeOptions.nearTurnMemoryCadence),
    });
  }

  if (lanes.episodeSynthesisLane) {
    const episodeSynthesisLane = lanes.episodeSynthesisLane;
    postTurnActions.registerHandler(
      EPISODE_SYNTHESIS_ACTION_KIND,
      async (action) => {
        const fleetMaintenance = runtimeOptions.fleetMaintenance;
        const batonRun = fleetMaintenance
          ? await runWithFleetMaintenanceBaton({
              coordinator: fleetMaintenance.coordinator,
              leaseDurationMs: fleetMaintenance.leaseDurationMs,
              retryDelayMs: fleetMaintenance.retryDelayMs,
              phase: 'episode_synthesis',
              run: control => episodeSynthesisLane.execute(action, {
                onSafeBoundary: () => control.checkpoint({
                  phase: 'episode_synthesis',
                  checkpointRef: null,
                }),
              }),
            })
          : null;
        if (batonRun?.outcome === 'waiting') {
          return {
            rescheduleAt: batonRun.retryAtMs,
            detail: 'Episode synthesis is waiting for the fleet maintenance baton',
          };
        }
        const outcome = batonRun?.result ?? await episodeSynthesisLane.execute(action);
        if (outcome.outcome === 'yield') {
          if (!fleetMaintenance) {
            throw new Error('Episode synthesis cannot yield without fleet maintenance authority');
          }
          return {
            rescheduleAt: Date.now() + fleetMaintenance.retryDelayMs,
            detail: 'Episode synthesis yielded for fleet preemption',
          };
        }
        return { detail: 'Episode synthesis drain completed' };
      },
      {
        executionMode: 'background',
        runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
        // Every trigger targets the same durable companion-level workset. A
        // newer queued trigger subsumes older demand, while demand observed
        // during execution survives as a successor drain evaluation.
        coalescing: 'dedupe_key_with_durable_watermark',
      },
    );
    if (telemetryEventBus && runtimeOptions.episodeSynthesis) {
      for (const localTime of runtimeOptions.episodeSynthesis.daytimeSlots) {
        const taskId = `${EPISODE_SYNTHESIS_TIMER_TASK_ID}:${localTime.replace(':', '-')}`;
        if (scheduler.getTask(taskId)) continue;
        scheduler.register({
          id: taskId,
          name: `Episode Synthesis Drain (${localTime})`,
          description: 'Drains every changed conversational session sequentially for daytime episode synthesis.',
          scheduleSource: 'scheduler.json#episodeSynthesis.daytimeSlots',
          type: 'every',
          intervalMs: DAY_MS,
          cadence: wallClockSlot(localTime, runtimeOptions.episodeSynthesis.timezone),
          ...(runtimeOptions.fleetScheduleStagger
            ? { fleetStagger: runtimeOptions.fleetScheduleStagger }
            : {}),
          handler: async () => {
            const action = episodeSynthesisLane.inferTimerAction();
            const channelId = 'api:episode-synthesis';
            const inferredChannelType = inferSessionChannelType(channelId);
            const channelType = inferredChannelType && inferredChannelType !== 'subagent'
              ? inferredChannelType
              : 'api';
            const syntheticMessage = {
              id: `episode-synthesis-timer:${localTime}:${Date.now()}`,
              channelId,
              channelType,
              authorId: 'system:episode-synthesis',
              authorName: 'Episode Synthesis',
              content: 'Episode-synthesis daytime drain requested.',
              timestamp: new Date(),
            };
            await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
              message: syntheticMessage,
              response: {
                content: '',
                channelId,
                metadata: {
                  model: 'scheduler:episode-synthesis-timer',
                  inputTokens: 0,
                  outputTokens: 0,
                  durationMs: 0,
                },
              },
              actions: toInferredPostTurnActions([action], syntheticMessage),
            });
          },
          eligibility: { requiredTokens: ['memory.write'] },
          state: 'idle',
        });
      }
    }
  } else {
    log.info('Episode-synthesis lane wiring skipped: missing dependencies', {
      hasSessionManager: Boolean(runtimeOptions.sessionManager),
      hasSynthesizer: Boolean(runtimeOptions.episodicSynthesizer),
      hasWatermarkStore: Boolean(runtimeOptions.episodicWatermarkStore),
      hasConversationalActivityWorkset: Boolean(runtimeOptions.conversationalActivityWorkset),
      hasGateConfig: Boolean(runtimeOptions.episodeSynthesis),
    });
  }
}
