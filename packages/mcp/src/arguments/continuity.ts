import { CHANNEL_PRIVACY_LEVELS, CONTINUITY_OCCASIONS, HUMAN_RELATIONSHIPS, LOW_TIER_TRUST } from '../core.ts';
import { NO_ARGUMENTS, limit, optional, required, schema, type ToolArguments } from '../schema.ts';

const sessionIdOptional = optional(schema.id('Session id (default: the current conversation’s session).'));

export const SESSION_ARGUMENTS: ToolArguments = {
  list: { limit: limit() },
  search: {
    query: required(schema.nonEmpty('Search text.')),
    sessionId: optional(schema.id('Restrict to one session.')),
    limit: limit(),
    summarize: optional(schema.boolean('Add a machine summary of the hits (a model call).')),
  },
  grep: {
    pattern: required(schema.nonEmpty('Literal text to find.')),
    caseSensitive: optional(schema.boolean('Match case (default false).')),
    sessionId: optional(schema.id('Restrict to one session.')),
    limit: limit(),
  },
  messages: { sessionId: sessionIdOptional, limit: limit() },
  continuity_list: { sessionId: sessionIdOptional, limit: limit() },
  new: NO_ARGUMENTS,
  resume: { sessionId: required(schema.id('Session to resume.')) },
  wake_return: {
    sessionId: sessionIdOptional,
    summary: required(schema.nonEmpty('What to carry back into the conversation.')),
    occasion: required(schema.oneOf('Why the return is recorded.', CONTINUITY_OCCASIONS)),
    nextAnchor: optional(schema.nonEmpty('Where to pick up next.')),
  },
  start_focus: { sessionId: sessionIdOptional, focus: required(schema.nonEmpty('What the focus is on.')) },
  complete_focus: { sessionId: sessionIdOptional, knowledge: optional(schema.nonEmpty('What the focus produced.')) },
};

const contactId = required(schema.id('Contact id.'));
const channelKind = required(schema.nonEmpty('Channel kind of the identity.'));
const externalId = required(schema.nonEmpty('External id on that channel.'));
const privacy = schema.oneOf('Channel privacy level.', CHANNEL_PRIVACY_LEVELS);
const reason = optional(schema.nonEmpty('Why.'));

export const CONTACT_ARGUMENTS: ToolArguments = {
  list: { limit: limit() },
  search: { query: required(schema.nonEmpty('Name or note text.')), limit: limit() },
  lookup: {
    contactId: optional(schema.id('Contact id; or give channelKind and externalId instead.')),
    channelKind: optional(schema.nonEmpty('Channel kind, with externalId, when no contactId is given.')),
    externalId: optional(schema.nonEmpty('External id, with channelKind, when no contactId is given.')),
  },
  note: { contactId, text: required(schema.nonEmpty('Note text.')) },
  set_trust: { contactId, trust: required(schema.oneOf('Low-tier trust level; higher tiers need propose_trust.', LOW_TIER_TRUST)) },
  propose_trust: { contactId, rationale: required(schema.nonEmpty('Why the trust change is proposed.')) },
  set_relationship: { contactId, relationship: required(schema.oneOf('Relationship.', HUMAN_RELATIONSHIPS)) },
  propose_relationship: {
    contactId,
    relationship: required(schema.oneOf('Relationship.', HUMAN_RELATIONSHIPS)),
    rationale: required(schema.nonEmpty('Why the change is proposed.')),
  },
  link_identity: { contactId, channelKind, externalId, privacy: optional(privacy) },
  set_channel_privacy: { contactId, channelKind, externalId, privacy: required(privacy) },
  set_machine_intelligence: { contactId, isMachineIntelligence: required(schema.boolean('Whether the contact is a machine intelligence.')) },
  block: { contactId, reason },
  unblock: { contactId, reason },
};
