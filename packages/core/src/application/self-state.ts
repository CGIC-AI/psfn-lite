/**
 * Public surface of the self-state use cases (emotion, self-model, concerns,
 * follow-ups and the internal context built from them), re-exported as one
 * group from the application index.
 */
export {
  createConcernService,
  type ConcernService,
  type ConcernTransitionOutcome,
  type ReliefOutcome,
} from './concern-service.ts';
export {
  createEmotionService,
  type AppraisalOutcome,
  type EmotionReading,
  type EmotionService,
  type EmotionServiceDeps,
  type ObserveOutcome,
} from './emotion-service.ts';
export { createFollowUpService, type FollowUpService } from './follow-up-service.ts';
export { createSelfStateHandlers } from './handlers-self-state.ts';
export { createSelfStateContext, type SelfStateContext } from './self-state-context.ts';
