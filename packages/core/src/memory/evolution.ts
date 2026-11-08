import type { MemoryAttribution, MemoryKind, MemoryRecord, MemoryRelation } from './types.ts';

/**
 * Memory evolution, ported from the donor writer
 * (`src/faculties/memory/writer.ts`, `src/faculties/memory/writer/reconciliation.ts`,
 * `src/faculties/memory/lexical-match.ts`, `DEDUP_THRESHOLD` in
 * `src/faculties/memory/types.ts`). A new memory is compared with current
 * memories of the same subject and kind. Near-identical text deduplicates;
 * close text is classified as an update, a supersession, a negation or a
 * conflict. Lite adds an authority rule the donor lacked: a write may replace
 * an older memory only when its attribution carries at least the same
 * authority, so a machine inference never overwrites what the companion wrote
 * or what a participant said.
 */

/** Similarity at or above which a write of this kind is the same memory. */
export const DEDUP_THRESHOLD: Readonly<Record<MemoryKind, number>> = Object.freeze({
  fact: 0.9,
  preference: 0.9,
  event: 0.92,
  relational: 0.9,
  procedural: 0.97,
  boundary: 0.96,
});

/** How far below the dedup threshold a memory still counts as related. */
export const RELATED_OFFSET = 0.15;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'how', 'i', 'if', 'in', 'is', 'it', 'of',
  'on', 'or', 'that', 'the', 'this', 'to', 'was', 'we', 'with', 'you', 'your',
]);
const MAX_TOKENS = 32;

/** Lowercased content tokens without stopwords, in first-seen order. */
export function lexicalTokens(text: string): string[] {
  const raw = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const tokens: string[] = [];
  for (const token of raw) {
    if (token.length < 2 || STOPWORDS.has(token) || tokens.includes(token)) continue;
    tokens.push(token);
    if (tokens.length >= MAX_TOKENS) break;
  }
  return tokens;
}

/** Jaccard overlap of two token sets, 0..1. */
export function tokenOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Vector similarity when both sides have one, otherwise lexical overlap. */
export function similarity(
  incoming: { readonly content: string; readonly vector: readonly number[] | null },
  existing: { readonly content: string; readonly vector: readonly number[] | null },
): number {
  if (normalizeContent(incoming.content) === normalizeContent(existing.content)) return 1;
  if (incoming.vector !== null && existing.vector !== null) return cosine(incoming.vector, existing.vector);
  return tokenOverlap(lexicalTokens(incoming.content), lexicalTokens(existing.content));
}

export function normalizeContent(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Higher carries more authority over what is remembered. */
export function attributionRank(attribution: MemoryAttribution): number {
  switch (attribution.kind) {
    case 'inferred':
      return 0;
    case 'participant_attributed':
      return 1;
    case 'companion_authored':
      return 2;
  }
}

export interface EvolutionDecision {
  readonly existing: MemoryRecord;
  readonly similarity: number;
  readonly relation: MemoryRelation;
  /** True when the older memory stops being current. */
  readonly destructive: boolean;
  readonly reason: string;
}

const HIGH_IMPACT_KINDS = new Set<MemoryKind>(['boundary', 'relational']);
const CURRENT_STATE = /\b(current|currently|now|latest|moved to|changed to|is now|are now|no longer)\b/i;
const COMPATIBLE_UPDATE = /\b(also|additionally|another|besides|in addition|as well)\b/i;
const NEGATION = /\b(no longer|not|never|doesn't|does not|isn't|is not|aren't|are not|must not|should not|cannot|can't|won't)\b/i;
const CONTRASTS: readonly (readonly [string, string])[] = [
  ['on', 'off'],
  ['enabled', 'disabled'],
  ['active', 'inactive'],
  ['open', 'closed'],
  ['allowed', 'disallowed'],
  ['yes', 'no'],
  ['true', 'false'],
  ['likes', 'dislikes'],
  ['loves', 'hates'],
];

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

function contradicts(incoming: string, existing: string): boolean {
  if (NEGATION.test(incoming) !== NEGATION.test(existing)) return true;
  return CONTRASTS.some(
    ([l, r]) => (hasWord(incoming, l) && hasWord(existing, r)) || (hasWord(incoming, r) && hasWord(existing, l)),
  );
}

/**
 * Classifies how a related incoming memory changes an existing one, or null
 * when they simply coexist. Destructive outcomes are downgraded to a conflict
 * when the incoming attribution has less authority than the existing one.
 */
export function classifyEvolution(input: {
  readonly content: string;
  readonly kind: MemoryKind;
  readonly confidence: number;
  readonly attribution: MemoryAttribution;
  readonly existing: MemoryRecord;
  readonly similarity: number;
}): EvolutionDecision | null {
  const { existing } = input;
  const base = { existing, similarity: input.similarity };
  const outranked = attributionRank(input.attribution) < attributionRank(existing.provenance.attribution);
  const replace = (reason: string): EvolutionDecision =>
    outranked
      ? { ...base, relation: 'conflicts_with', destructive: false, reason: `${reason}; outranked by existing attribution` }
      : { ...base, relation: 'supersedes', destructive: true, reason };
  const higherConfidence = input.confidence > existing.confidence;
  const contradiction = contradicts(input.content, existing.content);

  if (CURRENT_STATE.test(input.content) && input.confidence >= existing.confidence) return replace('current_state_replacement');
  if (COMPATIBLE_UPDATE.test(input.content) && !contradiction) return { ...base, relation: 'updates', destructive: false, reason: 'compatible_update' };
  if (HIGH_IMPACT_KINDS.has(input.kind)) {
    return contradiction
      ? { ...base, relation: 'negates', destructive: false, reason: 'high_impact_negation_review' }
      : { ...base, relation: 'conflicts_with', destructive: false, reason: 'high_impact_conflict_review' };
  }
  if (contradiction) {
    return higherConfidence ? replace('contradiction_replacement') : { ...base, relation: 'conflicts_with', destructive: false, reason: 'contradiction_conflict' };
  }
  if (higherConfidence) return replace('higher_confidence_replacement');
  return null;
}

export type EvolutionOutcome = 'created' | 'updated' | 'superseded' | 'negated' | 'conflict';

export function chooseOutcome(decisions: readonly EvolutionDecision[]): EvolutionOutcome {
  if (decisions.some((d) => d.relation === 'supersedes' && d.destructive)) return 'superseded';
  if (decisions.some((d) => d.relation === 'negates')) return 'negated';
  if (decisions.some((d) => d.relation === 'conflicts_with')) return 'conflict';
  if (decisions.some((d) => d.relation === 'updates')) return 'updated';
  return 'created';
}
