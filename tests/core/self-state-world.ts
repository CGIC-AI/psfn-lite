/**
 * The continuity world plus the real self-state services: emotion, concerns,
 * follow-ups and the self-state context, dispatched next to the continuity
 * tools. `wireSelfState` takes any port implementations, so the same wiring
 * runs over fakes here and over the Postgres stores in integration tests.
 */
import {
  BASELINE_EMOTION_POLICY,
  TOOL_INVENTORY,
  createConcernService,
  createContinuityHandlers,
  createEmotionService,
  createFollowUpService,
  createSelfStateContext,
  createSelfStateHandlers,
  createToolDispatcher,
  type AffectObservation,
  type AppraisalLogPort,
  type ConcernPort,
  type EmotionPolicy,
  type EmotionSelfReport,
  type EmotionStatePort,
  type FollowUpPort,
  type SelfReportPort,
  type TrustedTurnScope,
} from '../../packages/core/src/index.ts';
import { FakeModel } from './continuity-fakes.ts';
import { continuityWorld, type WorldPorts, type wireWorld } from './continuity-world.ts';
import { FakeAppraisals, FakeConcerns, FakeEmotionStates, FakeEstimator, FakeFollowUps, FakeReflections, FakeSelfReports } from './self-state-fakes.ts';

export interface SelfStatePorts {
  readonly emotionStates: EmotionStatePort;
  readonly appraisals: AppraisalLogPort;
  readonly selfReports: SelfReportPort;
  readonly concerns: ConcernPort;
  readonly followUps: FollowUpPort;
  readonly estimator: FakeEstimator;
  readonly appraiser: FakeModel;
  readonly reflections: FakeReflections;
}

type BaseWorld = ReturnType<typeof wireWorld> & Pick<WorldPorts, 'ledger' | 'archive' | 'catalog' | 'clock' | 'ids'>;

export function fakeSelfStatePorts(): SelfStatePorts & {
  readonly emotionStates: FakeEmotionStates;
  readonly concerns: FakeConcerns;
  readonly followUps: FakeFollowUps;
  readonly appraisals: FakeAppraisals;
  readonly selfReports: FakeSelfReports;
} {
  return {
    emotionStates: new FakeEmotionStates(),
    appraisals: new FakeAppraisals(),
    selfReports: new FakeSelfReports(),
    concerns: new FakeConcerns(),
    followUps: new FakeFollowUps(),
    estimator: new FakeEstimator(),
    appraiser: new FakeModel(),
    reflections: new FakeReflections(),
  };
}

export function wireSelfState(base: BaseWorld, ports: SelfStatePorts, policy: EmotionPolicy = BASELINE_EMOTION_POLICY) {
  const emotion = createEmotionService({
    states: ports.emotionStates,
    appraisals: ports.appraisals,
    selfReports: ports.selfReports,
    estimator: ports.estimator,
    model: ports.appraiser,
    ledger: base.ledger,
    archive: base.archive,
    concerns: ports.concerns,
    policy,
    clock: base.clock,
    ids: base.ids,
  });
  const concerns = createConcernService({ concerns: ports.concerns, emotion, clock: base.clock, ids: base.ids });
  const followUps = createFollowUpService({ followUps: ports.followUps, catalog: base.catalog, concerns: ports.concerns, clock: base.clock });
  const context = createSelfStateContext({ emotion, concerns, followUps, values: base.values, reflections: ports.reflections });
  const dispatcher = createToolDispatcher({
    inventory: TOOL_INVENTORY,
    handlers: {
      ...createContinuityHandlers({ sessions: base.sessions, contacts: base.contacts, orientation: base.orientation, values: base.values }),
      ...createSelfStateHandlers({ emotion, concerns, followUps }),
    },
  });
  if (!dispatcher.ok) throw new Error(JSON.stringify(dispatcher.error));

  const call = (scope: TrustedTurnScope, tool: string, action: string, args: Record<string, unknown> = {}) =>
    dispatcher.value.dispatch(scope, { tool, action, args });

  /** One completed turn, then the host's post-turn observation with the given estimator reading. */
  const talk = async (scope: TrustedTurnScope, text: string, reply: string, key: string, estimate?: AffectObservation) => {
    if (estimate !== undefined) ports.estimator.reading = estimate;
    const sessionId = await base.converse(scope, text, reply, key);
    const settled = await base.ledger.lastSettled(sessionId);
    if (!settled.ok || settled.value === null) throw new Error('no settled turn');
    const observed = await emotion.observeTurn(scope, { turnId: settled.value.turnId, toolCallCount: 0 });
    if (!observed.ok) throw new Error(JSON.stringify(observed.error));
    return { sessionId, turnId: settled.value.turnId, observed: observed.value };
  };

  const selfReport = async (scope: TrustedTurnScope, text: string): Promise<EmotionSelfReport> => {
    const written = await call(scope, 'emotion', 'self_report', { text });
    if (!written.ok) throw new Error(JSON.stringify(written.error));
    return written.value.content as EmotionSelfReport;
  };

  return { emotion, concerns, followUps, context, dispatcher: dispatcher.value, call, talk, selfReport };
}

export async function selfStateWorld() {
  const base = await continuityWorld();
  const ports = fakeSelfStatePorts();
  return { ...base, ports, ...wireSelfState(base, ports) };
}
