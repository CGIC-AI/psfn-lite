import type { ChannelId, ContactId, Result, TurnId } from '../shared/index.ts';

export interface Vad {
  readonly valence: number;
  readonly arousal: number;
  readonly dominance: number;
}

/** Emotion state is kept per audience scope so a room's state never leaks into a DM. */
export type EmotionScopeKey =
  | { readonly kind: 'direct'; readonly contactId: ContactId }
  | { readonly kind: 'room'; readonly channelId: ChannelId }
  | { readonly kind: 'self' };

/** Runtime-computed affect estimate. It is machine inference, labelled as such. */
export interface EmotionEstimate {
  readonly scope: EmotionScopeKey;
  readonly vad: Vad;
  readonly confidence: number;
  readonly source: 'machine_inference';
  readonly computedAt: string;
}

/** What the companion says about its own state, kept distinct from estimates. */
export interface EmotionSelfReport {
  readonly scope: EmotionScopeKey;
  readonly text: string;
  readonly source: 'companion_authored';
  readonly turnId: TurnId;
  readonly reportedAt: string;
}

export interface EmotionReadPort {
  /** Returns not_found when there is no trusted, fresh estimate; nothing is fabricated. */
  current(scope: EmotionScopeKey): Promise<Result<EmotionEstimate>>;
}

export interface EmotionSelfReportPort {
  append(report: EmotionSelfReport): Promise<Result<void>>;
}
