import { describe, expect, it } from 'vitest';
import {
  BASELINE_EMOTION_POLICY,
  EMPTY_APPRAISAL_GATE,
  NEUTRAL_AFFECT,
  advanceAffect,
  computeSelfModel,
  decayAffect,
  evaluateAppraisalGate,
  maxAxisDelta,
  parseAffectObservation,
  parseEmotionPolicy,
  settleAppraisal,
  type EmotionPolicy,
  type SessionId,
  type TurnId,
} from '../../packages/core/src/index.ts';

const policy = (overrides: Partial<EmotionPolicy>): EmotionPolicy => ({ ...BASELINE_EMOTION_POLICY, ...overrides });
const turn = 'turn-1' as TurnId;
const session = 'session-1' as SessionId;

describe('affect dynamics (ported from the donor EmotionState tests)', () => {
  it('applies exponential decay to VAD and discrete emotions', () => {
    const snapshot = {
      vad: { valence: 1, arousal: 1, dominance: 1 },
      mood: { valence: 0, arousal: 0, dominance: 0 },
      discrete: { joy: 1, surprise: 1 },
      confidence: 0.5,
    };
    const next = advanceAffect(
      snapshot,
      null,
      10,
      policy({ vadHalfLifeSeconds: { valence: 10, arousal: 20, dominance: 40 }, discreteHalfLifeSeconds: { joy: 30, surprise: 5 }, moodAlpha: 0 }),
    );
    expect(next.vad.valence).toBeCloseTo(0.5, 6);
    expect(next.vad.arousal).toBeCloseTo(Math.pow(0.5, 0.5), 6);
    expect(next.vad.dominance).toBeCloseTo(Math.pow(0.5, 0.25), 6);
    expect(next.discrete['joy']).toBeCloseTo(Math.pow(0.5, 10 / 30), 6);
    expect(next.discrete['surprise']).toBeCloseTo(0.25, 6);
  });

  it('decays first, then applies confidence-weighted impulses, then updates the mood EMA', () => {
    const next = advanceAffect(
      { vad: { valence: 0.4, arousal: 0, dominance: 0 }, mood: { valence: 0, arousal: 0, dominance: 0 }, discrete: { joy: 0.2 }, confidence: 0 },
      { vad: { valence: 0.4, arousal: 0.6, dominance: 0 }, discrete: { joy: 0.5, anger: 0.4 }, confidence: 0.5 },
      10,
      policy({ vadHalfLifeSeconds: { valence: 10, arousal: 10, dominance: 10 }, discreteHalfLifeSeconds: { joy: 10, anger: 10 }, moodAlpha: 0.1, confidenceAlpha: 0.5 }),
    );
    expect(next.vad.valence).toBeCloseTo(0.4, 6);
    expect(next.vad.arousal).toBeCloseTo(0.3, 6);
    expect(next.discrete['joy']).toBeCloseTo(0.35, 6);
    expect(next.discrete['anger']).toBeCloseTo(0.2, 6);
    expect(next.mood.valence).toBeCloseTo(0.04, 6);
    expect(next.mood.arousal).toBeCloseTo(0.03, 6);
    expect(next.confidence).toBeCloseTo(0.25, 6);
  });

  it('keeps a stable shape with sorted labels, and a read-time decay leaves mood untouched', () => {
    const next = advanceAffect(NEUTRAL_AFFECT, { vad: { valence: 0.8, arousal: 0, dominance: -0.2 }, discrete: { joy: 0.7, anger: 0.4 }, confidence: 0.9 }, 0, BASELINE_EMOTION_POLICY);
    expect(Object.keys(next)).toEqual(['vad', 'mood', 'discrete', 'confidence']);
    expect(Object.keys(next.discrete)).toEqual(['anger', 'joy']);
    const later = decayAffect(next, 1800, BASELINE_EMOTION_POLICY);
    expect(later.mood).toEqual(next.mood);
    expect(later.vad.valence).toBeCloseTo(next.vad.valence / 2, 6);
    expect(() => advanceAffect(next, null, -1, BASELINE_EMOTION_POLICY)).toThrow(RangeError);
  });

  it('throws on a non-finite number instead of clamping or zeroing it', () => {
    const fromJson = { ...NEUTRAL_AFFECT, vad: { valence: null, arousal: 0, dominance: 0 } } as never;
    expect(() => advanceAffect(fromJson, null, 10, BASELINE_EMOTION_POLICY)).toThrow(/snapshot\.vad\.valence/);
    const nanImpulse = { vad: { valence: Number.NaN, arousal: 0, dominance: 0 }, discrete: {}, confidence: 0.9 };
    expect(() => advanceAffect(NEUTRAL_AFFECT, nanImpulse, 0, BASELINE_EMOTION_POLICY)).toThrow(RangeError);
    expect(() => advanceAffect(NEUTRAL_AFFECT, { ...nanImpulse, vad: NEUTRAL_AFFECT.vad, discrete: { joy: Number.NaN } }, 0, BASELINE_EMOTION_POLICY)).toThrow(RangeError);
    expect(() => maxAxisDelta({ valence: Number.NaN, arousal: 0, dominance: 0 }, NEUTRAL_AFFECT.vad)).toThrow(RangeError);
  });
});

describe('estimator reading parser', () => {
  const good = { vad: { valence: -1, arousal: 0.5, dominance: 1 }, discrete: { joy: 0, sadness: 1 }, confidence: 0.6, producer: 'classifier-a' };

  it('accepts a well-formed reading unchanged', () => {
    expect(parseAffectObservation(good)).toEqual({ ok: true, value: good });
  });

  it('refuses every malformed shape whole, naming what is wrong', () => {
    const cases: [unknown, RegExp][] = [
      [null, /must be an object/],
      [{ ...good, vad: { valence: Number.NaN, arousal: 0, dominance: 0 } }, /vad\.valence/],
      [{ ...good, vad: { valence: 0.1 } }, /exactly valence, arousal and dominance/],
      [{ ...good, vad: { ...good.vad, extra: 0 } }, /exactly valence/],
      [{ ...good, vad: { ...good.vad, arousal: 1.01 } }, /vad\.arousal/],
      [{ ...good, discrete: { joy: Number.NaN } }, /discrete\.joy/],
      [{ ...good, discrete: { joy: -0.1 } }, /discrete\.joy/],
      [{ ...good, discrete: { 'Big Joy': 0.5 } }, /lowercase word/],
      [{ ...good, discrete: [] }, /discrete/],
      [{ ...good, confidence: Number.NaN }, /confidence/],
      [{ ...good, confidence: 1.5 }, /confidence/],
      [{ ...good, producer: '  ' }, /producer/],
      [{ ...good, note: 'x' }, /exactly confidence, discrete, producer, vad/],
    ];
    for (const [raw, issue] of cases) {
      const parsed = parseAffectObservation(raw);
      expect(parsed.ok, JSON.stringify(raw)).toBe(false);
      expect(parsed.ok ? '' : JSON.stringify(parsed.error)).toMatch(issue);
    }
  });
});

describe('meaningful-change gate', () => {
  const evaluate = (gate = EMPTY_APPRAISAL_GATE, valence = 0, trusted = true) =>
    evaluateAppraisalGate({ gate, trusted, vad: { valence, arousal: 0, dominance: 0 }, turnId: turn, sessionId: session, threshold: 0.35 });

  it('seeds a baseline from the first trusted reading instead of paying for a move from neutral', () => {
    const first = evaluate(EMPTY_APPRAISAL_GATE, 0.9);
    expect(first.outcome).toBe('baseline_seeded');
    expect(first.gate.baselineVad).toEqual({ valence: 0.9, arousal: 0, dominance: 0 });
  });

  it('skips untrusted telemetry and movement below the threshold, and owes an appraisal at it', () => {
    const seeded = evaluate(EMPTY_APPRAISAL_GATE, 0).gate;
    expect(evaluate(seeded, 0.9, false).outcome).toBe('untrusted_telemetry');
    expect(evaluate(seeded, 0.34).outcome).toBe('no_movement');
    const due = evaluate(seeded, -0.35);
    expect(due.outcome).toBe('appraisal_due');
    expect(due.gate.pending).toMatchObject({ turnId: turn, delta: 0.35, baselineVad: { valence: 0 }, targetVad: { valence: -0.35 } });
    // Drifting back below the threshold drops the owed appraisal; settling moves the baseline to the target.
    expect(evaluate(due.gate, 0.1).gate.pending).toBeNull();
    const settled = settleAppraisal(due.gate.pending as NonNullable<typeof due.gate.pending>);
    expect(settled).toEqual({ baselineVad: { valence: -0.35, arousal: 0, dominance: 0 }, turnsSinceLast: 0, pending: null });
  });
});

describe('self-model signals (ported from the donor InternalStateComputer)', () => {
  it('derives trajectory, processing and salient terms deterministically', () => {
    const base = { turnId: turn, affect: NEUTRAL_AFFECT, toolCallCount: 0, openConcernTexts: [], at: '2030-01-01T00:00:00.000Z' };
    expect(computeSelfModel({ ...base, participantText: 'ok bye', replyText: 'good night' }).trajectory).toBe('wrapping-up');
    expect(computeSelfModel({ ...base, participantText: 'anyway, new topic', replyText: 'sure' }).trajectory).toBe('shifting');
    expect(computeSelfModel({ ...base, participantText: 'how is the garden?', replyText: 'growing' }).trajectory).toBe('deepening');
    expect(computeSelfModel({ ...base, participantText: 'hi', replyText: '' }).processing).toBe('struggling');
    const model = computeSelfModel({ ...base, participantText: 'the garden tomatoes', replyText: 'tomatoes love sun', openConcernTexts: ['garden fence'] });
    expect(model.salientTerms.slice(0, 2)).toEqual(['garden', 'tomatoes']);
    expect(model.openConcernCount).toBe(1);
  });
});

describe('emotion policy', () => {
  it('accepts the baseline and rejects unknown, missing and out-of-range fields', () => {
    expect(parseEmotionPolicy(JSON.parse(JSON.stringify(BASELINE_EMOTION_POLICY)))).toEqual({ ok: true, value: BASELINE_EMOTION_POLICY });
    const bad = parseEmotionPolicy({ ...BASELINE_EMOTION_POLICY, appraisalThreshold: 0, freshForMs: -1, extra: true, vadHalfLifeSeconds: { valence: 1 } });
    expect(bad.ok || bad.error).toMatchObject({ kind: 'invalid' });
    const issues = bad.ok ? [] : (bad.error as unknown as { issues: string[] }).issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        'unknown emotion policy field extra',
        'appraisalThreshold must be in (0, 2]',
        'freshForMs must be a positive integer',
        expect.stringContaining('vadHalfLifeSeconds'),
      ]),
    );
    const { trustedConfidence: _dropped, ...missing } = BASELINE_EMOTION_POLICY;
    expect(parseEmotionPolicy(missing).ok).toBe(false);
  });
});
