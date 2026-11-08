export type {
  ChannelIdentity,
  ContactAuthorityPort,
  ContactChange,
  ContactIdentityLink,
  ContactNote,
  ContactRecord,
  ContactResolution,
  ContactStatus,
  ContactStorePort,
  HumanRelationship,
  MachineIntelligenceFlag,
  TrackingConsent,
} from './types.ts';
export { HUMAN_RELATIONSHIPS, TRACKING_CONSENTS } from './types.ts';
export { createContactAuthority } from './authority.ts';
export {
  LOW_TIER_TRUST,
  classifyRelationshipChange,
  contactVisibleTo,
  isLowTierTrust,
  isWritable,
  noteVisibleTo,
  validateRelationshipProposal,
  type LowTierTrust,
  type RelationshipChange,
} from './policy.ts';
export { contactTool } from './tool.ts';
