import {
  canViewerRead,
  invalid,
  ok,
  type Result,
  type TrustLevel,
  type Viewer,
} from '../shared/index.ts';
import { HUMAN_RELATIONSHIPS, type ContactNote, type ContactRecord, type HumanRelationship } from './types.ts';

/**
 * Contact rules ported from the donor (`src/system/trust/types.ts`,
 * `src/core/contacts/relationship-progression.ts`,
 * `src/core/contacts/contact-viewer-access.ts`): agents never write high-tier
 * trust, family and partner relationships need approval, and contact records
 * are readable only where the viewer's admission includes their sensitivity.
 */

export const LOW_TIER_TRUST = ['public', 'regular'] as const;
export type LowTierTrust = (typeof LOW_TIER_TRUST)[number];

export function isLowTierTrust(trust: TrustLevel): trust is LowTierTrust {
  return trust === 'public' || trust === 'regular';
}

export function isApprovalGatedRelationship(relationship: HumanRelationship): boolean {
  return relationship === 'family' || relationship === 'partner';
}

export function relationshipRank(relationship: HumanRelationship): number {
  return HUMAN_RELATIONSHIPS.indexOf(relationship);
}

export type RelationshipChange =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'direct' }
  | { readonly kind: 'needs_approval'; readonly reason: string };

/**
 * One rank up the human ladder applies directly. Anything touching family or
 * partner, any downgrade and any skip needs operator approval.
 */
export function classifyRelationshipChange(from: HumanRelationship, to: HumanRelationship): RelationshipChange {
  if (from === to) return { kind: 'unchanged' };
  if (isApprovalGatedRelationship(to) || isApprovalGatedRelationship(from)) {
    return { kind: 'needs_approval', reason: 'family and partner relationships change only with operator approval' };
  }
  const step = relationshipRank(to) - relationshipRank(from);
  if (step < 0) return { kind: 'needs_approval', reason: 'relationship downgrades require operator review' };
  if (step > 1) return { kind: 'needs_approval', reason: 'relationships progress one classification at a time' };
  return { kind: 'direct' };
}

/** A proposal may only ask for the next gated rank: friend to family, or family to partner. */
export function validateRelationshipProposal(from: HumanRelationship, to: HumanRelationship): Result<void> {
  if (!isApprovalGatedRelationship(to)) return invalid('propose_relationship proposes only family or partner');
  if (relationshipRank(to) - relationshipRank(from) !== 1) {
    return invalid(`gated relationships progress one classification at a time (${from} cannot become ${to})`);
  }
  return ok(undefined);
}

/** Whether a viewer may read a contact record at all. */
export function contactVisibleTo(viewer: Viewer, record: ContactRecord): boolean {
  if (record.status.kind === 'archived') return false;
  if (viewer.audience.kind === 'self' && !viewer.worker) return true;
  return viewer.admitted.includes(record.sensitivity);
}

/** A note is readable where material from the audience it was written in is. */
export function noteVisibleTo(viewer: Viewer, note: ContactNote): boolean {
  return canViewerRead(viewer, note.source);
}

/** Whether a contact may be the subject of writes: merged and archived contacts are history. */
export function isWritable(record: ContactRecord): boolean {
  return record.status.kind === 'active' || record.status.kind === 'blocked';
}
