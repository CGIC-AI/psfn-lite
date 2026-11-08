import type { Author, ChannelId, ContactId, Result, Sensitivity, TrustLevel } from '../shared/index.ts';

/** A channel account the host has verified, for example a messaging handle. */
export interface ChannelIdentity {
  readonly channelKind: string;
  readonly externalId: string;
}

/**
 * Core-owned answer to "who is this verified account?". Only `known` carries
 * authority; every other variant rejects at ingress.
 */
export type ContactResolution =
  | { readonly kind: 'known'; readonly contactId: ContactId; readonly trust: TrustLevel }
  | { readonly kind: 'untracked' }
  | { readonly kind: 'blocked'; readonly contactId: ContactId }
  | { readonly kind: 'unknown' };

/** Resolves a verified channel identity to a contact and its trust. */
export interface ContactAuthorityPort {
  resolve(identity: ChannelIdentity): Promise<Result<ContactResolution>>;
}

export type HumanRelationship = 'stranger' | 'acquaintance' | 'friend' | 'family' | 'partner';

export interface ContactSummary {
  readonly contactId: ContactId;
  readonly displayName: string;
  readonly trust: TrustLevel;
  readonly relationship: HumanRelationship | 'machine_intelligence';
  readonly sensitivity: Sensitivity;
}

export interface ContactNote {
  readonly contactId: ContactId;
  readonly text: string;
  readonly author: Author;
  readonly sourceChannelId: ChannelId;
  readonly at: string;
}

/** Audience-filtered contact reads; an invisible contact reads exactly like a missing one. */
export interface ContactReadPort {
  lookup(contactId: ContactId, admitted: readonly Sensitivity[]): Promise<Result<ContactSummary>>;
  search(query: string, admitted: readonly Sensitivity[], limit: number): Promise<Result<readonly ContactSummary[]>>;
}

/**
 * Contact mutations. High-tier trust and family/partner relationships are
 * never written through this port; they become approval proposals.
 */
export interface ContactMutationPort {
  addNote(note: ContactNote): Promise<Result<void>>;
  setLowTierTrust(contactId: ContactId, trust: Extract<TrustLevel, 'public' | 'regular'>, author: Author): Promise<Result<void>>;
  setBlocked(contactId: ContactId, blocked: boolean, author: Author): Promise<Result<void>>;
}
