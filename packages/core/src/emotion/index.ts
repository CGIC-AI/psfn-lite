export type {
  AffectEstimatorPort,
  AffectObservation,
  AffectSnapshot,
  AppraisalDecision,
  AppraisalEntry,
  AppraisalGateState,
  AppraisalLogPort,
  AuthoredReflection,
  AuthoredReflectionPort,
  ConversationTrajectory,
  EmotionObservationRecord,
  EmotionScopeKey,
  EmotionSelfReport,
  EmotionStatePort,
  EmotionStateRecord,
  EstimatorMessage,
  GateOutcome,
  ProcessingQuality,
  SelfModelSnapshot,
  SelfReportPort,
  Vad,
} from './types.ts';
export { BASELINE_EMOTION_POLICY, EMOTION_LABEL_PATTERN, parseEmotionPolicy, type EmotionPolicy } from './policy.ts';
export { parseAffectObservation } from './observation.ts';
export {
  NEUTRAL_AFFECT,
  NEUTRAL_VAD,
  advanceAffect,
  decayAffect,
  clampSigned,
  describeVad,
  emotionScopeKey,
  emotionScopeOf,
  maxAxisDelta,
} from './state.ts';
export { EMPTY_APPRAISAL_GATE, evaluateAppraisalGate, settleAppraisal, type GateEvaluation } from './appraisal-gate.ts';
export { computeSelfModel, type SelfModelInput } from './self-model.ts';
export { emotionTool } from './tool.ts';
