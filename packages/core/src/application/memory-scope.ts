import { sourceAccessFor, type EmbeddingSpace, type MemorySubject, type SourceAccess } from '../memory/index.ts';
import { denied, invalid, ok, unavailable, type ContactId, type Result } from '../shared/index.ts';
import type { EmbeddingPort, WorkAttribution } from './host-ports.ts';
import { isTrustedTurnScope, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';

/** The participant a scope acts for: the caller, or the caller a worker was spawned under. */
export function callerContactOf(scope: TrustedTurnScope): ContactId | null {
  const principal = scope.caller.kind === 'worker' ? scope.caller.parent : scope.caller;
  return principal.kind === 'participant' ? principal.contactId : null;
}

/** Read access of a scope over memory, episodes and journals. */
export function accessOf(scope: TrustedTurnScope): SourceAccess {
  return sourceAccessFor(viewerOf(scope), callerContactOf(scope));
}

/**
 * Who a memory written under this scope is about, from the scope alone. Self
 * turns write companion-internal memories, a direct conversation writes about
 * its contact and a group writes about the room.
 */
export function writeSubjectOf(scope: TrustedTurnScope): MemorySubject {
  switch (scope.audience.kind) {
    case 'self':
      return { kind: 'companion_internal' };
    case 'direct':
      return { kind: 'contacts', contactIds: [scope.audience.contactId] };
    case 'group':
      return { kind: 'room', channelId: scope.audience.channelId };
  }
}

export function requireTrusted(scope: TrustedTurnScope): Result<void> {
  return isTrustedTurnScope(scope) ? ok(undefined) : denied('unknown_authority', 'scope was not admitted by ingress');
}

export function requireMaintenanceScope(scope: TrustedTurnScope): Result<void> {
  if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
  if (scope.audience.kind !== 'self' || scope.caller.kind !== 'companion_internal') {
    return denied('requires_self_audience', 'memory maintenance runs only in companion-internal turns');
  }
  return ok(undefined);
}

/** Embedding access bound to one declared space; vectors of another length are refused. */
export interface Embeddings {
  readonly port: EmbeddingPort;
  readonly space: EmbeddingSpace;
}

export function validateSpace(space: EmbeddingSpace): Result<EmbeddingSpace> {
  if (!/^[a-z0-9][a-z0-9:._-]{0,63}$/.test(space.name)) return invalid('embedding space name must be 1-64 characters of [a-z0-9:._-]');
  if (!Number.isInteger(space.dimensions) || space.dimensions < 1 || space.dimensions > 4000) {
    return invalid('embedding space dimensions must be an integer from 1 to 4000');
  }
  return ok(space);
}

export async function embedTexts(
  embeddings: Embeddings,
  texts: readonly string[],
  purpose: string,
): Promise<Result<readonly (readonly number[])[]>> {
  const attribution: WorkAttribution = { purpose, turnId: null, output: 'machine_inference' };
  const vectors = await embeddings.port.embed(texts, attribution);
  if (!vectors.ok) return vectors;
  if (vectors.value.length !== texts.length) return unavailable('embeddings', `expected ${texts.length} vectors, got ${vectors.value.length}`);
  for (const vector of vectors.value) {
    if (vector.length !== embeddings.space.dimensions || !vector.every((x) => Number.isFinite(x))) {
      return unavailable('embeddings', `vectors must be ${embeddings.space.dimensions} finite numbers for space ${embeddings.space.name}`);
    }
  }
  return vectors;
}

/** Accumulated model and embedding usage of one operation. Nothing is reported as free. */
export interface InferenceUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  embeddingCalls: number;
  embeddedTexts: number;
}

export function emptyUsage(): InferenceUsage {
  return { modelCalls: 0, inputTokens: 0, outputTokens: 0, embeddingCalls: 0, embeddedTexts: 0 };
}

export function addUsage(into: InferenceUsage, from: InferenceUsage): void {
  into.modelCalls += from.modelCalls;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.embeddingCalls += from.embeddingCalls;
  into.embeddedTexts += from.embeddedTexts;
}

/** Reciprocal-rank fusion of ranked id lists; ties keep first-list order. */
export function fuseRankings(lists: readonly (readonly string[])[], limit: number): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank)));
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

/** End of the UTC day containing `at`: the expiry of a same-day note. */
export function endOfUtcDay(at: Date): string {
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1) - 1);
  return end.toISOString();
}

export function boundedText(value: string, field: string, max: number): Result<string> {
  const text = value.trim();
  if (text.length === 0) return invalid(`${field} must be non-empty`);
  if (text.length > max) return invalid(`${field} must be at most ${max} characters`);
  return ok(text);
}

export function parseInstant(raw: string, field: string): Result<string> {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : /Z|[+-]\d{2}:?\d{2}$/.test(raw) ? new Date(raw) : null;
  if (date === null || Number.isNaN(date.getTime())) return invalid(`${field} must be a YYYY-MM-DD date or an ISO instant with a zone`);
  return ok(date.toISOString());
}
