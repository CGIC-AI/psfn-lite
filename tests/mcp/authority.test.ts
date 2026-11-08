/**
 * Authority is bound outside model arguments: transport credential, then the
 * operator's principal binding, then core ingress and its contact authority,
 * on every call. Unknown, missing or blocked authority fails closed, and
 * nothing in tool arguments can supply or widen it.
 */
import { describe, expect, it } from 'vitest';
import { OPERATOR } from '../core/continuity-world.ts';
import { connectClient, fakeMcpWorld, invoke } from './mcp-world.ts';

const errorOf = (outcome: { payload: Record<string, unknown> }) => outcome.payload['error'] as Record<string, unknown> | undefined;

async function post(url: string, headers: Record<string, string>, body: string = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body,
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

describe('HTTP transport authentication', () => {
  it('admits only a bound bearer credential and says nothing about why another was refused', async () => {
    const w = await fakeMcpWorld();
    const guess = `${w.credentials.primary.slice(0, -1)}x`;
    for (const headers of [{}, { Authorization: `Bearer ${guess}` }, { Authorization: `Basic ${w.credentials.primary}` }, { Cookie: `session=${w.credentials.primary}` }]) {
      const refused = await post(w.url, headers);
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toBe('Bearer realm="psfn-lite"');
      expect(refused.text).toBe('{"error":"a bound bearer credential is required"}');
    }
    await expect(connectClient(w.url, guess)).rejects.toThrow();
    expect((await post(w.url, { Authorization: `Bearer ${w.credentials.primary}` })).status).toBe(200);
  });

  it('rejects browser origins, foreign hosts, transport sessions, other methods, other paths and oversized bodies', async () => {
    const w = await fakeMcpWorld();
    const auth = { Authorization: `Bearer ${w.credentials.primary}` };
    expect((await post(w.url, { ...auth, Origin: 'https://example.test' })).status).toBe(403);
    expect((await post(w.url, { ...auth, 'Mcp-Session-Id': 'carried-over' })).status).toBe(400);
    expect((await post(w.url.replace('/mcp', '/other'), auth)).status).toBe(404);
    expect((await post(w.url, auth, 'x'.repeat(2 * 1024 * 1024))).status).toBe(413);
    const get = await fetch(w.url, { headers: auth });
    expect(get.status).toBe(405);
    // DNS rebinding: a loopback endpoint answers only loopback Host names.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(w.url, { method: 'POST', headers: { ...auth, Host: 'attacker.example', 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});

describe('caller binding through core ingress', () => {
  it('denies a credential bound to an identity core does not know, or to a room the caller cannot hold', async () => {
    const w = await fakeMcpWorld();
    const nobody = await invoke(await w.as('nobody'), 'memory', { action: 'census' });
    expect(nobody.isError).toBe(true);
    expect(errorOf(nobody)).toMatchObject({ kind: 'denied', reason: 'unknown_authority' });
    expect(nobody.payload).not.toHaveProperty('content');
    const claim = await invoke(await w.as('self-claim'), 'free_time', { action: 'status' });
    expect(errorOf(claim)).toMatchObject({ kind: 'denied', reason: 'unknown_authority' });
  });

  it('resolves the binding through contact authority on every call: untracked, blocked and unblocked apply at once', async () => {
    const w = await fakeMcpWorld();
    const nobody = await w.as('nobody');
    await w.admin.register(OPERATOR, {
      displayName: 'Kim',
      identity: { channelKind: 'chat', externalId: 'nobody-handle' },
      trust: 'regular',
      relationship: 'acquaintance',
      consent: 'pending',
      sensitivity: 'personal',
    });
    expect(errorOf(await invoke(nobody, 'memory', { action: 'census' }))).toMatchObject({ kind: 'denied', reason: 'untracked_contact' });

    const acquaintance = await w.as('acquaintance');
    const primary = await w.as('primary');
    expect((await invoke(acquaintance, 'memory', { action: 'census' })).isError).toBe(false);
    expect((await invoke(primary, 'contact', { action: 'block', contactId: w.people.acquaintance, reason: 'test' })).isError).toBe(false);
    // Same connection, next call: the block is in force.
    expect(errorOf(await invoke(acquaintance, 'memory', { action: 'census' }))).toMatchObject({ kind: 'denied', reason: 'blocked_contact' });
    expect((await invoke(primary, 'contact', { action: 'unblock', contactId: w.people.acquaintance })).isError).toBe(false);
    expect((await invoke(acquaintance, 'memory', { action: 'census' })).isError).toBe(false);
  });

  it('refuses identity and authority passed as tool arguments, visibly, from core', async () => {
    const w = await fakeMcpWorld();
    const friend = await w.as('friend');
    for (const key of ['caller', 'viewer', 'companionId', 'trustedScope', 'admitted', 'callerContactId']) {
      const outcome = await invoke(friend, 'journal', { action: 'reflections_list', [key]: { kind: 'companion_internal', purpose: 'reflection' } });
      expect(outcome.isError).toBe(true);
      // The admission gate runs first or the reserved-key check does; either way nothing is read.
      expect(['invalid', 'denied']).toContain(errorOf(outcome)?.['kind']);
      expect(outcome.payload).not.toHaveProperty('content');
    }
    const asOther = await invoke(friend, 'memory', { action: 'census', caller: { kind: 'participant', contactId: w.people.primary, trust: 'primary' } });
    expect(errorOf(asOther)).toMatchObject({ kind: 'invalid', issues: ['authority cannot be passed as arguments: caller'] });
    const audience = await invoke(friend, 'memory', { action: 'census', audience: { kind: 'self' } });
    expect(errorOf(audience)).toMatchObject({ kind: 'invalid', issues: ['unknown arguments: audience'] });
  });

  it('keeps the attested turn kind: a background binding cannot run foreground-only actions', async () => {
    const w = await fakeMcpWorld();
    const background = await invoke(await w.as('friend-background'), 'session', { action: 'new' });
    expect(errorOf(background)).toMatchObject({ kind: 'denied', reason: 'background_turn' });
    expect((await invoke(await w.as('friend'), 'session', { action: 'new' })).isError).toBe(false);
  });

  it('rejects unknown tools, unknown actions and a missing action', async () => {
    const w = await fakeMcpWorld();
    const client = await w.as('primary');
    await expect(client.callTool({ name: 'wiki', arguments: { action: 'search' } })).rejects.toThrow('not found');
    expect(errorOf(await invoke(client, 'memory', { action: 'redact' }))).toMatchObject({ kind: 'invalid', issues: ['unknown action memory.redact'] });
    expect(errorOf(await invoke(client, 'memory', {}))).toMatchObject({ kind: 'invalid' });
    expect(errorOf(await invoke(client, 'memory', { action: 7 }))).toMatchObject({ kind: 'invalid' });
  });
});
