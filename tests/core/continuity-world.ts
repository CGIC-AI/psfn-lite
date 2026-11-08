/**
 * A synthetic companion world wired from the real core services. Ingress
 * resolves callers through the real contact authority, and the dispatcher
 * carries the real continuity handlers. `wireWorld` takes any port
 * implementations, so the same world runs over in-memory fakes here and over
 * the real storage adapters in integration tests. Every identity is invented.
 */
import {
  BASELINE_DISCLOSURE_POLICY,
  TOOL_INVENTORY,
  createContactAdministration,
  createContactAuthority,
  createContactService,
  createContinuityHandlers,
  createIdentityAdministration,
  createOrientationService,
  createSessionService,
  createToolDispatcher,
  createTrustedIngress,
  createTurnLifecycle,
  createValuesService,
  type ApprovalPort,
  type ContactAdministration,
  type ContactId,
  type ContactStorePort,
  type ContinuityPort,
  type CoreBlockPort,
  type FocusPort,
  type HostAttestation,
  type IdSource,
  type ModelPort,
  type NorthStarPort,
  type PersonaPort,
  type PromptLayerPort,
  type RegisterContactInput,
  type SessionArchivePort,
  type SessionCatalogPort,
  type ToolDispatcher,
  type TranscriptProjectionPort,
  type TrustedTurnScope,
  type TurnLedgerPort,
  type TurnLifecycle,
  type ValuesJournalPort,
} from '../../packages/core/src/index.ts';
import {
  FakeApprovals,
  FakeContactStore,
  FakeContinuity,
  FakeCoreBlocks,
  FakeFocus,
  FakeLayers,
  FakeModel,
  FakeNorthStar,
  FakePersona,
  FakeProjection,
  FakeSessionCatalog,
  FakeValues,
} from './continuity-fakes.ts';
import { COMPANION, FakeArchive, FakeAuthenticator, FakeTurnLedger, FixedClock, PI, SequentialIds, id } from './fakes.ts';

export const OPERATOR = 'operator:test';

export interface WorldPorts {
  readonly clock: FixedClock;
  readonly ids: IdSource;
  readonly authenticator: FakeAuthenticator;
  readonly contactStore: ContactStorePort;
  readonly approvals: ApprovalPort;
  readonly model: ModelPort;
  readonly catalog: SessionCatalogPort;
  readonly archive: SessionArchivePort;
  readonly ledger: TurnLedgerPort;
  readonly projection: TranscriptProjectionPort;
  readonly continuity: ContinuityPort;
  readonly focus: FocusPort;
  readonly layers: PromptLayerPort;
  readonly persona: PersonaPort;
  readonly blocks: CoreBlockPort;
  readonly valuesJournal: ValuesJournalPort;
  readonly northStar: NorthStarPort;
}

function direct(externalId: string, channel: string, turnKind: 'foreground' | 'background' = 'foreground'): HostAttestation {
  return {
    surface: PI,
    principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId } },
    room: { kind: 'direct', channelId: id<'channel'>(channel) },
    turnKind,
  };
}

/** Host tokens for the standard cast: their DMs, a background DM and companion free time. */
export function standardTokens(authenticator: FakeAuthenticator): void {
  authenticator.tokens.set('primary-dm', direct('primary-handle', 'dm-primary'));
  authenticator.tokens.set('friend-dm', direct('friend-handle', 'dm-friend'));
  authenticator.tokens.set('friend-dm-background', direct('friend-handle', 'dm-friend', 'background'));
  authenticator.tokens.set('acq-dm', direct('acq-handle', 'dm-acq'));
  authenticator.tokens.set('stranger-dm', direct('stranger-handle', 'dm-stranger'));
  authenticator.tokens.set('free-time', {
    surface: PI,
    principal: { kind: 'companion_internal', purpose: 'free_time' },
    room: { kind: 'self' },
    turnKind: 'background',
  });
}

/** Registers the standard cast: primary Robin, trusted friend Sam, acquaintance Lee and stranger Ash. */
export async function registerPeople(admin: ContactAdministration) {
  const register = async (input: Partial<RegisterContactInput> & { readonly externalId: string }): Promise<ContactId> => {
    const created = await admin.register(OPERATOR, {
      displayName: input.displayName ?? input.externalId,
      identity: { channelKind: 'chat', externalId: input.externalId },
      trust: input.trust ?? 'regular',
      relationship: input.relationship ?? 'acquaintance',
      consent: input.consent ?? 'granted',
      sensitivity: input.sensitivity ?? 'personal',
    });
    if (!created.ok) throw new Error(`register ${input.externalId}: ${JSON.stringify(created.error)}`);
    return created.value.contactId;
  };
  return {
    primary: await register({ externalId: 'primary-handle', displayName: 'Robin', trust: 'primary', relationship: 'partner' }),
    friend: await register({ externalId: 'friend-handle', displayName: 'Sam', trust: 'trusted', relationship: 'friend' }),
    acquaintance: await register({ externalId: 'acq-handle', displayName: 'Lee', trust: 'regular' }),
    stranger: await register({ externalId: 'stranger-handle', displayName: 'Ash', trust: 'public', relationship: 'stranger' }),
  };
}

/** Wires the real core services over the given ports. Registers nobody. */
export function wireWorld(ports: WorldPorts) {
  const { clock, ids } = ports;
  const admin = createContactAdministration({ store: ports.contactStore, clock, ids });
  const ingressResult = createTrustedIngress({
    companionId: COMPANION,
    authenticator: ports.authenticator,
    contacts: createContactAuthority(ports.contactStore),
    policy: BASELINE_DISCLOSURE_POLICY,
  });
  if (!ingressResult.ok) throw new Error('ingress');
  const ingress = ingressResult.value;
  const admit = async (token: string): Promise<TrustedTurnScope> => {
    const scope = await ingress.admit(token);
    if (!scope.ok) throw new Error(`admission failed for ${token}: ${JSON.stringify(scope.error)}`);
    return scope.value;
  };

  const sessions = createSessionService({
    catalog: ports.catalog,
    archive: ports.archive,
    projection: ports.projection,
    continuity: ports.continuity,
    focus: ports.focus,
    model: ports.model,
    clock,
    ids,
  });
  const contacts = createContactService({ store: ports.contactStore, approvals: ports.approvals, clock, ids });
  const orientation = createOrientationService({ blocks: ports.blocks, layers: ports.layers, persona: ports.persona, approvals: ports.approvals, clock });
  const values = createValuesService({ values: ports.valuesJournal, northStar: ports.northStar, clock, ids });
  const identityAdmin = createIdentityAdministration({ layers: ports.layers, persona: ports.persona, clock });
  const dispatcherResult = createToolDispatcher({
    inventory: TOOL_INVENTORY,
    handlers: createContinuityHandlers({ sessions, contacts, orientation, values }),
  });
  if (!dispatcherResult.ok) throw new Error(JSON.stringify(dispatcherResult.error));
  const dispatcher: ToolDispatcher = dispatcherResult.value;

  const lifecycle = (): TurnLifecycle => {
    const created = createTurnLifecycle({ ledger: ports.ledger, archive: ports.archive, sessions: ports.catalog, clock, ids, turnLeaseMs: 60_000 });
    if (!created.ok) throw new Error('lifecycle');
    return created.value;
  };

  /** Runs one completed participant turn in the scope's current session. */
  const converse = async (scope: TrustedTurnScope, text: string, reply: string, key: string) => {
    const session = await sessions.current(scope);
    if (!session.ok) throw new Error(JSON.stringify(session.error));
    const head = await ports.ledger.head(session.value.sessionId);
    if (!head.ok) throw new Error('head');
    const life = lifecycle();
    const owner = { surface: PI, instance: 'pi-1' };
    const prepared = await life.prepareTurn(scope, {
      sessionId: session.value.sessionId,
      owner,
      idempotencyKey: id(key),
      expectedRevision: head.value.revision,
      trigger: { kind: 'participant_message', text },
    });
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    const committed = await life.commitTurn(prepared.value.turn, owner, { kind: 'completed', reply, delivery: 'delivered' });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    return session.value.sessionId;
  };

  const call = (scope: TrustedTurnScope, tool: string, action: string, args: Record<string, unknown> = {}) =>
    dispatcher.dispatch(scope, { tool, action, args });

  return { ingress, admit, admin, identityAdmin, sessions, contacts, orientation, values, dispatcher, lifecycle, converse, call };
}

export async function continuityWorld() {
  const ports = {
    clock: new FixedClock(),
    ids: new SequentialIds(),
    authenticator: new FakeAuthenticator(),
    contactStore: new FakeContactStore(),
    approvals: new FakeApprovals(),
    model: new FakeModel(),
    catalog: new FakeSessionCatalog(),
    archive: new FakeArchive(),
    ledger: new FakeTurnLedger(),
    projection: new FakeProjection(),
    continuity: new FakeContinuity(),
    focus: new FakeFocus(),
    layers: new FakeLayers(),
    persona: new FakePersona(),
    blocks: new FakeCoreBlocks(),
    valuesJournal: new FakeValues(),
    northStar: new FakeNorthStar(),
  };
  standardTokens(ports.authenticator);
  const world = wireWorld(ports);
  const people = await registerPeople(world.admin);
  return { ...ports, ...world, people };
}
