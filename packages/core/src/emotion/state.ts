/**
 * Affect dynamics ported from the donor `EmotionState` (`src/core/emotion/state.ts`)
 * as pure functions over a snapshot: exponential decay per axis and per
 * discrete label, confidence-weighted impulses, then a mood EMA. The donor
 * class owned its state in memory inside `SubstrateAgent`; here the caller
 * persists the snapshot and passes it back in.
 */
import type { Audience } from '../shared/index.ts';
import type { EmotionPolicy } from './policy.ts';
import type { AffectObservation, AffectSnapshot, EmotionScopeKey, Vad } from './types.ts';

const EPSILON = 1e-4;
const AXES = ['valence', 'arousal', 'dominance'] as const;

export const NEUTRAL_VAD: Vad = Object.freeze({ valence: 0, arousal: 0, dominance: 0 });
export const NEUTRAL_AFFECT: AffectSnapshot = Object.freeze({ vad: NEUTRAL_VAD, mood: NEUTRAL_VAD, discrete: Object.freeze({}), confidence: 0 });

/** Throws unless `value` is a finite number: NaN and null must never be clamped into a plausible reading. */
function requireFinite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${what} must be a finite number, got ${String(value)}`);
  return value;
}

export function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, requireFinite(value, 'affect value')));
}

export function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, requireFinite(value, 'affect value')));
}

/**
 * Rejects a snapshot or impulse carrying a non-number anywhere. Records come
 * back from storage as JSON, where NaN becomes null and `null * factor` is a
 * silent 0, so the check runs before any arithmetic.
 */
function requireFiniteAffect(snapshot: AffectSnapshot, observation: Pick<AffectObservation, 'vad' | 'discrete' | 'confidence'> | null): void {
  for (const axis of AXES) {
    requireFinite(snapshot.vad[axis], `snapshot.vad.${axis}`);
    requireFinite(snapshot.mood[axis], `snapshot.mood.${axis}`);
  }
  for (const [label, score] of Object.entries(snapshot.discrete)) requireFinite(score, `snapshot.discrete.${label}`);
  requireFinite(snapshot.confidence, 'snapshot.confidence');
  if (observation === null) return;
  for (const axis of AXES) requireFinite(observation.vad[axis], `observation.vad.${axis}`);
  for (const [label, score] of Object.entries(observation.discrete)) requireFinite(score, `observation.discrete.${label}`);
  requireFinite(observation.confidence, 'observation.confidence');
}

function decayFactor(halfLifeSeconds: number, elapsedSeconds: number): number {
  return Math.exp((-Math.LN2 * elapsedSeconds) / halfLifeSeconds);
}

/**
 * Decays for `elapsedSeconds`, applies the observation (if any), then moves
 * mood toward VAD. `elapsedSeconds` must be finite and non-negative, and
 * every number in the snapshot and observation finite; anything else throws.
 */
export function advanceAffect(
  snapshot: AffectSnapshot,
  observation: Pick<AffectObservation, 'vad' | 'discrete' | 'confidence'> | null,
  elapsedSeconds: number,
  policy: EmotionPolicy,
): AffectSnapshot {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new RangeError(`elapsedSeconds must be finite and >= 0, got ${String(elapsedSeconds)}`);
  requireFiniteAffect(snapshot, observation);
  const vad = { ...snapshot.vad };
  const discrete = new Map(Object.entries(snapshot.discrete));
  let confidence = snapshot.confidence;

  if (elapsedSeconds > 0) {
    for (const axis of AXES) vad[axis] = clampSigned(vad[axis] * decayFactor(policy.vadHalfLifeSeconds[axis], elapsedSeconds));
    for (const [label, score] of discrete) {
      const halfLife = policy.discreteHalfLifeSeconds[label] ?? policy.defaultDiscreteHalfLifeSeconds;
      const decayed = clampUnit(score * decayFactor(halfLife, elapsedSeconds));
      if (decayed <= EPSILON) discrete.delete(label);
      else discrete.set(label, decayed);
    }
  }

  if (observation !== null) {
    const weight = clampUnit(observation.confidence);
    let signal = false;
    for (const axis of AXES) {
      vad[axis] = clampSigned(vad[axis] + clampSigned(observation.vad[axis]) * weight);
      signal = true;
    }
    for (const [raw, score] of Object.entries(observation.discrete)) {
      const label = raw.trim().toLowerCase();
      const impulse = clampUnit(score) * weight;
      if (label === '' || impulse <= 0) continue;
      const next = clampUnit((discrete.get(label) ?? 0) + impulse);
      if (next <= EPSILON) discrete.delete(label);
      else discrete.set(label, next);
      signal = true;
    }
    if (signal) confidence = clampUnit(confidence + (weight - confidence) * policy.confidenceAlpha);
  }

  const mood = {
    valence: clampSigned(snapshot.mood.valence + (vad.valence - snapshot.mood.valence) * policy.moodAlpha),
    arousal: clampSigned(snapshot.mood.arousal + (vad.arousal - snapshot.mood.arousal) * policy.moodAlpha),
    dominance: clampSigned(snapshot.mood.dominance + (vad.dominance - snapshot.mood.dominance) * policy.moodAlpha),
  };
  const sorted = [...discrete.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { vad, mood, discrete: Object.fromEntries(sorted), confidence };
}

/** The snapshot as it stands `elapsedSeconds` later with no new signal: decay only, mood unchanged. */
export function decayAffect(snapshot: AffectSnapshot, elapsedSeconds: number, policy: EmotionPolicy): AffectSnapshot {
  const moved = advanceAffect(snapshot, null, elapsedSeconds, { ...policy, moodAlpha: 0 });
  return { ...moved, mood: { ...snapshot.mood } };
}

/** Largest per-axis movement between two VAD readings (donor `maxAbsoluteNarrativeVadDelta`). */
export function maxAxisDelta(a: Vad, b: Vad): number {
  for (const axis of AXES) {
    requireFinite(a[axis], `vad.${axis}`);
    requireFinite(b[axis], `vad.${axis}`);
  }
  return Math.max(Math.abs(a.valence - b.valence), Math.abs(a.arousal - b.arousal), Math.abs(a.dominance - b.dominance));
}

/** The emotion scope an audience's turns belong to. */
export function emotionScopeOf(audience: Audience): EmotionScopeKey {
  switch (audience.kind) {
    case 'self':
      return { kind: 'self' };
    case 'direct':
      return { kind: 'direct', contactId: audience.contactId };
    case 'group':
      return { kind: 'room', channelId: audience.channelId };
  }
}

export function emotionScopeKey(scope: EmotionScopeKey): string {
  switch (scope.kind) {
    case 'self':
      return 'self';
    case 'direct':
      return `direct:${scope.contactId}`;
    case 'room':
      return `room:${scope.channelId}`;
  }
}

/** Words for a VAD reading (donor `prompt-formatting.ts`), so context shows prose rather than scores. */
export function describeVad(vad: Vad): string {
  return `${describeValence(vad.valence)}, ${describeArousal(vad.arousal)}, and ${describeDominance(vad.dominance)}`;
}

function describeValence(value: number): string {
  if (value >= 0.35) return 'lifted';
  if (value >= 0.12) return 'slightly lifted';
  if (value <= -0.35) return 'heavy';
  if (value <= -0.12) return 'slightly heavy';
  return 'steady';
}

function describeArousal(value: number): string {
  if (value >= 0.35) return 'activated';
  if (value >= 0.12) return 'a little activated';
  if (value <= -0.25) return 'quieted';
  return 'steady';
}

function describeDominance(value: number): string {
  if (value >= 0.25) return 'agentic';
  if (value <= -0.25) return 'less agentic';
  return 'balanced';
}
