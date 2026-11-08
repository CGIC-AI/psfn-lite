/**
 * Meaningful-change gate for narrative appraisal, ported from the donor's
 * drift-only reservation (`src/core/emotion/appraisal.ts`,
 * `narrative-appraisal-drift.ts`). An appraisal costs a model call, so it is
 * owed only when the scope's VAD has moved at least the threshold on some axis
 * since the last appraisal. The first trusted reading seeds the baseline
 * instead of paying for a synthetic move away from neutral, and untrusted
 * telemetry never triggers one.
 */
import type { SessionId, TurnId } from '../shared/index.ts';
import { maxAxisDelta } from './state.ts';
import type { AppraisalDecision, AppraisalGateState, GateOutcome, Vad } from './types.ts';

export const EMPTY_APPRAISAL_GATE: AppraisalGateState = Object.freeze({ baselineVad: null, turnsSinceLast: 0, pending: null });

export interface GateEvaluation {
  readonly outcome: Exclude<GateOutcome, 'not_applicable'>;
  readonly gate: AppraisalGateState;
  readonly delta: number;
}

export function evaluateAppraisalGate(input: {
  readonly gate: AppraisalGateState;
  readonly trusted: boolean;
  readonly vad: Vad;
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly threshold: number;
}): GateEvaluation {
  const turnsSinceLast = input.gate.turnsSinceLast + 1;
  if (!input.trusted) return { outcome: 'untrusted_telemetry', gate: { ...input.gate, turnsSinceLast }, delta: 0 };
  const baseline = input.gate.baselineVad;
  if (baseline === null) {
    return { outcome: 'baseline_seeded', gate: { baselineVad: { ...input.vad }, turnsSinceLast, pending: null }, delta: 0 };
  }
  const delta = maxAxisDelta(baseline, input.vad);
  // A pending decision describes the current need only; a newer reading replaces it.
  if (delta < input.threshold) return { outcome: 'no_movement', gate: { baselineVad: baseline, turnsSinceLast, pending: null }, delta };
  const decision: AppraisalDecision = {
    turnId: input.turnId,
    sessionId: input.sessionId,
    baselineVad: { ...baseline },
    targetVad: { ...input.vad },
    delta,
    threshold: input.threshold,
  };
  return { outcome: 'appraisal_due', gate: { baselineVad: baseline, turnsSinceLast, pending: decision }, delta };
}

/** Gate state once the appraisal for `decision` is durable: the target becomes the new baseline. */
export function settleAppraisal(decision: AppraisalDecision): AppraisalGateState {
  return { baselineVad: { ...decision.targetVad }, turnsSinceLast: 0, pending: null };
}
