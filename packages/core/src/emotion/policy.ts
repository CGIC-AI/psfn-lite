import { deepFreeze, invalid, isRecord, ok, type Result } from '../shared/index.ts';
import type { Vad } from './types.ts';

/**
 * Owner-versioned emotion dynamics. Every field is required and validated;
 * nothing falls back to a default at runtime. The baseline carries the donor
 * values (`src/core/emotion/state.ts`, `src/core/emotion/telemetry-validation.ts`,
 * `src/system/config/narrative-emotion-appraisal-config.ts`).
 */
export interface EmotionPolicy {
  readonly version: number;
  readonly vadHalfLifeSeconds: Vad;
  readonly discreteHalfLifeSeconds: Readonly<Record<string, number>>;
  readonly defaultDiscreteHalfLifeSeconds: number;
  /** How fast mood follows VAD, per update, in [0, 1]. */
  readonly moodAlpha: number;
  /** How fast signal confidence follows observation confidence, in [0, 1]. */
  readonly confidenceAlpha: number;
  /** An observation below this confidence is recorded but not applied. */
  readonly trustedConfidence: number;
  /** An estimate older than this is not served; nothing is shown instead. */
  readonly freshForMs: number;
  /** Largest per-axis VAD movement since the last appraisal that still skips appraisal, in (0, 2]. */
  readonly appraisalThreshold: number;
  /** History entries given to the appraisal model. */
  readonly appraisalContextEntries: number;
  readonly maxAppraisalChars: number;
}

export const BASELINE_EMOTION_POLICY: EmotionPolicy = deepFreeze({
  version: 1,
  vadHalfLifeSeconds: { valence: 30 * 60, arousal: 20 * 60, dominance: 45 * 60 },
  discreteHalfLifeSeconds: { joy: 30 * 60, anger: 45 * 60, sadness: 60 * 60, surprise: 5 * 60, love: 2 * 60 * 60 },
  defaultDiscreteHalfLifeSeconds: 30 * 60,
  moodAlpha: 0.1,
  confidenceAlpha: 0.25,
  trustedConfidence: 0.35,
  freshForMs: 10 * 60_000,
  appraisalThreshold: 0.35,
  appraisalContextEntries: 8,
  maxAppraisalChars: 900,
});

const KEYS = Object.keys(BASELINE_EMOTION_POLICY) as readonly (keyof EmotionPolicy)[];
const LABEL_PATTERN = /^[a-z][a-z_]{0,39}$/;

export function parseEmotionPolicy(raw: unknown): Result<EmotionPolicy> {
  if (!isRecord(raw)) return invalid('emotion policy must be an object');
  const issues: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(KEYS as readonly string[]).includes(key)) issues.push(`unknown emotion policy field ${key}`);
  }
  const num = (key: keyof EmotionPolicy, test: (n: number) => boolean, rule: string): number => {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && test(value)) return value;
    issues.push(`${key} must be ${rule}`);
    return 0;
  };
  const positive = (n: number) => n > 0;
  const unit = (n: number) => n >= 0 && n <= 1;
  const version = num('version', (n) => Number.isInteger(n) && n >= 1, 'a positive integer');
  const halfLives = raw['vadHalfLifeSeconds'];
  let vadHalfLifeSeconds: Vad = { valence: 0, arousal: 0, dominance: 0 };
  if (isRecord(halfLives) && Object.keys(halfLives).sort().join() === 'arousal,dominance,valence' && Object.values(halfLives).every(isPositive)) {
    vadHalfLifeSeconds = { valence: halfLives['valence'] as number, arousal: halfLives['arousal'] as number, dominance: halfLives['dominance'] as number };
  } else {
    issues.push('vadHalfLifeSeconds must give a positive half-life for exactly valence, arousal and dominance');
  }
  const discrete = raw['discreteHalfLifeSeconds'];
  const discreteHalfLifeSeconds: Record<string, number> = {};
  if (isRecord(discrete)) {
    for (const [label, value] of Object.entries(discrete)) {
      if (!LABEL_PATTERN.test(label) || !isPositive(value)) issues.push(`discreteHalfLifeSeconds.${label} must be a positive half-life for a lowercase label`);
      else discreteHalfLifeSeconds[label] = value;
    }
  } else {
    issues.push('discreteHalfLifeSeconds must be an object');
  }
  const policy: EmotionPolicy = {
    version,
    vadHalfLifeSeconds,
    discreteHalfLifeSeconds,
    defaultDiscreteHalfLifeSeconds: num('defaultDiscreteHalfLifeSeconds', positive, 'positive'),
    moodAlpha: num('moodAlpha', unit, 'in [0, 1]'),
    confidenceAlpha: num('confidenceAlpha', unit, 'in [0, 1]'),
    trustedConfidence: num('trustedConfidence', (n) => n > 0 && n <= 1, 'in (0, 1]'),
    freshForMs: num('freshForMs', (n) => Number.isInteger(n) && n > 0, 'a positive integer'),
    appraisalThreshold: num('appraisalThreshold', (n) => n > 0 && n <= 2, 'in (0, 2]'),
    appraisalContextEntries: num('appraisalContextEntries', (n) => Number.isInteger(n) && n >= 1 && n <= 50, 'an integer from 1 to 50'),
    maxAppraisalChars: num('maxAppraisalChars', (n) => Number.isInteger(n) && n >= 40 && n <= 4_000, 'an integer from 40 to 4000'),
  };
  return issues.length > 0 ? invalid(...issues) : ok(deepFreeze(policy));
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
