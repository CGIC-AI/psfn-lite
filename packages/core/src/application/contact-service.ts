import {
  classifyRelationshipChange,
  contactVisibleTo,
  isLowTierTrust,
  isWritable,
  noteVisibleTo,
  validateRelationshipProposal,
  type ChannelIdentity,
  type ContactChange,
  type ContactNote,
  type ContactRecord,
  type ContactStorePort,
  type HumanRelationship,
  type LowTierTrust,
} from '../contacts/index.ts';
import {
  denied,
  invalid,
  isNonEmptyString,
  notFound,
  ok,
  type ChannelPrivacy,
  type Clock,
  type ContactId,
  type IdSource,
  type Result,
} from '../shared/index.ts';
import type { ApprovalPort } from './host-ports.ts';
import { authorOf, isTrustedTurnScope, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';

const LIST_PAGE = 200;
const MAX_LIST_SCAN = 5_000;
const NOTE_MAX_CHARS = 2_000;
const NOTES_IN_LOOKUP = 20;

/** What a caller sees of a contact it may read. */
export interface ContactView {
  readonly contactId: ContactId;
  readonly displayName: string;
  readonly trust: ContactRecord['trust'];
  readonly relationship: HumanRelationship;
  readonly machineIntelligence: boolean;
  readonly status: ContactRecord['status']['kind'];
  readonly mergedInto: ContactId | null;
  readonly identities: readonly { readonly channelKind: string; readonly externalId: string; readonly privacy: ChannelPrivacy | null }[];
  readonly revision: number;
}

export type ContactWriteOutcome =
  | { readonly status: 'applied'; readonly contact: ContactView }
  | { readonly status: 'unchanged'; readonly contact: ContactView }
  | { readonly status: 'proposed'; readonly proposalId: string };

export interface ContactService {
  list(scope: TrustedTurnScope, input: { readonly limit: number }): Promise<Result<readonly ContactView[]>>;
  search(scope: TrustedTurnScope, input: { readonly query: string; readonly limit: number }): Promise<Result<readonly ContactView[]>>;
  lookup(
    scope: TrustedTurnScope,
    input: { readonly contactId: ContactId } | { readonly identity: ChannelIdentity },
  ): Promise<Result<{ readonly contact: ContactView; readonly notes: readonly ContactNote[] }>>;
  note(scope: TrustedTurnScope, input: { readonly contactId: ContactId; readonly text: string }): Promise<Result<ContactNote>>;
  setTrust(scope: TrustedTurnScope, input: { readonly contactId: ContactId; readonly trust: LowTierTrust }): Promise<Result<ContactWriteOutcome>>;
  proposeTrust(scope: TrustedTurnScope, input: { readonly contactId: ContactId; readonly rationale: string }): Promise<Result<ContactWriteOutcome>>;
  setRelationship(
    scope: TrustedTurnScope,
    input: { readonly contactId: ContactId; readonly relationship: HumanRelationship },
  ): Promise<Result<ContactWriteOutcome>>;
  proposeRelationship(
    scope: TrustedTurnScope,
    input: { readonly contactId: ContactId; readonly relationship: HumanRelationship; readonly rationale: string },
  ): Promise<Result<ContactWriteOutcome>>;
  linkIdentity(
    scope: TrustedTurnScope,
    input: { readonly contactId: ContactId; readonly identity: ChannelIdentity; readonly privacy: ChannelPrivacy | null },
  ): Promise<Result<ContactWriteOutcome>>;
  setChannelPrivacy(
    scope: TrustedTurnScope,
    input: { readonly contactId: ContactId; readonly identity: ChannelIdentity; readonly privacy: ChannelPrivacy },
  ): Promise<Result<ContactWriteOutcome>>;
  setMachineIntelligence(
    scope: TrustedTurnScope,
    input: { readonly contactId: ContactId; readonly value: boolean },
  ): Promise<Result<ContactWriteOutcome>>;
  block(scope: TrustedTurnScope, input: { readonly contactId: ContactId; readonly reason: string | null }): Promise<Result<ContactWriteOutcome>>;
  unblock(scope: TrustedTurnScope, input: { readonly contactId: ContactId; readonly reason: string | null }): Promise<Result<ContactWriteOutcome>>;
}

/**
 * Contact reads and companion writes. Every write is visibility-gated: a
 * contact the caller may not read is treated as missing. Agents never write
 * high-tier trust or gated relationships; those become operator proposals, as
 * does linking an identity to a high-tier contact, since that would grant the
 * linked account high-tier authority.
 */
export function createContactService(deps: {
  readonly store: ContactStorePort;
  readonly approvals: ApprovalPort;
  readonly clock: Clock;
  readonly ids: IdSource;
}): ContactService {
  const readVisible = async (scope: TrustedTurnScope, contactId: ContactId): Promise<Result<ContactRecord>> => {
    if (!isTrustedTurnScope(scope)) return untrusted();
    const found = await deps.store.get(contactId);
    if (!found.ok) return found;
    if (!contactVisibleTo(viewerOf(scope), found.value)) return notFound(`contact ${contactId}`);
    return found;
  };

  const writable = async (scope: TrustedTurnScope, contactId: ContactId): Promise<Result<ContactRecord>> => {
    const found = await readVisible(scope, contactId);
    if (!found.ok) return found;
    if (!isWritable(found.value)) return invalid(`contact ${contactId} is ${found.value.status.kind} and is kept as history`);
    return found;
  };

  const change = (scope: TrustedTurnScope, action: string, detail: Readonly<Record<string, unknown>>): ContactChange => ({
    action,
    author: authorOf(scope),
    at: deps.clock.now().toISOString(),
    detail,
  });

  const save = async (
    scope: TrustedTurnScope,
    record: ContactRecord,
    next: Omit<ContactRecord, 'revision' | 'updatedAt'>,
    action: string,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<Result<ContactWriteOutcome>> => {
    const audit = change(scope, action, detail);
    const saved = await deps.store.save({ ...next, updatedAt: audit.at, revision: record.revision + 1 }, record.revision, audit);
    return saved.ok ? ok({ status: 'applied', contact: view(saved.value) }) : saved;
  };

  const propose = async (
    scope: TrustedTurnScope,
    kind: string,
    summary: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<Result<ContactWriteOutcome>> => {
    const submitted = await deps.approvals.submit({ kind, summary, payload, requestedBy: authorOf(scope) });
    return submitted.ok ? ok({ status: 'proposed', proposalId: submitted.value.proposalId }) : submitted;
  };

  const scan = async (scope: TrustedTurnScope, limit: number, match: (record: ContactRecord) => boolean): Promise<Result<ContactView[]>> => {
    if (!isTrustedTurnScope(scope)) return untrusted();
    const viewer = viewerOf(scope);
    const views: ContactView[] = [];
    let after: ContactId | null = null;
    for (let scanned = 0; scanned < MAX_LIST_SCAN && views.length < limit; ) {
      const page = await deps.store.list(LIST_PAGE, after);
      if (!page.ok) return page;
      for (const record of page.value) {
        if (isWritable(record) && contactVisibleTo(viewer, record) && match(record)) views.push(view(record));
        if (views.length >= limit) break;
      }
      scanned += page.value.length;
      const last = page.value.at(-1);
      if (last === undefined || page.value.length < LIST_PAGE) break;
      after = last.contactId;
    }
    return ok(views);
  };

  return {
    list: (scope, input) => scan(scope, input.limit, () => true),

    async search(scope, input) {
      if (!isNonEmptyString(input.query)) return invalid('search query must be non-empty');
      const tokens = input.query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
      return scan(scope, input.limit, (record) => {
        const haystack = [record.contactId, record.displayName, record.trust, record.relationship, ...record.identities.flatMap((i) => [i.channelKind, i.externalId])]
          .join(' ')
          .toLowerCase();
        return tokens.every((token) => haystack.includes(token));
      });
    },

    async lookup(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      let contactId: ContactId;
      if ('contactId' in input) {
        contactId = input.contactId;
      } else {
        const byIdentity = await deps.store.findByIdentity(input.identity);
        if (!byIdentity.ok) return byIdentity;
        if (byIdentity.value === null) return notFound(`contact ${input.identity.channelKind}:${input.identity.externalId}`);
        contactId = byIdentity.value.contactId;
      }
      const found = await readVisible(scope, contactId);
      if (!found.ok) return found;
      const notes = await deps.store.notes(contactId, NOTES_IN_LOOKUP);
      if (!notes.ok) return notes;
      const viewer = viewerOf(scope);
      return ok({ contact: view(found.value), notes: notes.value.filter((note) => noteVisibleTo(viewer, note)) });
    },

    async note(scope, input) {
      const text = input.text.trim();
      if (text.length === 0 || text.length > NOTE_MAX_CHARS) return invalid(`note text must be 1-${NOTE_MAX_CHARS} characters`);
      const found = await writable(scope, input.contactId);
      if (!found.ok) return found;
      return deps.store.appendNote({
        noteId: deps.ids.next('contact_note'),
        contactId: input.contactId,
        text,
        author: authorOf(scope),
        source: scope.audience,
        at: deps.clock.now().toISOString(),
      });
    },

    async setTrust(scope, input) {
      if (!isLowTierTrust(input.trust)) return denied('approval_required', 'high-tier trust is never written directly; use propose_trust');
      const found = await writable(scope, input.contactId);
      if (!found.ok) return found;
      const record = found.value;
      if (!isLowTierTrust(record.trust)) {
        return denied('approval_required', `contact holds ${record.trust} trust; only an operator changes high-tier trust`);
      }
      if (record.trust === input.trust) return ok({ status: 'unchanged', contact: view(record) });
      return save(scope, record, { ...record, trust: input.trust }, 'set_trust', { from: record.trust, to: input.trust });
    },

    async proposeTrust(scope, input) {
      if (!isNonEmptyString(input.rationale)) return invalid('propose_trust needs a rationale');
      const found = await writable(scope, input.contactId);
      if (!found.ok) return found;
      const record = found.value;
      if (!isLowTierTrust(record.trust)) return invalid(`contact already holds ${record.trust} trust`);
      return propose(scope, 'contact.trust.promote', `${record.displayName} (${record.contactId}): ${record.trust} -> trusted`, {
        contactId: record.contactId,
        from: record.trust,
        to: 'trusted',
        expectedRevision: record.revision,
        rationale: input.rationale.trim(),
      });
    },

    async setRelationship(scope, input) {
      const found = await writable(scope, input.contactId);
      if (!found.ok) return found;
      const record = found.value;
      if (record.machineIntelligence?.value === true) {
        return invalid('machine intelligences are not on the human relationship ladder');
      }
      const classified = classifyRelationshipChange(record.relationship, input.relationship);
      switch (classified.kind) {
        case 'unchanged':
          return ok({ status: 'unchanged', contact: view(record) });
        case 'needs_approval':
          return denied('approval_required', classified.reason);
        case 'direct':
          return save(scope, record, { ...record, relationship: input.relationship }, 'set_relationship', {
            from: record.relationship,
            to: input.relationship,
          });
      }
    },

    async proposeRelationship(scope, input) {
      if (!isNonEmptyString(input.rationale)) return invalid('propose_relationship needs a rationale');
      const found = await writable(scope, input.contactId);
      if (!found.ok) return found;
      const record = found.value;
      const valid = validateRelationshipProposal(record.relationship, input.relationship);
      if (!valid.ok) return valid;
      return propose(scope, 'contact.relationship.promote', `${record.displayName} (${record.contactId}): ${record.relationship} -> ${input.relationship}`, {
        contactId: record.contactId,
        from: record.relationship,
        to: input.relationship,
        expectedRevision: record.revision,
        rationale: input.rationale.trim(),
      });
    },

    async linkIdentity(scope, input) {
      const identity = parseIdentity(input.identity);
      if (!identity.ok) return identity;
      const found = await writable(scope, input.contactId);
      if (!found.ok) return found;
      const record = found.value;
      if (record.identities.some((link) => sameIdentity(link, identity.value))) return ok({ status: 'unchanged', contact: view(record) });
      const owner = await deps.store.findByIdentity(identity.value);
      if (!owner.ok) return owner;
      if (owner.value !== null) return invalid('that channel identity already belongs to another contact');
      if (!isLowTierTrust(record.trust)) {
        return propose(scope, 'contact.identity.link', `link ${identity.value.channelKind}:${identity.value.externalId} to ${record.contactId} (${record.trust})`, {
          contactId: record.contactId,
          identity: identity.value,
          privacy: input.privacy,
          expectedRevision: record.revision,
        });
      }
      const link = { ...identity.value, privacy: input.privacy, linkedAt: deps.clock.now().toISOString(), linkedBy: authorOf(scope) };
      return save(scope, record, { ...record, identities: [...record.identities, link] }, 'link_identity', { identity: identity.value });
    },

    async setChannelPrivacy(scope, input) {
      const found = await writable(scope, input.contactId);
      if (!found.ok) return found;
      const record = found.value;
      const index = record.identities.findIndex((link) => sameIdentity(link, input.identity));
      if (index === -1) return notFound(`identity ${input.identity.channelKind}:${input.identity.externalId} on contact ${record.contactId}`);
      const identities = record.identities.map((link, i) => (i === index ? { ...link, privacy: input.privacy } : link));
      return save(scope, record, { ...record, identities }, 'set_channel_privacy', { identity: input.identity, privacy: input.privacy });
    },

    async setMachineIntelligence(scope, input) {
      const found = await writable(scope, input.contactId);
      if (!found.ok) return found;
      const record = found.value;
      if (record.machineIntelligence?.setBy === 'operator' && record.machineIntelligence.value !== input.value) {
        return denied('approval_required', 'an operator classified this contact; only an operator changes it');
      }
      if (record.machineIntelligence?.value === input.value) return ok({ status: 'unchanged', contact: view(record) });
      return save(scope, record, { ...record, machineIntelligence: { value: input.value, setBy: 'companion' } }, 'set_machine_intelligence', {
        value: input.value,
      });
    },

    async block(scope, input) {
      const found = await writable(scope, input.contactId);
      if (!found.ok) return found;
      const record = found.value;
      if (record.trust === 'primary') return denied('approval_required', 'the primary contact is blocked only by an operator');
      if (record.status.kind === 'blocked') return ok({ status: 'unchanged', contact: view(record) });
      const at = deps.clock.now().toISOString();
      return save(scope, record, { ...record, status: { kind: 'blocked', at } }, 'block', { reason: input.reason });
    },

    async unblock(scope, input) {
      const found = await writable(scope, input.contactId);
      if (!found.ok) return found;
      const record = found.value;
      if (record.status.kind !== 'blocked') return ok({ status: 'unchanged', contact: view(record) });
      return save(scope, record, { ...record, status: { kind: 'active' } }, 'unblock', { reason: input.reason });
    },
  };
}

function view(record: ContactRecord): ContactView {
  return {
    contactId: record.contactId,
    displayName: record.displayName,
    trust: record.trust,
    relationship: record.relationship,
    machineIntelligence: record.machineIntelligence?.value ?? false,
    status: record.status.kind,
    mergedInto: record.status.kind === 'merged' ? record.status.into : null,
    identities: record.identities.map((link) => ({ channelKind: link.channelKind, externalId: link.externalId, privacy: link.privacy })),
    revision: record.revision,
  };
}

function parseIdentity(identity: ChannelIdentity): Result<ChannelIdentity> {
  if (!isNonEmptyString(identity.channelKind) || !isNonEmptyString(identity.externalId)) {
    return invalid('identity needs channelKind and externalId');
  }
  return ok({ channelKind: identity.channelKind.trim(), externalId: identity.externalId.trim() });
}

function sameIdentity(a: ChannelIdentity, b: ChannelIdentity): boolean {
  return a.channelKind === b.channelKind && a.externalId === b.externalId;
}

function untrusted() {
  return denied('unknown_authority', 'scope was not admitted by ingress');
}
