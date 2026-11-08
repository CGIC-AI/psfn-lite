/**
 * The on-disk format of one session's canonical history: one JSON line per
 * entry, each committing to its predecessor by hash.
 *
 *   {"v":1,"seq":n,"prev":"<hash of n-1 or empty>","hash":"<sha256(prev + canonical(entry))>","entry":{...}}
 *
 * Parsing distinguishes a torn tail (an unterminated final fragment, the
 * signature of a crash mid-append) from corruption (anything else that fails
 * to verify). Only the former is repairable.
 */
import { createHash } from 'node:crypto';
import { isRecord, type ArchivedEntry, type SessionEntry, type SessionId } from '../core.ts';
import { canonicalJson } from '../canonical-json.ts';

export const HISTORY_LINE_VERSION = 1;

export function chainHash(prev: string, entry: SessionEntry): string {
  return createHash('sha256').update(prev).update(canonicalJson(entry)).digest('hex');
}

export function serializeLine(archived: ArchivedEntry, prev: string): string {
  return `${canonicalJson({ v: HISTORY_LINE_VERSION, seq: archived.seq, prev, hash: archived.hash, entry: archived.entry })}\n`;
}

export function serializeChain(chain: readonly ArchivedEntry[]): string {
  return chain.map((archived, i) => serializeLine(archived, i === 0 ? '' : (chain[i - 1] as ArchivedEntry).hash)).join('');
}

export type ParsedChain =
  | { readonly kind: 'intact'; readonly chain: ArchivedEntry[] }
  /** Verified prefix plus the unterminated fragment after `validBytes`. */
  | { readonly kind: 'torn'; readonly chain: ArchivedEntry[]; readonly validBytes: number }
  | { readonly kind: 'corrupt'; readonly detail: string };

export function parseChain(sessionId: SessionId, bytes: Buffer): ParsedChain {
  const chain: ArchivedEntry[] = [];
  let offset = 0;
  let prev = '';
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline === -1) return { kind: 'torn', chain, validBytes: offset };
    const line = bytes.subarray(offset, newline).toString('utf8');
    const seq = chain.length + 1;
    const parsed = parseLine(sessionId, line, seq, prev);
    if (typeof parsed === 'string') return { kind: 'corrupt', detail: `line ${seq}: ${parsed}` };
    chain.push(parsed);
    prev = parsed.hash;
    offset = newline + 1;
  }
  return { kind: 'intact', chain };
}

function parseLine(sessionId: SessionId, line: string, seq: number, prev: string): ArchivedEntry | string {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return 'not JSON';
  }
  if (!isRecord(raw) || raw['v'] !== HISTORY_LINE_VERSION) return 'unknown line format';
  if (raw['seq'] !== seq) return `sequence ${String(raw['seq'])} out of order`;
  if (raw['prev'] !== prev) return 'previous hash does not match';
  const entry = raw['entry'];
  if (!isSessionEntry(entry)) return 'entry is malformed';
  if (entry.sessionId !== sessionId) return 'entry belongs to another session';
  const hash = chainHash(prev, entry);
  if (raw['hash'] !== hash) return 'hash does not match content';
  return { seq, hash, entry };
}

export function isSessionEntry(value: unknown): value is SessionEntry {
  return (
    isRecord(value) &&
    typeof value['entryId'] === 'string' &&
    value['entryId'] !== '' &&
    typeof value['sessionId'] === 'string' &&
    typeof value['turnId'] === 'string' &&
    isRecord(value['origin']) &&
    typeof value['origin']['kind'] === 'string' &&
    typeof value['text'] === 'string' &&
    typeof value['at'] === 'string'
  );
}
