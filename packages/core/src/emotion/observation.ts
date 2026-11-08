/**
 * Boundary parser for estimator readings. The estimator is a host model or
 * classifier, so its output is untrusted data until it passes here: a reading
 * that is not exactly three finite axes in [-1, 1], a finite confidence in
 * [0, 1], finite label scores in [0, 1] and a named producer is refused whole.
 * Nothing is clamped or defaulted, because a repaired reading would still move
 * state and the meaningful-change gate on numbers the estimator never gave.
 */
import { invalid, isRecord, ok, type Result } from '../shared/index.ts';
import { EMOTION_LABEL_PATTERN } from './policy.ts';
import type { AffectObservation, Vad } from './types.ts';

const OBSERVATION_KEYS = ['confidence', 'discrete', 'producer', 'vad'];
const VAD_KEYS = ['arousal', 'dominance', 'valence'];
const MAX_LABELS = 32;
const MAX_PRODUCER_CHARS = 120;

const finiteIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export function parseAffectObservation(raw: unknown): Result<AffectObservation> {
  if (!isRecord(raw)) return invalid('estimator reading must be an object');
  const issues: string[] = [];
  const keys = Object.keys(raw).sort();
  if (keys.join() !== OBSERVATION_KEYS.join()) issues.push(`estimator reading must have exactly ${OBSERVATION_KEYS.join(', ')}`);

  const vad = raw['vad'];
  let parsedVad: Vad | null = null;
  if (!isRecord(vad) || Object.keys(vad).sort().join() !== VAD_KEYS.join()) {
    issues.push('vad must have exactly valence, arousal and dominance');
  } else {
    for (const axis of VAD_KEYS) if (!finiteIn(vad[axis], -1, 1)) issues.push(`vad.${axis} must be a finite number in [-1, 1]`);
    if (VAD_KEYS.every((axis) => finiteIn(vad[axis], -1, 1))) {
      parsedVad = { valence: vad['valence'] as number, arousal: vad['arousal'] as number, dominance: vad['dominance'] as number };
    }
  }

  const discrete = raw['discrete'];
  const parsedDiscrete: Record<string, number> = {};
  if (!isRecord(discrete)) {
    issues.push('discrete must be an object of label scores');
  } else {
    const entries = Object.entries(discrete);
    if (entries.length > MAX_LABELS) issues.push(`discrete may name at most ${String(MAX_LABELS)} labels`);
    for (const [label, score] of entries) {
      if (!EMOTION_LABEL_PATTERN.test(label)) issues.push(`discrete label ${JSON.stringify(label.slice(0, 40))} must be a lowercase word`);
      else if (!finiteIn(score, 0, 1)) issues.push(`discrete.${label} must be a finite number in [0, 1]`);
      else parsedDiscrete[label] = score;
    }
  }

  const confidence = raw['confidence'];
  if (!finiteIn(confidence, 0, 1)) issues.push('confidence must be a finite number in [0, 1]');
  const producer = raw['producer'];
  if (typeof producer !== 'string' || producer.trim() === '' || producer.length > MAX_PRODUCER_CHARS) {
    issues.push(`producer must be a non-empty string of at most ${String(MAX_PRODUCER_CHARS)} characters`);
  }

  if (issues.length > 0 || parsedVad === null) return invalid(...issues);
  return ok({ vad: parsedVad, discrete: parsedDiscrete, confidence: confidence as number, producer: producer as string });
}
