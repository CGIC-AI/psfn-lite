/**
 * A self-audience scope admits every sensitivity and every conversation's
 * sources, so it is never reachable with a standing credential. The host's
 * InternalTurnPort mints one credential per internal turn core asks for;
 * it works only while that turn is open, never past its TTL, and carries
 * only the purpose and surface core admitted.
 */
import { describe, expect, it } from 'vitest';
import { ok, type InternalTurnRequest, type InternalTurnResult, type Result, type TrustedTurnScope } from '../../packages/core/src/index.ts';
import { createMcpInternalTurns, type InternalTurnLauncher } from '../../packages/mcp/src/index.ts';
import { BINDINGS, connectClient, fakeMcpWorld, invoke, mustInvoke, type Principal } from './mcp-world.ts';

const sameRoom = (a: Principal, b: Principal) => JSON.stringify(BINDINGS[a].room) === JSON.stringify(BINDINGS[b].room);
const evidence = (credential: string) => ({ kind: 'mcp_credential', credential });
const completed = (): Promise<Result<InternalTurnResult>> => Promise.resolve(ok({ status: 'completed', reply: null }));

function request(scope: TrustedTurnScope, purpose: InternalTurnRequest['purpose'] = 'free_time'): InternalTurnRequest {
  return { scope, purpose, prompt: 'A quiet moment of your own.', reference: { kind: 'scheduled_prompt', id: 'turn-test' } };
}

async function postStatus(url: string, credential: string): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  await response.text();
  return response.status;
}

describe('standing credentials', () => {
  it('reach no companion-private state and no other conversation outside an internal turn', async () => {
    const w = await fakeMcpWorld();
    const notes: Partial<Record<Principal, string>> = { primary: 'PRIMSECRET', friend: 'FRIENDSECRET', acquaintance: 'ACQSECRET' };
    for (const [principal, secret] of Object.entries(notes)) {
      await mustInvoke(await w.as(principal as Principal), 'journal', { action: 'write', path: `notes/${principal}.md`, body: `${secret} note` });
    }
    // The primary contact's reach is core's disclosure ceiling for that trust level, the same on every surface; every other standing credential sees only its own room.
    for (const principal of (Object.keys(w.credentials) as Principal[]).filter((p) => p !== 'primary')) {
      const client = await w.as(principal);
      const found = JSON.stringify(await invoke(client, 'journal', { action: 'search', query: 'note' }));
      for (const [owner, secret] of Object.entries(notes)) if (!sameRoom(owner as Principal, principal)) expect(found, `${principal} sees ${owner}`).not.toContain(secret);
      for (const [tool, action] of [['free_time', 'status'], ['journal', 'reflections_list'], ['journal', 'letter_list']] as const) {
        const outcome = await invoke(client, tool, { action });
        expect(outcome.isError, `${principal} ${tool}.${action}`).toBe(true);
        expect(outcome.payload).not.toHaveProperty('content');
      }
    }
    expect(w.turnCredentials).toEqual([]);
  });
});

describe('internal turn credentials', () => {
  it('admit the companion while the turn is open, with the purpose and surface core admitted', async () => {
    const w = await fakeMcpWorld();
    await mustInvoke(await w.as('friend'), 'journal', { action: 'write', path: 'sam.md', body: 'FRIENDSECRET note' });
    const scope = await w.admit('free-time');
    const seen = await w.inSelfTurn(async (self, credential) => {
      expect(w.callers.identify(credential)).toBe('internal:free_time');
      expect(await w.turns.authenticator.authenticate(evidence(credential))).toEqual({
        ok: true,
        value: { surface: scope.surface, principal: { kind: 'companion_internal', purpose: 'free_time' }, room: { kind: 'self' }, turnKind: 'background' },
      });
      expect(await mustInvoke<unknown[]>(self, 'free_time', { action: 'status' })).not.toHaveLength(0);
      return JSON.stringify(await mustInvoke(self, 'journal', { action: 'search', query: 'note' }));
    });
    // The companion's own turn sees what it knows; that is why the credential must not outlive the turn.
    expect(seen).toContain('FRIENDSECRET');
  });

  it('stop working the moment the turn settles, whether it completed, failed or threw', async () => {
    const w = await fakeMcpWorld();
    const completedCredential = await w.inSelfTurn((_self, credential) => Promise.resolve(credential));
    w.companion.turn = () => Promise.resolve({ ok: false, error: { kind: 'unavailable', capability: 'model', detail: 'down' } });
    expect((await w.turnPort.run(request(await w.admit('free-time')))).ok).toBe(false);
    w.companion.turn = () => Promise.reject(new Error('harness crashed'));
    await expect(w.turnPort.run(request(await w.admit('free-time')))).rejects.toThrow('harness crashed');
    expect(w.turnCredentials).toHaveLength(3);
    expect(w.turnCredentials[0]).toBe(completedCredential);
    for (const credential of w.turnCredentials) {
      expect(w.callers.identify(credential)).toBeNull();
      expect(await w.callers.authenticator.authenticate(evidence(credential))).toMatchObject({ ok: false, error: { kind: 'denied', reason: 'unknown_authority' } });
      expect(await postStatus(w.url, credential)).toBe(401);
      await expect(connectClient(w.url, credential)).rejects.toThrow();
    }
  });

  it('are fresh and unguessable for every turn', async () => {
    const w = await fakeMcpWorld();
    await w.inSelfTurn(() => Promise.resolve(null));
    await w.inSelfTurn(() => Promise.resolve(null));
    expect(new Set(w.turnCredentials).size).toBe(2);
    for (const credential of w.turnCredentials) expect(credential.length).toBeGreaterThanOrEqual(32);
  });

  it('expire after the TTL even while the turn is still running', async () => {
    const w = await fakeMcpWorld();
    let now = 1_000_000;
    const turns = createMcpInternalTurns({ ttlMs: 1_000, maxOpen: 2, now: () => now });
    if (!turns.ok) throw new Error(JSON.stringify(turns.error));
    const launch: InternalTurnLauncher = async (_request, credential) => {
      expect((await turns.value.authenticator.authenticate(evidence(credential))).ok).toBe(true);
      now += 999;
      expect(turns.value.identify(credential)).toBe('internal:free_time');
      now += 1;
      expect(turns.value.identify(credential)).toBeNull();
      expect(await turns.value.authenticator.authenticate(evidence(credential))).toMatchObject({ ok: false, error: { reason: 'unknown_authority' } });
      return completed();
    };
    expect((await turns.value.createTurnPort(launch).run(request(await w.admit('free-time')))).ok).toBe(true);
  });

  it('refuse a turn beyond maxOpen without evicting a live one', async () => {
    const w = await fakeMcpWorld();
    const turns = createMcpInternalTurns({ ttlMs: 60_000, maxOpen: 1, now: Date.now });
    if (!turns.ok) throw new Error(JSON.stringify(turns.error));
    let launches = 0;
    const scope = await w.admit('free-time');
    const port = turns.value.createTurnPort(async (_request, credential) => {
      launches += 1;
      const nested = await port.run(request(scope));
      expect(nested).toMatchObject({ ok: false, error: { kind: 'unavailable', capability: 'internal_turn_credentials' } });
      expect((await turns.value.authenticator.authenticate(evidence(credential))).ok).toBe(true);
      return completed();
    });
    expect((await port.run(request(scope))).ok).toBe(true);
    expect(launches).toBe(1);
  });

  it('are minted only for an admitted companion-internal turn of the same purpose', async () => {
    const w = await fakeMcpWorld();
    let launches = 0;
    const port = w.turns.createTurnPort(() => {
      launches += 1;
      return completed();
    });
    const self = await w.admit('free-time');
    for (const refused of [
      request(await w.admit('primary-dm')),
      request(self, 'reflection'),
      request({ ...self }),
      request({ ...self, audience: { kind: 'self' } } as TrustedTurnScope),
    ]) {
      expect(await port.run(refused)).toMatchObject({ ok: false, error: { kind: 'denied', reason: 'unknown_authority' } });
    }
    expect(launches).toBe(0);
  });

  it('refuse invalid limits', () => {
    for (const options of [
      { ttlMs: 0, maxOpen: 1, now: Date.now },
      { ttlMs: 1.5, maxOpen: 1, now: Date.now },
      { ttlMs: 1_000, maxOpen: 0, now: Date.now },
    ]) {
      expect(createMcpInternalTurns(options)).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    }
  });
});
