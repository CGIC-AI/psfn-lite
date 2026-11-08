import {
  EMPTY_APPRAISAL_GATE,
  NEUTRAL_AFFECT,
  advanceAffect,
  computeSelfModel,
  decayAffect,
  describeVad,
  emotionScopeKey,
  emotionScopeOf,
  evaluateAppraisalGate,
  settleAppraisal,
  type AffectEstimatorPort,
  type AffectSnapshot,
  type AppraisalDecision,
  type AppraisalEntry,
  type AppraisalLogPort,
  type EmotionObservationRecord,
  type EmotionPolicy,
  type EmotionScopeKey,
  type EmotionSelfReport,
  type EmotionStatePort,
  type EmotionStateRecord,
  type EstimatorMessage,
  type GateOutcome,
  type SelfModelSnapshot,
  type SelfReportPort,
  type Vad,
  parseAffectObservation,
} from '../emotion/index.ts';
import { canViewConcern, isOpenConcernStatus, type ConcernPort } from '../intention/index.ts';
import type { SessionArchivePort, TurnLedgerPort, TurnRecord } from '../sessions/index.ts';
import {
  canViewerRead,
  denied,
  fail,
  invalid,
  unavailable,
  notFound,
  ok,
  sameAudience,
  type Clock,
  type CoreError,
  type IdSource,
  type Result,
  type TurnId,
} from '../shared/index.ts';
import { contextFromHistory } from './context.ts';
import type { ModelMessage, ModelPort } from './host-ports.ts';
import { authorOf, isTrustedTurnScope, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';

const SELF_REPORT_MAX_CHARS = 1_000;
const RECENT_SCAN = 500;
const COMMIT_ATTEMPTS = 3;
const APPRAISAL_PRODUCER = 'emotion.appraisal';
const APPRAISAL_MAX_OUTPUT_TOKENS = 300;
const APPRAISAL_INSTRUCTIONS = [
  'Write a short appraisal (60-120 words, plain prose) of what the estimated affect signals below may mean for this conversation.',
  'The signals are fallible machine estimates, not what the companion feels; when they disagree with the conversation, prefer the conversation and name the mismatch.',
  'If the evidence does not support a clear reading, say so plainly. This text is stored as machine inference, never as the companion speaking.',
].join(' ');

/** The machine estimate for one scope, labelled as inference and kept apart from self-reports. */
export interface EmotionReading {
  readonly scope: EmotionScopeKey;
  readonly estimate: {
    readonly source: 'machine_inference';
    readonly producer: string;
    readonly observedAt: string;
    readonly vad: Vad;
    readonly mood: Vad;
    readonly discrete: Readonly<Record<string, number>>;
    readonly confidence: number;
    readonly description: string;
  };
  readonly selfModel: (SelfModelSnapshot & { readonly source: 'machine_inference' }) | null;
  /** What the companion last said about its own state here, if anything. */
  readonly latestSelfReport: EmotionSelfReport | null;
}

export type AppraisalOutcome =
  | { readonly status: 'written'; readonly entry: AppraisalEntry }
  | { readonly status: 'failed'; readonly error: CoreError };

export interface ObserveOutcome {
  readonly status: 'observed' | 'replayed';
  readonly trusted: boolean;
  readonly gate: GateOutcome;
  readonly appraisal: AppraisalOutcome | null;
  /** Inference calls this request made. Nothing is assumed free. */
  readonly inference: { readonly estimator: number; readonly model: number };
}

export interface EmotionService {
  /**
   * Folds a settled turn into its scope's state once: decay, the estimator's
   * reading (applied only when trusted), the meaningful-change gate and the
   * self-model. An appraisal is written only when the gate opens. A repeated
   * call for the same turn replays: it makes no estimator call and finishes an
   * appraisal still owed for that turn.
   */
  observeTurn(scope: TrustedTurnScope, input: { readonly turnId: TurnId; readonly toolCallCount: number }): Promise<Result<ObserveOutcome>>;
  read(scope: TrustedTurnScope): Promise<Result<EmotionReading>>;
  appraisals(scope: TrustedTurnScope, input: { readonly limit: number }): Promise<Result<readonly AppraisalEntry[]>>;
  selfReport(scope: TrustedTurnScope, input: { readonly text: string; readonly supersedes: string | null }): Promise<Result<EmotionSelfReport>>;
  /** The scope's VAD decayed to now when a trusted, fresh estimate exists; otherwise null. */
  currentVad(scope: TrustedTurnScope): Promise<Result<Vad | null>>;
  /** Applies a concern's relief to the scope's state exactly once per generation. */
  applyRelief(scope: TrustedTurnScope, input: { readonly generationId: string; readonly delta: Vad }): Promise<Result<'applied' | 'duplicate'>>;
}

export interface EmotionServiceDeps {
  readonly states: EmotionStatePort;
  readonly appraisals: AppraisalLogPort;
  readonly selfReports: SelfReportPort;
  readonly estimator: AffectEstimatorPort;
  readonly model: ModelPort;
  readonly ledger: TurnLedgerPort;
  readonly archive: SessionArchivePort;
  readonly concerns: ConcernPort;
  readonly policy: EmotionPolicy;
  readonly clock: Clock;
  readonly ids: IdSource;
}

export function createEmotionService(deps: EmotionServiceDeps): EmotionService {
  const { policy } = deps;
  const now = () => deps.clock.now();
  const elapsedSince = (at: string) => Math.max(0, (now().getTime() - Date.parse(at)) / 1000);
  const isFresh = (state: EmotionStateRecord | null): state is EmotionStateRecord & { lastTrusted: NonNullable<EmotionStateRecord['lastTrusted']> } =>
    state?.lastTrusted !== null && state !== null && now().getTime() - Date.parse(state.lastTrusted.at) <= policy.freshForMs;

  const initial = (scope: EmotionScopeKey, at: string): EmotionStateRecord => ({
    scope,
    key: emotionScopeKey(scope),
    snapshot: NEUTRAL_AFFECT,
    updatedAt: at,
    lastTrusted: null,
    gate: EMPTY_APPRAISAL_GATE,
    selfModel: null,
    revision: 0,
  });

  /** Loads the scope, applies `change`, and commits compare-and-set, retrying a stale revision. */
  const commitChange = async (
    key: string,
    scope: EmotionScopeKey,
    change: (
      state: EmotionStateRecord,
      at: string,
    ) => Result<{ readonly next: EmotionStateRecord; readonly observation: EmotionObservationRecord | null } | null>,
  ): Promise<Result<EmotionStateRecord>> => {
    for (let attempt = 1; ; attempt += 1) {
      const at = now().toISOString();
      const loaded = await deps.states.get(key);
      if (!loaded.ok) return loaded;
      const current = loaded.value ?? initial(scope, at);
      const changed = change(current, at);
      if (!changed.ok) return changed;
      if (changed.value === null) return ok(current);
      const committed = await deps.states.commit({ ...changed.value, expectedRevision: current.revision });
      if (committed.ok || committed.error.kind !== 'conflict' || committed.error.reason !== 'stale_revision' || attempt >= COMMIT_ATTEMPTS) return committed;
    }
  };

  const openConcernTexts = async (scope: TrustedTurnScope): Promise<Result<readonly string[]>> => {
    const listed = await deps.concerns.list(RECENT_SCAN);
    if (!listed.ok) return listed;
    const viewer = viewerOf(scope);
    return ok(listed.value.filter((c) => isOpenConcernStatus(c.status) && canViewConcern(viewer, c)).map((c) => c.text));
  };

  const appraise = async (record: TurnRecord, key: string, decision: AppraisalDecision): Promise<{ outcome: AppraisalOutcome; calls: number }> => {
    const id = `appraisal:${record.turnId}`;
    const existing = await deps.appraisals.get(id);
    if (!existing.ok) return { outcome: { status: 'failed', error: existing.error }, calls: 0 };
    let entry = existing.value;
    let calls = 0;
    if (entry === null) {
      const tail = await deps.archive.readTail(record.sessionId, policy.appraisalContextEntries);
      if (!tail.ok) return { outcome: { status: 'failed', error: tail.error }, calls };
      const messages: ModelMessage[] = [
        { role: 'labelled_context', label: `system note: ${APPRAISAL_PRODUCER}`, text: `${APPRAISAL_INSTRUCTIONS}\n\n${signalsText(decision)}` },
        ...tail.value.map((e) => {
          const context = contextFromHistory(e);
          return { role: context.role, label: context.label, text: context.text };
        }),
      ];
      calls = 1;
      const completed = await deps.model.complete({
        attribution: { purpose: APPRAISAL_PRODUCER, turnId: record.turnId, output: 'machine_inference' },
        messages,
        maxOutputTokens: APPRAISAL_MAX_OUTPUT_TOKENS,
      });
      if (!completed.ok) return { outcome: { status: 'failed', error: completed.error }, calls };
      const summary = boundSummary(completed.value.text, policy.maxAppraisalChars);
      if (summary === null) return { outcome: { status: 'failed', error: { kind: 'unavailable', capability: 'model', detail: 'appraisal was empty' } }, calls };
      const appended = await deps.appraisals.append({
        id,
        scopeKey: key,
        source: record.audience,
        sessionId: record.sessionId,
        turnId: record.turnId,
        summary,
        vad: decision.targetVad,
        delta: decision.delta,
        author: { kind: 'machine', producer: APPRAISAL_PRODUCER },
        at: now().toISOString(),
      });
      if (!appended.ok) return { outcome: { status: 'failed', error: appended.error }, calls };
      entry = appended.value;
    }
    const settled = await commitChange(key, emotionScopeOf(record.audience), (state) =>
      // A newer turn may have replaced the pending decision; its own decision then stands.
      ok(state.gate.pending?.turnId === record.turnId ? { next: { ...state, gate: settleAppraisal(decision), revision: state.revision + 1 }, observation: null } : null),
    );
    if (!settled.ok) return { outcome: { status: 'failed', error: settled.error }, calls };
    return { outcome: { status: 'written', entry }, calls };
  };

  return {
    async observeTurn(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'workers do not drive emotion state');
      if (!Number.isInteger(input.toolCallCount) || input.toolCallCount < 0) return invalid('toolCallCount must be a non-negative integer');
      const found = await deps.ledger.get(input.turnId);
      if (!found.ok) return found.error.kind === 'not_found' ? notFound(`turn ${input.turnId}`) : found;
      const record = found.value;
      if (!sameAudience(record.audience, scope.audience)) return notFound(`turn ${input.turnId}`);
      if (record.settlement === null) return invalid('a turn is observed only after it settles');
      const scopeKey = emotionScopeOf(record.audience);
      const key = emotionScopeKey(scopeKey);
      const observationId = `turn:${record.turnId}`;

      const prior = await deps.states.observation(observationId);
      if (!prior.ok) return prior;
      if (prior.value !== null) {
        const state = await deps.states.get(key);
        if (!state.ok) return state;
        const pending = state.value?.gate.pending;
        const owed = pending?.turnId === record.turnId ? await appraise(record, key, pending) : null;
        return ok({
          status: 'replayed',
          trusted: prior.value.trusted,
          gate: prior.value.gate,
          appraisal: owed?.outcome ?? null,
          inference: { estimator: 0, model: owed?.calls ?? 0 },
        });
      }

      const { participantText, replyText, messages } = turnTexts(record);
      if (messages.length === 0) return invalid('the turn has no text to observe');
      const reading = await deps.estimator.estimate({ purpose: 'emotion.observe', turnId: record.turnId, messages });
      if (!reading.ok) return reading;
      // A malformed reading changes nothing and is reported; observing the turn again re-asks the estimator.
      const parsed = parseAffectObservation(reading.value as unknown);
      if (!parsed.ok) return unavailable('affect_estimator', `estimator returned a malformed reading: ${parsed.error.kind === 'invalid' ? parsed.error.issues.join('; ') : parsed.error.kind}`);
      const observation = parsed.value;
      const trusted = observation.confidence >= policy.trustedConfidence;
      const concernTexts = await openConcernTexts(scope);
      if (!concernTexts.ok) return concernTexts;

      const evaluated: { gate: GateOutcome } = { gate: 'not_applicable' };
      const committed = await commitChange(key, scopeKey, (state, at) => {
        const snapshot = advanceAffect(state.snapshot, trusted ? observation : null, elapsedSince(state.updatedAt), policy);
        const gate = evaluateAppraisalGate({
          gate: state.gate,
          trusted,
          vad: snapshot.vad,
          turnId: record.turnId,
          sessionId: record.sessionId,
          threshold: policy.appraisalThreshold,
        });
        evaluated.gate = gate.outcome;
        return ok({
          next: {
            ...state,
            snapshot,
            updatedAt: at,
            lastTrusted: trusted ? { at, producer: observation.producer, confidence: observation.confidence } : state.lastTrusted,
            gate: gate.gate,
            selfModel: computeSelfModel({
              turnId: record.turnId,
              affect: snapshot,
              participantText,
              replyText,
              toolCallCount: input.toolCallCount,
              openConcernTexts: concernTexts.value,
              at,
            }),
            revision: state.revision + 1,
          },
          observation: {
            id: observationId,
            scopeKey: key,
            kind: 'turn',
            trusted,
            impulse: trusted ? observation.vad : null,
            confidence: observation.confidence,
            producer: observation.producer,
            gate: gate.outcome,
            at,
          },
        });
      });
      if (!committed.ok) return committed;
      const pending = committed.value.gate.pending;
      const appraisal = evaluated.gate === 'appraisal_due' && pending?.turnId === record.turnId ? await appraise(record, key, pending) : null;
      return ok({
        status: 'observed',
        trusted,
        gate: evaluated.gate,
        appraisal: appraisal?.outcome ?? null,
        inference: { estimator: 1, model: appraisal?.calls ?? 0 },
      });
    },

    async read(scope) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'workers may not read emotion state');
      const scopeKey = emotionScopeOf(scope.audience);
      const key = emotionScopeKey(scopeKey);
      const state = await deps.states.get(key);
      if (!state.ok) return state;
      if (!isFresh(state.value)) return notFound('a trusted, fresh emotion estimate for this scope');
      const reports = await deps.selfReports.recent(key, 1);
      if (!reports.ok) return reports;
      const current: AffectSnapshot = decayAffect(state.value.snapshot, elapsedSince(state.value.updatedAt), policy);
      const selfModel = state.value.selfModel;
      return ok({
        scope: scopeKey,
        estimate: {
          source: 'machine_inference',
          producer: state.value.lastTrusted.producer,
          observedAt: state.value.lastTrusted.at,
          vad: current.vad,
          mood: current.mood,
          discrete: current.discrete,
          confidence: current.confidence,
          description: `${describeVad(current.vad)}; mood ${describeVad(current.mood)}`,
        },
        selfModel: selfModel === null ? null : { ...selfModel, source: 'machine_inference' },
        latestSelfReport: reports.value[0] ?? null,
      });
    },

    async appraisals(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'workers may not read appraisals');
      const recent = await deps.appraisals.recent(RECENT_SCAN);
      if (!recent.ok) return recent;
      const viewer = viewerOf(scope);
      return ok(recent.value.filter((entry) => canViewerRead(viewer, entry.source)).slice(0, input.limit));
    },

    async selfReport(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'a self-report is the companion speaking for itself');
      const text = input.text.trim();
      if (text.length === 0 || text.length > SELF_REPORT_MAX_CHARS) return invalid(`text must be 1-${SELF_REPORT_MAX_CHARS} characters`);
      const key = emotionScopeKey(emotionScopeOf(scope.audience));
      if (input.supersedes !== null) {
        const earlier = await deps.selfReports.get(input.supersedes);
        if (!earlier.ok) return earlier.error.kind === 'not_found' ? notFound(`self-report ${input.supersedes}`) : earlier;
        if (earlier.value.scopeKey !== key) return notFound(`self-report ${input.supersedes}`);
      }
      return deps.selfReports.append({
        id: deps.ids.next('self_report'),
        scopeKey: key,
        audience: scope.audience,
        text,
        author: authorOf(scope),
        source: 'companion_authored',
        supersedes: input.supersedes,
        reportedAt: now().toISOString(),
      });
    },

    async currentVad(scope) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const state = await deps.states.get(emotionScopeKey(emotionScopeOf(scope.audience)));
      if (!state.ok) return state;
      if (!isFresh(state.value)) return ok(null);
      return ok(decayAffect(state.value.snapshot, elapsedSince(state.value.updatedAt), policy).vad);
    },

    async applyRelief(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const scopeKey = emotionScopeOf(scope.audience);
      const key = emotionScopeKey(scopeKey);
      const observationId = `relief:${input.generationId}`;
      const prior = await deps.states.observation(observationId);
      if (!prior.ok) return prior;
      if (prior.value !== null) return ok('duplicate');
      const committed = await commitChange(key, scopeKey, (state, at) => {
        if (state.revision === 0) return fail({ kind: 'not_found', subject: 'emotion state for this scope' });
        return ok({
          next: {
            ...state,
            snapshot: advanceAffect(state.snapshot, { vad: input.delta, discrete: {}, confidence: 1 }, elapsedSince(state.updatedAt), policy),
            updatedAt: at,
            revision: state.revision + 1,
          },
          observation: {
            id: observationId,
            scopeKey: key,
            kind: 'concern_relief',
            trusted: true,
            impulse: input.delta,
            confidence: 1,
            producer: 'intention.concern_resolution',
            gate: 'not_applicable',
            at,
          },
        });
      });
      if (committed.ok) return ok('applied');
      return committed.error.kind === 'conflict' && committed.error.reason === 'already_exists' ? ok('duplicate') : committed;
    },
  };
}

function turnTexts(record: TurnRecord): { participantText: string; replyText: string; messages: EstimatorMessage[] } {
  const messages: EstimatorMessage[] = [];
  let participantText = '';
  if (record.trigger.kind === 'participant_message') {
    participantText = record.trigger.text;
    messages.push({ role: 'participant', label: null, text: record.trigger.text });
  } else {
    messages.push({ role: 'labelled_context', label: `internal: ${record.trigger.purpose}`, text: record.trigger.text });
  }
  const outcome = record.settlement?.outcome;
  const reply = outcome === undefined ? null : outcome.kind === 'completed' ? outcome.reply : outcome.partialReply;
  if (reply !== null && reply.trim() !== '') messages.push({ role: 'companion', label: null, text: reply });
  return { participantText, replyText: reply ?? '', messages: messages.filter((m) => m.text.trim() !== '') };
}

function signalsText(decision: AppraisalDecision): string {
  const fmt = (v: Vad) => `valence ${v.valence.toFixed(3)}, arousal ${v.arousal.toFixed(3)}, dominance ${v.dominance.toFixed(3)}`;
  return `Estimated affect moved from ${fmt(decision.baselineVad)} to ${fmt(decision.targetVad)} (largest axis change ${decision.delta.toFixed(3)}).`;
}

function boundSummary(text: string, maxChars: number): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === '') return null;
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1).trimEnd()}…` : normalized;
}

function untrusted() {
  return denied('unknown_authority', 'scope was not admitted by ingress');
}
