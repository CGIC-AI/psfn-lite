/**
 * Concern lifecycle rules ported from the donor (`src/core/intention/concerns.ts`,
 * `concern-visibility.ts`, `concern-resolution-appraisal.ts`,
 * `concern-resolution-arc.ts`, `appraisal/concern-arc-prose.ts`): the status
 * transition table, "reopening needs new evidence", evidence de-duplication,
 * text similarity for duplicate detection, the signed relief delta and the arc
 * prose. Visibility is rebuilt on Lite's audience rule instead of the donor's
 * ambient request context.
 */
import {
  SENSITIVITIES,
  canViewerRead,
  invalid,
  isOneOf,
  isRecord,
  ok,
  type Result,
  type Sensitivity,
  type Viewer,
} from '../shared/index.ts';
import { describeVad, type Vad } from '../emotion/index.ts';
import { CONCERN_EVIDENCE_KINDS, type ActiveConcern, type ConcernEvidenceRef, type ConcernStatus } from './types.ts';

export const MAX_CONCERN_TEXT_CHARS = 500;
export const MAX_CONCERN_OUTCOME_CHARS = 400;
const MAX_EVIDENCE_REF_CHARS = 240;
const MAX_EVIDENCE_REFS = 32;
export const CONCERN_DUPLICATE_SIMILARITY = 0.72;

const TERMINAL: readonly ConcernStatus[] = ['resolved', 'dismissed', 'suppressed'];
const OPEN: readonly ConcernStatus[] = ['active', 'watching', 'deferred', 'blocked'];

const ALLOWED: Readonly<Record<ConcernStatus, readonly ConcernStatus[]>> = {
  candidate: ['active', 'watching', 'deferred', 'blocked', 'resolved', 'dismissed', 'suppressed'],
  active: ['watching', 'deferred', 'blocked', 'resolved', 'dismissed', 'suppressed'],
  watching: ['active', 'deferred', 'blocked', 'resolved', 'dismissed', 'suppressed'],
  deferred: ['active', 'watching', 'blocked', 'resolved', 'dismissed', 'suppressed'],
  blocked: ['active', 'deferred', 'watching', 'resolved', 'dismissed', 'suppressed'],
  resolved: ['active', 'watching'],
  dismissed: ['active'],
  suppressed: [],
};

export function isTerminalConcernStatus(status: ConcernStatus): status is 'resolved' | 'dismissed' | 'suppressed' {
  return TERMINAL.includes(status);
}

/** Statuses that still ask for the companion's attention. */
export function isOpenConcernStatus(status: ConcernStatus): boolean {
  return OPEN.includes(status);
}

/**
 * A transition the table allows. Leaving a terminal status (a reopen) needs at
 * least one evidence reference the concern does not already hold.
 */
export function validateConcernTransition(input: {
  readonly from: ConcernStatus;
  readonly to: ConcernStatus;
  readonly existing: readonly ConcernEvidenceRef[];
  readonly added: readonly ConcernEvidenceRef[];
}): Result<void> {
  if (input.from === input.to) return invalid(`concern is already ${input.to}`);
  if (!ALLOWED[input.from].includes(input.to)) return invalid(`a ${input.from} concern cannot become ${input.to}`);
  if (isTerminalConcernStatus(input.from) && !isTerminalConcernStatus(input.to)) {
    const known = new Set(input.existing.map(evidenceKey));
    if (!input.added.some((ref) => !known.has(evidenceKey(ref)))) return invalid(`reopening a ${input.from} concern requires new evidence`);
  }
  return ok(undefined);
}

/**
 * Parses model-supplied evidence references. Each needs a known kind and a
 * reference; its sensitivity defaults to the concern's own and may only be at
 * or below what the current scope admits, so an author cannot attach evidence
 * it could not itself read.
 */
export function parseEvidenceRefs(raw: unknown, input: { readonly fallback: Sensitivity; readonly admitted: readonly Sensitivity[] }): Result<readonly ConcernEvidenceRef[]> {
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw) || raw.length > MAX_EVIDENCE_REFS) return invalid(`evidenceRefs must be an array of at most ${MAX_EVIDENCE_REFS} references`);
  const issues: string[] = [];
  const refs: ConcernEvidenceRef[] = [];
  raw.forEach((item: unknown, index) => {
    if (!isRecord(item) || Object.keys(item).some((k) => !['kind', 'ref', 'sensitivity'].includes(k))) {
      issues.push(`evidenceRefs[${index}] must be an object with kind, ref and optional sensitivity`);
      return;
    }
    const ref = typeof item['ref'] === 'string' ? item['ref'].replace(/\s+/g, ' ').trim() : '';
    const sensitivity = item['sensitivity'] ?? input.fallback;
    if (!isOneOf(CONCERN_EVIDENCE_KINDS, item['kind'])) issues.push(`evidenceRefs[${index}].kind must be one of ${CONCERN_EVIDENCE_KINDS.join(', ')}`);
    if (ref.length === 0 || ref.length > MAX_EVIDENCE_REF_CHARS) issues.push(`evidenceRefs[${index}].ref must be 1-${MAX_EVIDENCE_REF_CHARS} characters`);
    if (!isOneOf(SENSITIVITIES, sensitivity)) issues.push(`evidenceRefs[${index}].sensitivity is unknown`);
    else if (!input.admitted.includes(sensitivity)) issues.push(`evidenceRefs[${index}].sensitivity ${sensitivity} is not admitted here`);
    if (isOneOf(CONCERN_EVIDENCE_KINDS, item['kind']) && isOneOf(SENSITIVITIES, sensitivity)) refs.push({ kind: item['kind'], ref, sensitivity });
  });
  return issues.length > 0 ? invalid(...issues) : ok(mergeEvidence([], refs));
}

/** Union of two evidence lists, first occurrence wins, order kept. */
export function mergeEvidence(existing: readonly ConcernEvidenceRef[], added: readonly ConcernEvidenceRef[]): readonly ConcernEvidenceRef[] {
  const seen = new Map<string, ConcernEvidenceRef>();
  for (const ref of [...existing, ...added]) if (!seen.has(evidenceKey(ref))) seen.set(evidenceKey(ref), ref);
  return [...seen.values()];
}

function evidenceKey(ref: ConcernEvidenceRef): string {
  return `${ref.kind}:${ref.ref}`;
}

/**
 * Whether a viewer may see a concern: it must be able to read the audience the
 * concern was formed in, and be admitted to the concern's sensitivity and to
 * every evidence reference's. Anything else reads as missing.
 */
export function canViewConcern(viewer: Viewer, concern: ActiveConcern): boolean {
  if (!canViewerRead(viewer, concern.formedIn)) return false;
  if (!viewer.admitted.includes(concern.sensitivity)) return false;
  return concern.evidenceRefs.every((ref) => viewer.admitted.includes(ref.sensitivity));
}

/** Dice similarity over normalized tokens of three or more characters. */
export function concernTextSimilarity(left: string, right: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(left);
  const b = norm(right);
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  const tokens = (s: string) => [...new Set(s.split(' ').filter((t) => t.length >= 3))];
  const ta = tokens(a);
  const tb = new Set(tokens(b));
  if (ta.length === 0 || tb.size === 0) return 0;
  const shared = ta.filter((t) => tb.has(t)).length;
  return (2 * shared) / (ta.length + tb.size);
}

/** Signed resolution minus formation VAD. Relief, release and anticlimax all keep their sign. */
export function reliefDelta(formation: Vad, resolution: Vad): Vad {
  return {
    valence: resolution.valence - formation.valence,
    arousal: resolution.arousal - formation.arousal,
    dominance: resolution.dominance - formation.dominance,
  };
}

/** Prose for the captured part of an arc; null when neither snapshot exists. */
export function describeConcernArc(formation: Vad | null, resolution: Vad | null): string | null {
  if (formation !== null && resolution !== null) {
    return `When it formed this sat ${describeVad(formation)}; resolving it, that settled to ${describeVad(resolution)}.`;
  }
  if (formation !== null) return `When it formed this sat ${describeVad(formation)}.`;
  if (resolution !== null) return `Resolving it, it felt ${describeVad(resolution)}.`;
  return null;
}
