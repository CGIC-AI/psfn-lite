import { SENSITIVITIES, invalid, isOneOf, isRecord, ok, type Result, type Sensitivity, type TurnId } from '../shared/index.ts';
import { MEMORY_KINDS, type MemoryKind } from './types.ts';

/**
 * Structured extraction output, adapted from the donor's extraction parser
 * (`src/faculties/memory/extraction/parser.ts`) and speaker routing
 * (`src/faculties/memory/extraction/speaker-routing.ts`). The model proposes
 * facts and names the source turn and whether the speaker said it about
 * themselves; the runtime decides the subject from that turn's attributed
 * speaker. Any malformed entry rejects the whole output, so a partial or
 * garbled answer never becomes memory.
 */
export interface ExtractedMemory {
  readonly turnId: TurnId;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sensitivity: Sensitivity;
  /** `speaker`: about the person who spoke in that turn. `room`: about the shared conversation. */
  readonly about: 'speaker' | 'room';
  /** `participant_attributed`: the speaker stated it. `inferred`: the model concluded it. */
  readonly attribution: 'participant_attributed' | 'inferred';
  readonly confidence: number;
}

export const EXTRACTION_MAX_ITEMS = 24;
const CONTENT_MAX = 600;

export const EXTRACTION_INSTRUCTION = [
  'Extract durable memories from the labelled transcript below.',
  'Answer with only a JSON object: {"memories":[{"turnId","kind","content","sensitivity","about","attribution","confidence"}]}.',
  `kind is one of ${MEMORY_KINDS.join(', ')}; sensitivity one of ${SENSITIVITIES.join(', ')};`,
  'about is "speaker" (about the person speaking in that turn) or "room" (about the shared conversation);',
  'attribution is "participant_attributed" when the speaker said it, "inferred" when you concluded it; confidence is 0..1.',
  'Use only turnIds that appear in the transcript. Return {"memories":[]} when nothing durable was said.',
].join(' ');

function jsonPayload(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim();
  return fenced !== undefined && fenced.startsWith('{') && fenced.endsWith('}') ? fenced : null;
}

export function parseExtraction(raw: string, turnIds: readonly TurnId[]): Result<readonly ExtractedMemory[]> {
  const payload = jsonPayload(raw);
  if (payload === null) return invalid('extraction output is not a JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return invalid('extraction output is not valid JSON');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['memories'])) return invalid('extraction output must have a memories array');
  const items: unknown[] = parsed['memories'];
  if (items.length > EXTRACTION_MAX_ITEMS) return invalid(`extraction output has more than ${EXTRACTION_MAX_ITEMS} memories`);
  const out: ExtractedMemory[] = [];
  const issues: string[] = [];
  items.forEach((item, index) => {
    const at = `memories[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${at} must be an object`);
      return;
    }
    const { turnId, kind, content, sensitivity, about, attribution, confidence } = item;
    if (typeof turnId !== 'string' || !(turnIds as readonly string[]).includes(turnId)) issues.push(`${at}.turnId is not a transcript turn`);
    if (!isOneOf(MEMORY_KINDS, kind)) issues.push(`${at}.kind is unknown`);
    if (typeof content !== 'string' || content.trim().length === 0 || content.length > CONTENT_MAX) {
      issues.push(`${at}.content must be 1-${CONTENT_MAX} characters`);
    }
    if (!isOneOf(SENSITIVITIES, sensitivity)) issues.push(`${at}.sensitivity is unknown`);
    if (about !== 'speaker' && about !== 'room') issues.push(`${at}.about must be speaker or room`);
    if (attribution !== 'participant_attributed' && attribution !== 'inferred') issues.push(`${at}.attribution is unknown`);
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) issues.push(`${at}.confidence must be 0..1`);
    if (issues.length > 0) return;
    out.push({
      turnId: turnId as TurnId,
      kind: kind as MemoryKind,
      content: (content as string).trim(),
      sensitivity: sensitivity as Sensitivity,
      about: about as 'speaker' | 'room',
      attribution: attribution as 'participant_attributed' | 'inferred',
      confidence: confidence as number,
    });
  });
  return issues.length > 0 ? invalid(...issues) : ok(out);
}
