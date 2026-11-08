import type { Audience, Author, ChannelPrivacy, ContactId, Result, Sensitivity, TrustLevel } from '../shared/index.ts';

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

export const HUMAN_RELATIONSHIPS = ['stranger', 'acquaintance', 'friend', 'family', 'partner'] as const;
export type HumanRelationship = (typeof HUMAN_RELATIONSHIPS)[number];

/**
 * Tracking consent. Only `granted` contacts carry authority; `pending` and
 * `denied` were never approved and `revoked` withdrew an earlier approval.
 */
export const TRACKING_CONSENTS = ['pending', 'granted', 'denied', 'revoked'] as const;
export type TrackingConsent = (typeof TRACKING_CONSENTS)[number];

/**
 * Lifecycle status. A merged contact points at its survivor and never carries
 * authority of its own; an archived contact is history only.
 */
export type ContactStatus =
  | { readonly kind: 'active' }
  | { readonly kind: 'blocked'; readonly at: string }
  | { readonly kind: 'merged'; readonly into: ContactId; readonly at: string }
  | { readonly kind: 'archived'; readonly at: string };

export interface ContactIdentityLink extends ChannelIdentity {
  /** Recorded as provenance evidence only; channel privacy never gates disclosure. */
  readonly privacy: ChannelPrivacy | null;
  readonly linkedAt: string;
  readonly linkedBy: Author;
}

/** Whether a contact is another machine intelligence, and who said so. Operator corrections win. */
export interface MachineIntelligenceFlag {
  readonly value: boolean;
  readonly setBy: 'companion' | 'operator';
}

export interface ContactRecord {
  readonly contactId: ContactId;
  readonly displayName: string;
  readonly trust: TrustLevel;
  readonly relationship: HumanRelationship;
  readonly machineIntelligence: MachineIntelligenceFlag | null;
  readonly consent: TrackingConsent;
  readonly status: ContactStatus;
  /** Admission a viewer needs to read this record. Human contacts default to personal. */
  readonly sensitivity: Sensitivity;
  readonly identities: readonly ContactIdentityLink[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

/** An attributed, append-only note. It is readable where material from its source audience is. */
export interface ContactNote {
  readonly noteId: string;
  readonly contactId: ContactId;
  readonly text: string;
  readonly author: Author;
  readonly source: Audience;
  readonly at: string;
}

/** One audited change; every contact write carries one. */
export interface ContactChange {
  readonly action: string;
  readonly author: Author;
  readonly at: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Durable contact storage. Policy lives in core; the store only enforces
 * compare-and-set revisions and that one channel identity belongs to at most
 * one contact (an `identity_conflict`).
 */
export interface ContactStorePort {
  get(contactId: ContactId): Promise<Result<ContactRecord>>;
  findByIdentity(identity: ChannelIdentity): Promise<Result<ContactRecord | null>>;
  /** Every contact in id order, including merged and archived ones. */
  list(limit: number, afterContactId: ContactId | null): Promise<Result<readonly ContactRecord[]>>;
  create(record: ContactRecord, change: ContactChange): Promise<Result<ContactRecord>>;
  save(record: ContactRecord, expectedRevision: number, change: ContactChange): Promise<Result<ContactRecord>>;
  /** Moves identities and marks the source merged in one transaction. */
  merge(
    source: ContactRecord,
    survivor: ContactRecord,
    expected: { readonly source: number; readonly survivor: number },
    change: ContactChange,
  ): Promise<Result<{ readonly source: ContactRecord; readonly survivor: ContactRecord }>>;
  appendNote(note: ContactNote): Promise<Result<ContactNote>>;
  notes(contactId: ContactId, limit: number): Promise<Result<readonly ContactNote[]>>;
}
