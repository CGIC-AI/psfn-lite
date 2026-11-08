/**
 * Deterministic self-model signals for a turn, ported from the donor
 * `InternalStateComputer` (`src/core/self-model/state.ts`): certainty from
 * signal confidence, discrete agreement and reply coherence; engagement from
 * arousal, length and tool use; processing quality; conversation trajectory
 * from closing and topic-shift markers; and salient terms. The donor read
 * concerns, follow-ups and contacts through SubstrateAgent providers; here the
 * caller passes plain inputs. The result is machine-derived, never a self-report.
 */
import type { TurnId } from '../shared/index.ts';
import { clampUnit } from './state.ts';
import type { AffectSnapshot, ConversationTrajectory, ProcessingQuality, SelfModelSnapshot } from './types.ts';

const WRAPPING_UP = ['bye', 'goodbye', 'talk later', 'see you', 'good night', 'thanks, thats all', "that's all", 'done for now'];
const SHIFTING = ['anyway', 'by the way', 'switching gears', 'different topic', 'new topic', 'unrelated', 'on another note'];
const STOP_WORDS = new Set(
  'a an and are as at be but by for from has have how i in is it its me my of on or our that the their them there they this to us we what when where who why you your'.split(' '),
);
const TOKEN = /[a-z0-9][a-z0-9'_-]*/g;
const MAX_TERMS = 8;
const MAX_TERM_LENGTH = 48;

export interface SelfModelInput {
  readonly turnId: TurnId;
  readonly affect: AffectSnapshot;
  readonly participantText: string;
  readonly replyText: string;
  /** Reported by the harness that ran the turn. */
  readonly toolCallCount: number;
  /** Texts of the open concerns visible in this scope. */
  readonly openConcernTexts: readonly string[];
  readonly at: string;
}

export function computeSelfModel(input: SelfModelInput): SelfModelSnapshot {
  const certainty = round(
    clampUnit(input.affect.confidence * 0.55 + discreteAgreement(input.affect.discrete) * 0.25 + coherence(input.participantText, input.replyText) * 0.2),
  );
  const engagement = round(
    clampUnit(
      clampUnit((input.affect.vad.arousal + 1) / 2) * 0.5 +
        clampUnit((input.participantText.length + input.replyText.length) / 700) * 0.35 +
        clampUnit(input.toolCallCount / 4) * 0.15,
    ),
  );
  return {
    turnId: input.turnId,
    certainty,
    engagement,
    processing: processing(certainty, input.replyText, input.toolCallCount),
    trajectory: trajectory(input.participantText, input.replyText, input.openConcernTexts.length),
    salientTerms: salientTerms([input.participantText, input.replyText, ...input.openConcernTexts]),
    openConcernCount: input.openConcernTexts.length,
    computedAt: input.at,
  };
}

function discreteAgreement(discrete: Readonly<Record<string, number>>): number {
  const values = Object.values(discrete).filter((v) => v > 0);
  if (values.length === 0) return 0;
  if (values.length === 1) return 1;
  const total = values.reduce((sum, v) => sum + v, 0);
  const entropy = values.reduce((sum, v) => sum - (v / total) * Math.log2(v / total), 0);
  return clampUnit(1 - entropy / Math.log2(values.length));
}

function coherence(participantText: string, replyText: string): number {
  const asked = new Set(tokens(participantText));
  const answered = new Set(tokens(replyText));
  if (answered.size === 0) return 0;
  if (asked.size === 0) return 0.2;
  let shared = 0;
  for (const token of asked) if (answered.has(token)) shared += 1;
  return clampUnit(shared / new Set([...asked, ...answered]).size);
}

function processing(certainty: number, replyText: string, toolCallCount: number): ProcessingQuality {
  if (replyText.length === 0 || certainty < 0.34) return 'struggling';
  if (certainty < 0.68 || toolCallCount >= 2) return 'deliberate';
  return 'fluent';
}

function trajectory(participantText: string, replyText: string, openConcernCount: number): ConversationTrajectory {
  const combined = `${participantText}\n${replyText}`.toLowerCase();
  if (WRAPPING_UP.some((m) => combined.includes(m))) return 'wrapping-up';
  if (SHIFTING.some((m) => combined.includes(m))) return 'shifting';
  if (openConcernCount > 0 || combined.includes('?') || participantText.length + replyText.length >= 160) return 'deepening';
  return 'casual';
}

function salientTerms(sources: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const source of sources) {
    for (const token of tokens(source)) {
      if (token.length < 3 || STOP_WORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TERMS)
    .map(([token]) => token);
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(TOKEN) ?? []).map((t) => t.slice(0, MAX_TERM_LENGTH));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
