import {
  HUMAN_RELATIONSHIPS,
  TRACKING_CONSENTS,
  type ChannelIdentity,
  type ContactRecord,
  type ContactStorePort,
  type HumanRelationship,
  type TrackingConsent,
} from '../contacts/index.ts';
import {
  SENSITIVITIES,
  TRUST_LEVELS,
  invalid,
  isNonEmptyString,
  isOneOf,
  ok,
  sensitivityRank,
  type Author,
  type Clock,
  type ContactId,
  type IdSource,
  type Result,
  type Sensitivity,
  type TrustLevel,
} from '../shared/index.ts';

/** Consent from most to least restrictive; a merge keeps the more restrictive side. */
const CONSENT_RESTRICTIVENESS: readonly TrackingConsent[] = ['revoked', 'denied', 'pending', 'granted'];
/** Trust from least to most privileged. */
const TRUST_ORDER: readonly TrustLevel[] = ['public', 'regular', 'trusted', 'primary'];

export interface RegisterContactInput {
  readonly displayName: string;
  readonly identity: ChannelIdentity;
  readonly trust: TrustLevel;
  readonly relationship: HumanRelationship;
  readonly consent: TrackingConsent;
  readonly sensitivity: Sensitivity;
}

/**
 * Operator-only contact lifecycle: registration, tracking consent, merges and
 * archival. These run with an operator author from the host's administration
 * surface and are not model-facing tools.
 */
export interface ContactAdministration {
  register(operator: string, input: RegisterContactInput): Promise<Result<ContactRecord>>;
  setConsent(operator: string, contactId: ContactId, consent: TrackingConsent): Promise<Result<ContactRecord>>;
  setTrust(operator: string, contactId: ContactId, trust: TrustLevel): Promise<Result<ContactRecord>>;
  /**
   * Folds `sourceId` into `survivorId`. The merge never widens authority: the
   * survivor keeps the lower trust, the more restrictive consent, the higher
   * sensitivity, and stays blocked if either side was blocked.
   */
  merge(operator: string, sourceId: ContactId, survivorId: ContactId): Promise<Result<ContactRecord>>;
  archive(operator: string, contactId: ContactId): Promise<Result<ContactRecord>>;
}

export function createContactAdministration(deps: {
  readonly store: ContactStorePort;
  readonly clock: Clock;
  readonly ids: IdSource;
}): ContactAdministration {
  const author = (operator: string): Result<Author> =>
    isNonEmptyString(operator) ? ok({ kind: 'operator', actor: operator.trim() }) : invalid('operator actor must be named');

  const update = async (
    operator: string,
    contactId: ContactId,
    action: string,
    apply: (record: ContactRecord) => Result<ContactRecord>,
  ): Promise<Result<ContactRecord>> => {
    const actor = author(operator);
    if (!actor.ok) return actor;
    const found = await deps.store.get(contactId);
    if (!found.ok) return found;
    const next = apply(found.value);
    if (!next.ok) return next;
    const at = deps.clock.now().toISOString();
    return deps.store.save({ ...next.value, updatedAt: at, revision: found.value.revision + 1 }, found.value.revision, {
      action,
      author: actor.value,
      at,
      detail: {},
    });
  };

  return {
    async register(operator, input) {
      const actor = author(operator);
      if (!actor.ok) return actor;
      const issues: string[] = [];
      if (!isNonEmptyString(input.displayName)) issues.push('displayName must be non-empty');
      if (!isNonEmptyString(input.identity.channelKind) || !isNonEmptyString(input.identity.externalId)) issues.push('identity is incomplete');
      if (!isOneOf(TRUST_LEVELS, input.trust)) issues.push('trust is unknown');
      if (!isOneOf(HUMAN_RELATIONSHIPS, input.relationship)) issues.push('relationship is unknown');
      if (!isOneOf(TRACKING_CONSENTS, input.consent)) issues.push('consent is unknown');
      if (!isOneOf(SENSITIVITIES, input.sensitivity)) issues.push('sensitivity is unknown');
      if (issues.length > 0) return invalid(...issues);
      const at = deps.clock.now().toISOString();
      return deps.store.create(
        {
          contactId: deps.ids.next('contact'),
          displayName: input.displayName.trim(),
          trust: input.trust,
          relationship: input.relationship,
          machineIntelligence: null,
          consent: input.consent,
          status: { kind: 'active' },
          sensitivity: input.sensitivity,
          identities: [{ ...input.identity, privacy: null, linkedAt: at, linkedBy: actor.value }],
          createdAt: at,
          updatedAt: at,
          revision: 1,
        },
        { action: 'register', author: actor.value, at, detail: { consent: input.consent, trust: input.trust } },
      );
    },

    setConsent: (operator, contactId, consent) =>
      update(operator, contactId, `consent:${consent}`, (record) =>
        isOneOf(TRACKING_CONSENTS, consent) ? ok({ ...record, consent }) : invalid('consent is unknown'),
      ),

    setTrust: (operator, contactId, trust) =>
      update(operator, contactId, `trust:${trust}`, (record) => (isOneOf(TRUST_LEVELS, trust) ? ok({ ...record, trust }) : invalid('trust is unknown'))),

    async merge(operator, sourceId, survivorId) {
      const actor = author(operator);
      if (!actor.ok) return actor;
      if (sourceId === survivorId) return invalid('a contact cannot be merged into itself');
      const [source, survivor] = await Promise.all([deps.store.get(sourceId), deps.store.get(survivorId)]);
      if (!source.ok) return source;
      if (!survivor.ok) return survivor;
      for (const record of [source.value, survivor.value]) {
        if (record.status.kind === 'merged' || record.status.kind === 'archived') {
          return invalid(`contact ${record.contactId} is ${record.status.kind}`);
        }
      }
      if ((source.value.machineIntelligence?.value ?? false) !== (survivor.value.machineIntelligence?.value ?? false)) {
        return invalid('cannot merge human and machine-intelligence contacts');
      }
      const at = deps.clock.now().toISOString();
      const blocked = source.value.status.kind === 'blocked' ? source.value.status : survivor.value.status;
      const merged: ContactRecord = {
        ...survivor.value,
        trust: lower(TRUST_ORDER, source.value.trust, survivor.value.trust),
        consent: lower(CONSENT_RESTRICTIVENESS, source.value.consent, survivor.value.consent),
        sensitivity: sensitivityRank(source.value.sensitivity) > sensitivityRank(survivor.value.sensitivity) ? source.value.sensitivity : survivor.value.sensitivity,
        status: blocked.kind === 'blocked' ? blocked : survivor.value.status,
        identities: [...survivor.value.identities, ...source.value.identities],
        updatedAt: at,
        revision: survivor.value.revision + 1,
      };
      const folded: ContactRecord = {
        ...source.value,
        status: { kind: 'merged', into: survivorId, at },
        identities: [],
        updatedAt: at,
        revision: source.value.revision + 1,
      };
      const result = await deps.store.merge(
        folded,
        merged,
        { source: source.value.revision, survivor: survivor.value.revision },
        { action: 'merge', author: actor.value, at, detail: { source: sourceId, survivor: survivorId } },
      );
      return result.ok ? ok(result.value.survivor) : result;
    },

    archive: (operator, contactId) =>
      update(operator, contactId, 'archive', (record) =>
        record.status.kind === 'merged' ? invalid('merged contacts are already history') : ok({ ...record, status: { kind: 'archived', at: deps.clock.now().toISOString() } }),
      ),
  };
}

/** The earlier of two values in `order`. */
function lower<T>(order: readonly T[], a: T, b: T): T {
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}
