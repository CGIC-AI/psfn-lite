import { describe, expect, it } from 'vitest';
import {
  createTurnLifecycle,
  deriveWorkerScope,
  type PreparedTurn,
  type PrepareTurnInput,
  type TrustedTurnScope,
  type TurnLifecycle,
  type TurnOwner,
} from '../../packages/core/src/index.ts';
import { FakeSessionCatalog } from './continuity-fakes.ts';
import { FakeArchive, FakeTurnLedger, FixedClock, PI, PRIMARY, SequentialIds, TOOL_TRANSPORT, id, standardWorld } from './fakes.ts';

const PI_OWNER: TurnOwner = { surface: PI, instance: 'pi-1' };
const OTHER_OWNER: TurnOwner = { surface: TOOL_TRANSPORT, instance: 'hermes-1' };
const SESSION = id<'session'>('session-1');
const SELF_SESSION = id<'session'>('session-self');

function catalogWithSessions(): FakeSessionCatalog {
  const sessions = new FakeSessionCatalog();
  const base = { createdAt: '2030-01-01T00:00:00.000Z', lastActivityAt: '2030-01-01T00:00:00.000Z', previousSessionId: null, continuesFrom: null };
  sessions.sessions.set(SESSION, { ...base, sessionId: SESSION, audience: { kind: 'direct', channelId: id('dm-primary'), contactId: PRIMARY } });
  sessions.sessions.set(SELF_SESSION, { ...base, sessionId: SELF_SESSION, audience: { kind: 'self' } });
  return sessions;
}

const LEASE_MS = 60_000;

function setup() {
  const ledger = new FakeTurnLedger();
  const archive = new FakeArchive();
  const clock = new FixedClock();
  const sessions = catalogWithSessions();
  const created = createTurnLifecycle({ ledger, archive, sessions, clock, ids: new SequentialIds(), turnLeaseMs: LEASE_MS });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return { ledger, archive, sessions, clock, lifecycle: created.value, ...standardWorld() };
}

function input(overrides: Partial<PrepareTurnInput> = {}): PrepareTurnInput {
  return {
    sessionId: SESSION,
    owner: PI_OWNER,
    idempotencyKey: id('key-1'),
    expectedRevision: 0,
    trigger: { kind: 'participant_message', text: 'good morning' },
    ...overrides,
  };
}

async function prepared(
  lifecycle: TurnLifecycle,
  scope: TrustedTurnScope,
  overrides: Partial<PrepareTurnInput> = {},
): Promise<PreparedTurn> {
  const result = await lifecycle.prepareTurn(scope, input(overrides));
  if (!result.ok || result.value.kind !== 'prepared') throw new Error(`prepare failed: ${JSON.stringify(result)}`);
  return result.value.turn;
}

describe('turn lifecycle', () => {
  it('records a completed turn with attributed history and advances the revision', async () => {
    const { lifecycle, archive, ledger, admit } = setup();
    const turn = await prepared(lifecycle, await admit('primary-dm'));
    expect(turn.record.trigger).toEqual({ kind: 'participant_message', speaker: PRIMARY, text: 'good morning' });

    const committed = await lifecycle.commitTurn(turn, PI_OWNER, { kind: 'completed', reply: 'morning!', delivery: 'delivered' });
    expect(committed.ok && committed.value.settlement?.revision).toBe(1);
    expect(archive.entries.map((e) => [e.origin.kind, e.text])).toEqual([
      ['participant_speech', 'good morning'],
      ['companion_speech', 'morning!'],
    ]);
    const head = await ledger.head(SESSION);
    expect(head.ok && head.value).toEqual({ sessionId: SESSION, revision: 1, openTurnId: null });
  });

  it('records interrupted and failed outcomes rather than dropping them', async () => {
    const { lifecycle, ledger, archive, admit } = setup();
    const scope = await admit('primary-dm');
    const first = await prepared(lifecycle, scope);
    const interrupted = await lifecycle.abortTurn(first, PI_OWNER, {
      kind: 'interrupted',
      by: 'participant',
      partialReply: 'let me th',
      delivery: 'unknown',
    });
    expect(interrupted.ok && interrupted.value.settlement?.outcome.kind).toBe('interrupted');

    const second = await prepared(lifecycle, scope, { idempotencyKey: id('key-2'), expectedRevision: 1 });
    const failed = await lifecycle.abortTurn(second, PI_OWNER, {
      kind: 'failed',
      error: { code: 'model_unavailable', message: 'provider timed out' },
      partialReply: null,
      delivery: 'not_attempted',
    });
    expect(failed.ok && failed.value.settlement?.outcome).toMatchObject({ kind: 'failed', error: { code: 'model_unavailable' } });
    expect([...ledger.turns.values()].map((t) => t.settlement?.outcome.kind)).toEqual(['interrupted', 'failed']);
    expect(archive.entries.filter((e) => e.origin.kind === 'system_note').map((e) => e.text)).toEqual([
      'turn interrupted by participant',
      'turn failed: model_unavailable: provider timed out',
    ]);
    expect(archive.entries.find((e) => e.text === 'let me th')?.origin).toEqual({ kind: 'companion_speech' });
  });

  it('replays a retried request after settlement without re-executing', async () => {
    const { lifecycle, ledger, archive, admit } = setup();
    const scope = await admit('primary-dm');
    const turn = await prepared(lifecycle, scope);
    await lifecycle.commitTurn(turn, PI_OWNER, { kind: 'completed', reply: 'hi', delivery: 'delivered' });
    const entriesBefore = archive.entries.length;

    const retry = await lifecycle.prepareTurn(scope, input());
    expect(retry.ok && retry.value.kind).toBe('replayed');
    expect(ledger.turns.size).toBe(1);
    expect(archive.entries.length).toBe(entriesBefore);
  });

  it('returns the same open turn to a retry from the same owner, without duplicate history', async () => {
    const { lifecycle, archive, admit } = setup();
    const scope = await admit('primary-dm');
    const turn = await prepared(lifecycle, scope);
    const again = await prepared(lifecycle, scope);
    expect(again.record.turnId).toBe(turn.record.turnId);
    expect(archive.entries).toHaveLength(1);
  });

  it('rejects a reused idempotency key carrying a different request', async () => {
    const { lifecycle, admit } = setup();
    const scope = await admit('primary-dm');
    await prepared(lifecycle, scope);
    const reused = await lifecycle.prepareTurn(scope, input({ trigger: { kind: 'participant_message', text: 'something else' } }));
    expect(reused.ok || reused.error).toMatchObject({ kind: 'conflict', reason: 'idempotency_mismatch' });
  });

  it('refuses a second turn while one is open, and a stale revision after it settles', async () => {
    const { lifecycle, admit } = setup();
    const scope = await admit('primary-dm');
    const turn = await prepared(lifecycle, scope);
    const concurrent = await lifecycle.prepareTurn(scope, input({ idempotencyKey: id('key-2') }));
    expect(concurrent.ok || concurrent.error).toMatchObject({ kind: 'conflict', reason: 'turn_already_open' });

    await lifecycle.commitTurn(turn, PI_OWNER, { kind: 'completed', reply: null, delivery: 'not_attempted' });
    const stale = await lifecycle.prepareTurn(scope, input({ idempotencyKey: id('key-2'), expectedRevision: 0 }));
    expect(stale.ok || stale.error).toEqual({
      kind: 'conflict',
      reason: 'stale_revision',
      expectedRevision: 0,
      actualRevision: 1,
      detail: 'session changed since the context was assembled',
    });
  });

  it('lets only the owning harness settle a live turn; a live owner hands over through abort', async () => {
    const { lifecycle, admit } = setup();
    const turn = await prepared(lifecycle, await admit('primary-dm'));
    const stolen = await lifecycle.commitTurn(turn, OTHER_OWNER, { kind: 'completed', reply: 'hijack', delivery: 'delivered' });
    expect(stolen.ok || stolen.error).toMatchObject({ kind: 'conflict', reason: 'turn_ownership' });

    await lifecycle.abortTurn(turn, PI_OWNER, { kind: 'interrupted', by: 'host', partialReply: null, delivery: 'not_attempted' });
    const handedOver = await lifecycle.prepareTurn(
      await admit('primary-dm-mcp'),
      input({ owner: OTHER_OWNER, idempotencyKey: id('key-2'), expectedRevision: 1 }),
    );
    expect(handedOver.ok && handedOver.value.kind).toBe('prepared');
  });

  it('treats a repeated identical settlement as idempotent and a different one as a conflict', async () => {
    const { lifecycle, admit } = setup();
    const turn = await prepared(lifecycle, await admit('primary-dm'));
    const outcome = { kind: 'completed', reply: 'hi', delivery: 'delivered' } as const;
    expect((await lifecycle.commitTurn(turn, PI_OWNER, outcome)).ok).toBe(true);
    expect((await lifecycle.commitTurn(turn, PI_OWNER, outcome)).ok).toBe(true);
    const changed = await lifecycle.commitTurn(turn, PI_OWNER, { ...outcome, delivery: 'not_delivered' });
    expect(changed.ok || changed.error).toMatchObject({ kind: 'conflict', reason: 'turn_already_settled' });
  });

  it('settles the ledger before history, reports a failed append and repairs it on retry', async () => {
    const { lifecycle, archive, ledger, admit } = setup();
    const turn = await prepared(lifecycle, await admit('primary-dm'));
    archive.failNext = true;
    const outcome = { kind: 'completed', reply: 'hi', delivery: 'delivered' } as const;
    const failed = await lifecycle.commitTurn(turn, PI_OWNER, outcome);
    expect(failed.ok || failed.error).toMatchObject({ kind: 'unavailable', capability: 'session_archive' });
    expect(ledger.turns.get(turn.record.turnId)?.settlement?.outcome).toEqual(outcome);
    expect(archive.entries.map((e) => e.text)).toEqual(['good morning']);

    const changed = await lifecycle.abortTurn(turn, PI_OWNER, { kind: 'failed', error: { code: 'x', message: 'y' }, partialReply: 'h', delivery: 'unknown' });
    expect(changed.ok || changed.error).toMatchObject({ kind: 'conflict', reason: 'turn_already_settled' });
    expect((await lifecycle.commitTurn(turn, PI_OWNER, outcome)).ok).toBe(true);
    expect(archive.entries.map((e) => e.text)).toEqual(['good morning', 'hi']);
  });

  it('repairs missing history when a settled request is replayed', async () => {
    const { lifecycle, archive, admit } = setup();
    const scope = await admit('primary-dm');
    const turn = await prepared(lifecycle, scope);
    archive.failNext = true;
    await lifecycle.commitTurn(turn, PI_OWNER, { kind: 'completed', reply: 'hi', delivery: 'delivered' });
    const replay = await lifecycle.prepareTurn(scope, input());
    expect(replay.ok && replay.value.kind).toBe('replayed');
    expect(archive.entries.map((e) => e.text)).toEqual(['good morning', 'hi']);
  });

  it('never archives a reply the ledger did not record when the ledger write fails', async () => {
    const { lifecycle, archive, ledger, admit } = setup();
    const turn = await prepared(lifecycle, await admit('primary-dm'));
    ledger.failNextSettle = true;
    const completed = await lifecycle.commitTurn(turn, PI_OWNER, { kind: 'completed', reply: 'full answer A', delivery: 'delivered' });
    expect(completed.ok || completed.error).toMatchObject({ kind: 'unavailable', capability: 'turn_ledger' });
    expect(archive.entries.map((e) => e.text)).toEqual(['good morning']);

    const aborted = await lifecycle.abortTurn(turn, PI_OWNER, {
      kind: 'failed',
      error: { code: 'delivery_failed', message: 'channel closed' },
      partialReply: 'partial B',
      delivery: 'not_delivered',
    });
    expect(aborted.ok && aborted.value.settlement?.outcome.kind).toBe('failed');
    expect(archive.entries.map((e) => [e.origin.kind, e.text])).toEqual([
      ['participant_speech', 'good morning'],
      ['companion_speech', 'partial B'],
      ['system_note', 'turn failed: delivery_failed: channel closed'],
    ]);
  });

  it('lets a successor recover a turn whose owner disappeared, once the lease expires', async () => {
    const { lifecycle, archive, ledger, clock, admit } = setup();
    const turn = await prepared(lifecycle, await admit('primary-dm'));
    // The owning harness dies here without settling. A successor arrives on another surface.
    const successorScope = await admit('primary-dm-mcp');
    const blocked = await lifecycle.prepareTurn(successorScope, input({ owner: OTHER_OWNER, idempotencyKey: id('key-2') }));
    expect(blocked.ok || blocked.error).toMatchObject({ kind: 'conflict', reason: 'turn_already_open' });

    const early = await lifecycle.recoverTurn(successorScope, { sessionId: SESSION, owner: OTHER_OWNER });
    expect(early.ok || early.error).toMatchObject({ kind: 'conflict', reason: 'turn_lease_active' });

    clock.advance(LEASE_MS);
    const recovered = await lifecycle.recoverTurn(successorScope, { sessionId: SESSION, owner: OTHER_OWNER });
    expect(recovered.ok && recovered.value.settlement).toMatchObject({
      outcome: { kind: 'interrupted', by: 'host', partialReply: null, delivery: 'unknown' },
      settledBy: OTHER_OWNER,
      revision: 1,
    });
    expect(archive.entries.at(-1)).toMatchObject({ origin: { kind: 'system_note' }, text: 'turn interrupted by host; recovered by mcp' });

    const next = await lifecycle.prepareTurn(successorScope, input({ owner: OTHER_OWNER, idempotencyKey: id('key-2'), expectedRevision: 1 }));
    expect(next.ok && next.value.kind).toBe('prepared');

    const lateOwner = await lifecycle.commitTurn(turn, PI_OWNER, { kind: 'completed', reply: 'too late', delivery: 'delivered' });
    expect(lateOwner.ok || lateOwner.error).toMatchObject({ kind: 'conflict', reason: 'turn_already_settled' });
    expect(archive.entries.some((e) => e.text === 'too late')).toBe(false);
    expect(ledger.turns.get(turn.record.turnId)?.settlement?.outcome.kind).toBe('interrupted');
  });

  it('refuses recovery by the owner, another audience, a worker, or with no open turn', async () => {
    const { lifecycle, clock, admit } = setup();
    const scope = await admit('primary-dm');
    const none = await lifecycle.recoverTurn(scope, { sessionId: SESSION, owner: OTHER_OWNER });
    expect(none.ok || none.error.kind).toBe('not_found');

    await prepared(lifecycle, scope);
    clock.advance(LEASE_MS);
    const self = await lifecycle.recoverTurn(scope, { sessionId: SESSION, owner: PI_OWNER });
    expect(self.ok || self.error.kind).toBe('invalid');
    const otherAudience = await lifecycle.recoverTurn(await admit('friend-dm'), { sessionId: SESSION, owner: OTHER_OWNER });
    expect(otherAudience.ok || otherAudience.error).toMatchObject({ kind: 'denied', reason: 'audience_not_admitted' });
    const worker = deriveWorkerScope(scope, id('run-1'), { actions: [], maxTurns: 1, maxSensitivity: 'public' });
    if (!worker.ok) throw new Error('worker scope');
    const byWorker = await lifecycle.recoverTurn(worker.value, { sessionId: SESSION, owner: OTHER_OWNER });
    expect(byWorker.ok || byWorker.error).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });
  });

  it('requires an explicit positive turn lease', () => {
    const deps = {
      ledger: new FakeTurnLedger(),
      archive: new FakeArchive(),
      sessions: new FakeSessionCatalog(),
      clock: new FixedClock(),
      ids: new SequentialIds(),
    };
    expect(createTurnLifecycle({ ...deps, turnLeaseMs: 0 }).ok).toBe(false);
    expect(createTurnLifecycle({ ...deps, turnLeaseMs: 1.5 }).ok).toBe(false);
  });

  it('binds speech attribution to the scope: no participant speech from internal turns, and vice versa', async () => {
    const { lifecycle, admit } = setup();
    const internal = await lifecycle.prepareTurn(await admit('free-time'), input({ sessionId: SELF_SESSION }));
    expect(internal.ok || internal.error).toMatchObject({ kind: 'denied', reason: 'unknown_authority' });

    const disguised = await lifecycle.prepareTurn(
      await admit('primary-dm'),
      input({ trigger: { kind: 'internal', origin: { kind: 'system_note', source: 'x' }, purpose: 'p', text: 'hello' } }),
    );
    expect(disguised.ok || disguised.error).toMatchObject({ kind: 'denied' });

    const smuggled = await lifecycle.prepareTurn(
      await admit('free-time'),
      input({
        sessionId: SELF_SESSION,
        trigger: { kind: 'internal', origin: { kind: 'participant_speech', speaker: PRIMARY } as never, purpose: 'p', text: 'hi' },
      }),
    );
    expect(smuggled.ok || smuggled.error.kind).toBe('invalid');

    const freeTime = await lifecycle.prepareTurn(
      await admit('free-time'),
      input({
        sessionId: SELF_SESSION,
        trigger: { kind: 'internal', origin: { kind: 'internal_signal', source: 'free_time_gate' }, purpose: 'free_time', text: 'invite' },
      }),
    );
    expect(freeTime.ok && freeTime.value.kind === 'prepared' && freeTime.value.turn.record.trigger.kind).toBe('internal');
  });

  it('rejects forged scopes, worker turns and mismatched commit/abort outcomes', async () => {
    const { lifecycle, admit } = setup();
    const scope = await admit('primary-dm');
    const forged = await lifecycle.prepareTurn({ ...scope }, input());
    expect(forged.ok || forged.error).toMatchObject({ kind: 'denied', reason: 'unknown_authority' });

    const worker = deriveWorkerScope(scope, id('run-1'), { actions: [], maxTurns: 1, maxSensitivity: 'public' });
    expect(worker.ok).toBe(true);
    if (!worker.ok) return;
    const workerTurn = await lifecycle.prepareTurn(worker.value, input());
    expect(workerTurn.ok || workerTurn.error.kind).toBe('denied');

    const turn = await prepared(lifecycle, scope);
    const wrongWay = await lifecycle.commitTurn(turn, PI_OWNER, { kind: 'interrupted', by: 'host', partialReply: null, delivery: 'unknown' } as never);
    expect(wrongWay.ok || wrongWay.error.kind).toBe('invalid');
  });

  it('binds a session to its audience: another audience cannot open turns in it, and unknown sessions are missing', async () => {
    const { lifecycle, sessions, clock, admit } = setup();
    clock.advance(5_000);
    const fromFriend = await lifecycle.prepareTurn(await admit('friend-dm'), input());
    expect(fromFriend.ok || fromFriend.error).toMatchObject({ kind: 'denied', reason: 'audience_not_admitted' });
    const unknown = await lifecycle.prepareTurn(await admit('primary-dm'), input({ sessionId: id('session-unknown') }));
    expect(unknown.ok || unknown.error.kind).toBe('not_found');

    const turn = await prepared(lifecycle, await admit('primary-dm'));
    expect(sessions.sessions.get(SESSION)?.lastActivityAt).toBe(turn.record.openedAt);
  });
});
