/**
 * A synthetic companion world wired from the real core services over
 * in-memory fakes: ingress resolves callers through the real contact
 * authority, and the dispatcher carries the real continuity handlers.
 * Every identity here is invented.
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
  type ContactId,
  type HostAttestation,
  type RegisterContactInput,
  type ToolDispatcher,
  type TrustedTurnScope,
  type TurnLifecycle,
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

function direct(externalId: string, channel: string, turnKind: 'foreground' | 'background' = 'foreground'): HostAttestation {
  return {
    surface: PI,
    principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId } },
    room: { kind: 'direct', channelId: id<'channel'>(channel) },
    turnKind,
  };
}

export async function continuityWorld() {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const contactStore = new FakeContactStore();
  const approvals = new FakeApprovals();
  const model = new FakeModel();
  const catalog = new FakeSessionCatalog();
  const archive = new FakeArchive();
  const ledger = new FakeTurnLedger();
  const projection = new FakeProjection();
  const layers = new FakeLayers();
  const persona = new FakePersona();
  const blocks = new FakeCoreBlocks();
  const valuesJournal = new FakeValues();
  const northStar = new FakeNorthStar();
  const authenticator = new FakeAuthenticator();

  const admin = createContactAdministration({ store: contactStore, clock, ids });
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
  const primary = await register({ externalId: 'primary-handle', displayName: 'Robin', trust: 'primary', relationship: 'partner' });
  const friend = await register({ externalId: 'friend-handle', displayName: 'Sam', trust: 'trusted', relationship: 'friend' });
  const acquaintance = await register({ externalId: 'acq-handle', displayName: 'Lee', trust: 'regular' });
  const stranger = await register({ externalId: 'stranger-handle', displayName: 'Ash', trust: 'public', relationship: 'stranger' });

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

  const ingressResult = createTrustedIngress({
    companionId: COMPANION,
    authenticator,
    contacts: createContactAuthority(contactStore),
    policy: BASELINE_DISCLOSURE_POLICY,
  });
  if (!ingressResult.ok) throw new Error('ingress');
  const ingress = ingressResult.value;
  const admit = async (token: string): Promise<TrustedTurnScope> => {
    const scope = await ingress.admit(token);
    if (!scope.ok) throw new Error(`admission failed for ${token}: ${JSON.stringify(scope.error)}`);
    return scope.value;
  };

  const sessions = createSessionService({ catalog, archive, projection, continuity: new FakeContinuity(), focus: new FakeFocus(), model, clock, ids });
  const contacts = createContactService({ store: contactStore, approvals, clock, ids });
  const orientation = createOrientationService({ blocks, layers, persona, approvals, clock });
  const values = createValuesService({ values: valuesJournal, northStar, clock, ids });
  const identityAdmin = createIdentityAdministration({ layers, persona, clock });
  const dispatcherResult = createToolDispatcher({
    inventory: TOOL_INVENTORY,
    handlers: createContinuityHandlers({ sessions, contacts, orientation, values }),
  });
  if (!dispatcherResult.ok) throw new Error(JSON.stringify(dispatcherResult.error));
  const dispatcher: ToolDispatcher = dispatcherResult.value;

  const lifecycle = (): TurnLifecycle => {
    const created = createTurnLifecycle({ ledger, archive, sessions: catalog, clock, ids, turnLeaseMs: 60_000 });
    if (!created.ok) throw new Error('lifecycle');
    return created.value;
  };

  /** Runs one completed participant turn in the scope's current session. */
  const converse = async (scope: TrustedTurnScope, text: string, reply: string, key: string) => {
    const session = await sessions.current(scope);
    if (!session.ok) throw new Error(JSON.stringify(session.error));
    const head = await ledger.head(session.value.sessionId);
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

  return {
    clock,
    ids,
    contactStore,
    approvals,
    model,
    catalog,
    archive,
    projection,
    layers,
    persona,
    blocks,
    valuesJournal,
    northStar,
    authenticator,
    ingress,
    admit,
    admin,
    identityAdmin,
    sessions,
    contacts,
    orientation,
    values,
    dispatcher,
    lifecycle,
    converse,
    call,
    people: { primary, friend, acquaintance, stranger },
  };
}
