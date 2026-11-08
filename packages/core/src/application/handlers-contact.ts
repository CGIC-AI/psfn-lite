import { HUMAN_RELATIONSHIPS, LOW_TIER_TRUST } from '../contacts/index.ts';
import { CHANNEL_PRIVACY_LEVELS } from '../shared/index.ts';
import { LIMIT, withArgs, type ArgReader } from './arguments.ts';
import type { ContactService } from './contact-service.ts';
import type { ActionHandler } from './dispatch.ts';

const identityOf = (a: ArgReader) => ({ channelKind: a.string('channelKind'), externalId: a.string('externalId') });

/** `contact` tool actions over the contact service. */
export function contactHandlers(contacts: ContactService): Readonly<Record<string, ActionHandler>> {
  return {
    list: (scope, args) => withArgs(args, ['limit'], (a) => ({ limit: a.integer('limit', LIMIT) }), (input) => contacts.list(scope, input)),
    search: (scope, args) =>
      withArgs(args, ['query', 'limit'], (a) => ({ query: a.string('query'), limit: a.integer('limit', LIMIT) }), (input) => contacts.search(scope, input)),
    lookup: (scope, args) =>
      withArgs(
        args,
        ['contactId', 'channelKind', 'externalId'],
        (a) => (a.has('contactId') ? { contactId: a.id('contact', 'contactId') } : { identity: identityOf(a) }),
        (input) => contacts.lookup(scope, input),
      ),
    note: (scope, args) =>
      withArgs(args, ['contactId', 'text'], (a) => ({ contactId: a.id('contact', 'contactId'), text: a.string('text') }), (input) =>
        contacts.note(scope, input),
      ),
    set_trust: (scope, args) =>
      withArgs(
        args,
        ['contactId', 'trust'],
        (a) => ({ contactId: a.id('contact', 'contactId'), trust: a.oneOf('trust', LOW_TIER_TRUST) }),
        (input) => contacts.setTrust(scope, input),
      ),
    propose_trust: (scope, args) =>
      withArgs(
        args,
        ['contactId', 'rationale'],
        (a) => ({ contactId: a.id('contact', 'contactId'), rationale: a.string('rationale') }),
        (input) => contacts.proposeTrust(scope, input),
      ),
    set_relationship: (scope, args) =>
      withArgs(
        args,
        ['contactId', 'relationship'],
        (a) => ({ contactId: a.id('contact', 'contactId'), relationship: a.oneOf('relationship', HUMAN_RELATIONSHIPS) }),
        (input) => contacts.setRelationship(scope, input),
      ),
    propose_relationship: (scope, args) =>
      withArgs(
        args,
        ['contactId', 'relationship', 'rationale'],
        (a) => ({
          contactId: a.id('contact', 'contactId'),
          relationship: a.oneOf('relationship', HUMAN_RELATIONSHIPS),
          rationale: a.string('rationale'),
        }),
        (input) => contacts.proposeRelationship(scope, input),
      ),
    link_identity: (scope, args) =>
      withArgs(
        args,
        ['contactId', 'channelKind', 'externalId', 'privacy'],
        (a) => ({
          contactId: a.id('contact', 'contactId'),
          identity: identityOf(a),
          privacy: a.optionalOneOf('privacy', CHANNEL_PRIVACY_LEVELS),
        }),
        (input) => contacts.linkIdentity(scope, input),
      ),
    set_channel_privacy: (scope, args) =>
      withArgs(
        args,
        ['contactId', 'channelKind', 'externalId', 'privacy'],
        (a) => ({ contactId: a.id('contact', 'contactId'), identity: identityOf(a), privacy: a.oneOf('privacy', CHANNEL_PRIVACY_LEVELS) }),
        (input) => contacts.setChannelPrivacy(scope, input),
      ),
    set_machine_intelligence: (scope, args) =>
      withArgs(
        args,
        ['contactId', 'isMachineIntelligence'],
        (a) => ({ contactId: a.id('contact', 'contactId'), value: a.boolean('isMachineIntelligence') }),
        (input) => contacts.setMachineIntelligence(scope, input),
      ),
    block: (scope, args) =>
      withArgs(args, ['contactId', 'reason'], (a) => ({ contactId: a.id('contact', 'contactId'), reason: a.optionalString('reason') }), (input) =>
        contacts.block(scope, input),
      ),
    unblock: (scope, args) =>
      withArgs(args, ['contactId', 'reason'], (a) => ({ contactId: a.id('contact', 'contactId'), reason: a.optionalString('reason') }), (input) =>
        contacts.unblock(scope, input),
      ),
  };
}
