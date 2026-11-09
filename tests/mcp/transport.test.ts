/**
 * The MCP transport binds the caller outside model arguments: the bearer
 * credential selects the principal before any body is read, every call is
 * handed to the host tool port with that principal, and nothing in tool
 * arguments can supply or change it. Unknown or missing credentials fail
 * closed without saying why; failures never leak storage text or a
 * credential.
 */
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { STORAGE_DETAIL, TOOLS, connectClient, mcpWorld } from './mcp-world.ts';

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
    const w = await mcpWorld();
    const guess = `${w.credentials.robin.slice(0, -1)}x`;
    for (const headers of [{}, { Authorization: `Bearer ${guess}` }, { Authorization: `Basic ${w.credentials.robin}` }, { Cookie: `session=${w.credentials.robin}` }]) {
      const refused = await post(w.url, headers);
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toBe('Bearer realm="psfn-lite"');
      expect(refused.text).toBe('{"error":"a bound bearer credential is required"}');
    }
    await expect(connectClient(w.url, guess)).rejects.toThrow();
    expect((await post(w.url, { Authorization: `Bearer ${w.credentials.robin}` })).status).toBe(200);
  });

  it('rejects browser origins, foreign hosts, transport sessions, other methods, other paths and oversized bodies', async () => {
    const w = await mcpWorld();
    const auth = { Authorization: `Bearer ${w.credentials.robin}` };
    expect((await post(w.url, { ...auth, Origin: 'https://example.test' })).status).toBe(403);
    expect((await post(w.url, { ...auth, 'Mcp-Session-Id': 'carried-over' })).status).toBe(400);
    expect((await post(w.url.replace('/mcp', '/other'), auth)).status).toBe(404);
    expect((await post(w.url, auth, 'x'.repeat(2 * 1024 * 1024))).status).toBe(413);
    expect((await fetch(w.url, { headers: auth })).status).toBe(405);
    // DNS rebinding: a loopback endpoint answers only loopback Host names.
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

describe('tool calls', () => {
  it('lists the host catalog and hands every call to the port as the credential principal', async () => {
    const w = await mcpWorld();
    const sam = await w.as('sam');
    expect((await sam.listTools()).tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const called = await sam.callTool({ name: 'memory', arguments: { action: 'search', caller: 'robin', principal: 'robin', contact: 'operator' } });
    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toEqual({ origin: 'tool_result', text: 'ran memory for sam' });
    // Identity-like arguments are only arguments: the port sees the credential's principal.
    expect(w.port.calls).toEqual([{ principal: 'sam', name: 'memory', args: { action: 'search', caller: 'robin', principal: 'robin', contact: 'operator' } }]);
    const robin = await w.as('robin');
    await robin.callTool({ name: 'orient', arguments: {} });
    expect(w.port.calls.at(-1)?.principal).toBe('robin');
  });

  it('refuses unknown tools as protocol errors, and non-object arguments before the port', async () => {
    const w = await mcpWorld();
    const robin = await w.as('robin');
    await expect(robin.callTool({ name: 'wiki', arguments: {} })).rejects.toThrow('not found');
    const surfaced = await w.surface.call(w.credentials.robin, 'memory', ['action']);
    expect(surfaced.isError).toBe(true);
    expect(surfaced.structuredContent).toEqual({ error: { kind: 'invalid', issues: ['tool arguments must be an object'] } });
    const unbound = await w.surface.call('x'.repeat(40), 'memory', {});
    expect(unbound.structuredContent).toEqual({ error: { kind: 'denied', reason: 'unknown_authority', detail: 'the credential is not bound' } });
    expect(w.port.calls).toEqual([]);
  });

  it('replaces unavailable details for the client and reports them, never a credential, to the operator', async () => {
    const w = await mcpWorld();
    const robin = await w.as('robin');
    const broken = await robin.callTool({ name: 'broken', arguments: {} });
    expect(broken.isError).toBe(true);
    expect(broken.structuredContent).toEqual({ error: { kind: 'unavailable', capability: 'broken', detail: 'the capability is unavailable; try again later' } });
    expect(JSON.stringify(broken)).not.toContain('hunter2');
    expect(w.reports).toEqual([{ stage: 'call', tool: 'broken', principal: 'robin', error: { kind: 'unavailable', capability: 'broken', detail: STORAGE_DETAIL } }]);
    for (const credential of Object.values(w.credentials)) expect(JSON.stringify(w.reports)).not.toContain(credential);
  });
});
