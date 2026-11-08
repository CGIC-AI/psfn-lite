import { TRUST_LEVELS, isOneOf, ok, type ContactId, type Result } from '../shared/index.ts';
import type { ChannelIdentity, ContactAuthorityPort, ContactRecord, ContactResolution, ContactStorePort } from './types.ts';

/** Merge chains longer than this are treated as corrupt rather than followed. */
const MAX_MERGE_HOPS = 8;

/**
 * Resolves a verified channel identity to authority over the contact store.
 * A merged contact never answers for itself: resolution follows it to the
 * survivor and evaluates the survivor's status and consent, so a merge cannot
 * resurrect a blocked or revoked person. Archived contacts and broken merge
 * chains are unknown; anything but granted consent is untracked.
 */
export function createContactAuthority(store: ContactStorePort): ContactAuthorityPort {
  return {
    async resolve(identity: ChannelIdentity): Promise<Result<ContactResolution>> {
      const found = await store.findByIdentity(identity);
      if (!found.ok) return found;
      if (found.value === null) return ok({ kind: 'unknown' });
      const survivor = await followMerges(store, found.value);
      if (!survivor.ok) return survivor;
      return ok(survivor.value === null ? { kind: 'unknown' } : authorityOf(survivor.value));
    },
  };
}

async function followMerges(store: ContactStorePort, start: ContactRecord): Promise<Result<ContactRecord | null>> {
  let current = start;
  const seen = new Set<ContactId>([current.contactId]);
  for (let hop = 0; current.status.kind === 'merged'; hop += 1) {
    const target = current.status.into;
    if (hop >= MAX_MERGE_HOPS || seen.has(target)) return ok(null);
    seen.add(target);
    const next = await store.get(target);
    if (!next.ok) return next.error.kind === 'not_found' ? ok(null) : next;
    current = next.value;
  }
  return ok(current);
}

function authorityOf(record: ContactRecord): ContactResolution {
  switch (record.status.kind) {
    case 'archived':
    case 'merged':
      return { kind: 'unknown' };
    case 'blocked':
      return { kind: 'blocked', contactId: record.contactId };
    case 'active':
      break;
  }
  if (record.consent !== 'granted') return { kind: 'untracked' };
  if (!isOneOf(TRUST_LEVELS, record.trust)) return { kind: 'unknown' };
  return { kind: 'known', contactId: record.contactId, trust: record.trust };
}

