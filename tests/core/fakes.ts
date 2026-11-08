/**
 * Test-only fakes of core-owned ports. They implement the documented
 * compare-and-set and idempotency contracts so behavior tests exercise real
 * failure paths. Nothing here is used by production code.
 */
import {
  BASELINE_DISCLOSURE_POLICY,
  createTrustedIngress,
  fail,
  notFound,
  ok,
  unavailable,
  type ActivityId,
  type ActivityLogPort,
  type ActivityRecord,
  type CallerAuthenticatorPort,
  type ChannelIdentity,
  type Clock,
  type CompanionId,
  type ContactAuthorityPort,
  type ContactId,
  type ContactResolution,
  type HostAttestation,
  type Id,
  type IdSource,
  type IdempotencyKey,
  type Result,
  type SessionArchivePort,
  type SessionEntry,
  type SessionHead,
  type SessionId,
  type SurfaceId,
  type TrustedIngress,
  type TrustedTurnScope,
  type TurnId,
  type TurnLedgerPort,
  type TurnRecord,
} from '../../packages/core/src/index.ts';

export const id = <K extends string>(raw: string): Id<K> => raw as Id<K>;

export class FixedClock implements Clock {
  constructor(private current = new Date('2030-01-01T00:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdSource {
  private counter = 0;
  next<Kind extends string>(kind: Kind): Id<Kind> {
    this.counter += 1;
    return id<Kind>(`${kind}-${this.counter}`);
  }
}

export class FakeTurnLedger implements TurnLedgerPort {
  readonly turns = new Map<TurnId, TurnRecord>();
  private readonly heads = new Map<SessionId, SessionHead>();

  head(sessionId: SessionId): Promise<Result<SessionHead>> {
    return Promise.resolve(ok(this.headOf(sessionId)));
  }

  get(turnId: TurnId): Promise<Result<TurnRecord>> {
    const record = this.turns.get(turnId);
    return Promise.resolve(record === undefined ? notFound(`turn ${turnId}`) : ok(record));
  }

  findByIdempotencyKey(sessionId: SessionId, key: IdempotencyKey): Promise<Result<TurnRecord | null>> {
    const match = [...this.turns.values()].find((t) => t.sessionId === sessionId && t.idempotencyKey === key);
    return Promise.resolve(ok(match ?? null));
  }

  open(record: TurnRecord): Promise<Result<TurnRecord>> {
    const head = this.headOf(record.sessionId);
    if (head.openTurnId !== null || head.revision !== record.baseRevision) {
      return Promise.resolve(fail({ kind: 'conflict', reason: 'stale_revision', detail: 'head moved' }));
    }
    this.turns.set(record.turnId, record);
    this.heads.set(record.sessionId, { ...head, openTurnId: record.turnId });
    return Promise.resolve(ok(record));
  }

  settle(input: Parameters<TurnLedgerPort['settle']>[0]): Promise<Result<TurnRecord>> {
    const record = this.turns.get(input.turnId);
    if (record === undefined) return Promise.resolve(notFound(`turn ${input.turnId}`));
    const head = this.headOf(record.sessionId);
    if (head.revision !== input.expectedRevision || head.openTurnId !== input.turnId) {
      return Promise.resolve(fail({ kind: 'conflict', reason: 'stale_revision', detail: 'head moved' }));
    }
    const revision = head.revision + 1;
    const settled: TurnRecord = { ...record, settlement: { outcome: input.outcome, settledAt: input.settledAt, revision } };
    this.turns.set(record.turnId, settled);
    this.heads.set(record.sessionId, { sessionId: record.sessionId, revision, openTurnId: null });
    return Promise.resolve(ok(settled));
  }

  private headOf(sessionId: SessionId): SessionHead {
    return this.heads.get(sessionId) ?? { sessionId, revision: 0, openTurnId: null };
  }
}

export class FakeArchive implements SessionArchivePort {
  readonly entries: SessionEntry[] = [];
  failNext = false;

  append(entries: readonly SessionEntry[]): Promise<Result<void>> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.resolve(unavailable('session_archive', 'disk unavailable'));
    }
    for (const entry of entries) {
      if (!this.entries.some((e) => e.entryId === entry.entryId)) this.entries.push(entry);
    }
    return Promise.resolve(ok(undefined));
  }

  readTail(sessionId: SessionId, limit: number): Promise<Result<readonly SessionEntry[]>> {
    return Promise.resolve(ok(this.entries.filter((e) => e.sessionId === sessionId).slice(-limit)));
  }
}

export class FakeActivityLog implements ActivityLogPort {
  readonly records = new Map<ActivityId, ActivityRecord>();

  insert(record: ActivityRecord): Promise<Result<ActivityRecord>> {
    this.records.set(record.id, record);
    return Promise.resolve(ok(record));
  }

  get(activityId: ActivityId): Promise<Result<ActivityRecord>> {
    const record = this.records.get(activityId);
    return Promise.resolve(record === undefined ? notFound(`activity ${activityId}`) : ok(record));
  }

  update(record: ActivityRecord, expectedRevision: number): Promise<Result<ActivityRecord>> {
    const current = this.records.get(record.id);
    if (current?.revision !== expectedRevision) {
      return Promise.resolve(fail({ kind: 'conflict', reason: 'stale_revision', detail: 'activity moved' }));
    }
    this.records.set(record.id, record);
    return Promise.resolve(ok(record));
  }
}

/** Evidence is a token the fake host maps to an attestation; unknown tokens fail authentication. */
export class FakeAuthenticator implements CallerAuthenticatorPort {
  readonly tokens = new Map<string, unknown>();

  authenticate(evidence: unknown): Promise<Result<HostAttestation>> {
    const attestation = typeof evidence === 'string' ? this.tokens.get(evidence) : undefined;
    if (attestation === undefined) return Promise.resolve(fail({ kind: 'denied', reason: 'unknown_authority', detail: 'bad token' }));
    return Promise.resolve(ok(attestation as HostAttestation));
  }
}

export class FakeContacts implements ContactAuthorityPort {
  readonly byIdentity = new Map<string, ContactResolution>();

  resolve(identity: ChannelIdentity): Promise<Result<ContactResolution>> {
    return Promise.resolve(ok(this.byIdentity.get(`${identity.channelKind}:${identity.externalId}`) ?? { kind: 'unknown' }));
  }
}

export const COMPANION: CompanionId = id('companion-1');
export const PI: SurfaceId = id('pi');
export const TOOL_TRANSPORT: SurfaceId = id('mcp');
export const PRIMARY: ContactId = id('contact-primary');
export const FRIEND: ContactId = id('contact-friend');

export function directAttestation(externalId: string, channel: string, surface: SurfaceId = PI): HostAttestation {
  return {
    surface,
    principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId } },
    room: { kind: 'direct', channelId: id<'channel'>(channel) },
    turnKind: 'foreground',
  };
}

/** A standard world: a primary and a trusted friend, plus an internal free-time token. */
export function standardWorld(): {
  ingress: TrustedIngress;
  authenticator: FakeAuthenticator;
  contacts: FakeContacts;
  admit: (token: string) => Promise<TrustedTurnScope>;
} {
  const authenticator = new FakeAuthenticator();
  const contacts = new FakeContacts();
  contacts.byIdentity.set('chat:primary-handle', { kind: 'known', contactId: PRIMARY, trust: 'primary' });
  contacts.byIdentity.set('chat:friend-handle', { kind: 'known', contactId: FRIEND, trust: 'trusted' });
  authenticator.tokens.set('primary-dm', directAttestation('primary-handle', 'dm-primary'));
  authenticator.tokens.set('primary-dm-mcp', directAttestation('primary-handle', 'dm-primary', TOOL_TRANSPORT));
  authenticator.tokens.set('friend-dm', directAttestation('friend-handle', 'dm-friend'));
  authenticator.tokens.set('friend-dm-background', { ...directAttestation('friend-handle', 'dm-friend'), turnKind: 'background' });
  authenticator.tokens.set('free-time', {
    surface: PI,
    principal: { kind: 'companion_internal', purpose: 'free_time' },
    room: { kind: 'self' },
    turnKind: 'background',
  });
  const created = createTrustedIngress({ companionId: COMPANION, authenticator, contacts, policy: BASELINE_DISCLOSURE_POLICY });
  if (!created.ok) throw new Error('baseline policy must be valid');
  const ingress = created.value;
  const admit = async (token: string): Promise<TrustedTurnScope> => {
    const scope = await ingress.admit(token);
    if (!scope.ok) throw new Error(`admission failed for ${token}: ${JSON.stringify(scope.error)}`);
    return scope.value;
  };
  return { ingress, authenticator, contacts, admit };
}
