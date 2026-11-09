/**
 * The light Garden (docs/extraction.md, seam S8) over the real standalone
 * runtime and PostgreSQL. The Garden is reached only with its own credential,
 * which is bound to the primary contact: no credential, an MCP credential, a
 * browser Origin or a foreign Host is refused. Every screen's reads answer.
 * The writes go through the companion's own stores and the donor services and
 * are audited with actor `operator`. Memory deletion leaves the host's
 * in-turn approval gate as it is (decision a), and a Settings write updates
 * the owner file and answers restart-needed (decision b).
 */
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import type { Script } from '../support/faux-model.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { DATABASE_URL_ENV, RUNTIME_TIMEOUT_MS } from '../support/lite-world.ts';
import { INSTALL, bridge, mcpClient, useBridgeWorld, type BridgeWorld } from '../lifecycle/bridge-world.ts';
import { path as desktop } from '../../integrations/hermes/desktop/src/api.ts';

const EXPLANATION = 'The stored number is incorrect.';
const script: Script = () => null;

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

async function garden(w: BridgeWorld, method: string, path: string, init: { body?: unknown; credential?: string | null; headers?: Record<string, string> } = {}): Promise<Reply> {
  const site = w.garden;
  if (site === null) throw new Error('the Garden is not mounted');
  const credential = init.credential === undefined ? site.credential : init.credential;
  const response = await fetch(`${site.url}${path}`, {
    method,
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.structuredContent as { text?: string } | undefined)?.text ?? JSON.stringify(result.structuredContent);
  expect(result.isError ?? false, text).toBe(false);
  return text;
}

async function sql<T extends pg.QueryResultRow>(w: BridgeWorld, text: string, values: unknown[]): Promise<T[]> {
  const client = new pg.Client({ connectionString: w.install.env[DATABASE_URL_ENV] });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

async function auditEntries(w: BridgeWorld): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(w.runtime.companion.garden.companionDataDir, 'garden-audit-history.jsonl'), 'utf8');
  return raw.trim().split('\n').map((line) => (JSON.parse(line) as { entry: Record<string, unknown> }).entry);
}

describe.skipIf(dockerTestsOptedOut('light Garden'))('the light Garden', () => {
  const world = useBridgeWorld(script, { garden: true });

  async function hostTurn<T>(w: BridgeWorld, key: string, body: (client: Client) => Promise<T>): Promise<T> {
    const operator = w.credentials['hermes-operator'];
    const prepared = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, idempotencyKey: key, sessionId: 'session-garden', message: `turn ${key}` });
    expect(prepared.body['kind']).toBe('prepared');
    const client = await mcpClient(w, operator);
    try {
      return await body(client);
    } finally {
      await client.close();
      await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId: prepared.body['turnId'], outcome: { kind: 'completed', reply: 'Done.' } });
    }
  }

  async function remember(w: BridgeWorld, key: string, text: string): Promise<string> {
    const written = await hostTurn(w, key, (client) => tool(client, 'memory', { action: 'write', text, type: 'semantic' }));
    const id = /id: ([0-9a-f-]{36})/.exec(written)?.[1];
    if (id === undefined) throw new Error(`no memory id in ${written}`);
    return id;
  }

  it('answers only its own credential, bound to the primary contact, from loopback and never a browser', async () => {
    const w = world();
    const none = await garden(w, 'GET', '/api/lite/overview', { credential: null });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Bearer');
    // The tool transport's credential for the same operator does not open the Garden.
    expect((await garden(w, 'GET', '/api/lite/overview', { credential: w.credentials['hermes-operator'] })).status).toBe(401);
    expect((await garden(w, 'GET', '/api/lite/overview', { credential: 'x'.repeat(40) })).status).toBe(401);
    expect((await garden(w, 'GET', '/api/lite/overview', { headers: { Origin: 'http://127.0.0.1:5173' } })).status).toBe(403);
    expect((await garden(w, 'GET', '/api/admin/memory', { headers: { Origin: 'null' } })).status).toBe(403);
    const foreign = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${w.garden?.url ?? ''}/api/lite/overview`);
      const sent = request({ host: url.hostname, port: url.port, path: url.pathname, headers: { Host: 'garden.example', Authorization: `Bearer ${w.garden?.credential ?? ''}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      sent.on('error', reject);
      sent.end();
    });
    expect(foreign).toBe(403);
    const missing = await garden(w, 'GET', '/api/admin/wiki');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
  }, RUNTIME_TIMEOUT_MS);

  it('serves every route the Desktop half calls', async () => {
    // The paths come from the Desktop half's own builders (integrations/hermes/desktop/src/api.ts). The Garden answers
    // a path no route serves with exactly `{"error":"not found"}`; any other answer means a route took the request.
    // Every write here names something that does not exist or carries an invalid body, so nothing changes.
    const w = world();
    const ghost = '0193f1c2-0000-7000-8000-000000000000';
    const sessions = (await garden(w, 'GET', desktop.sessions)).body['channels'] as { channelId: string }[];
    const conversationKey = sessions[0]?.channelId ?? 'none';
    const calls: [string, string, unknown?][] = [
      ['GET', desktop.overview], ['GET', desktop.memories], ['GET', desktop.memorySearch('basil')], ['GET', desktop.memory(ghost)],
      ['GET', desktop.memoryDeletions], ['GET', desktop.identity], ['GET', desktop.prompts], ['GET', desktop.layer('no-such-layer')],
      ['GET', desktop.layerDiff('no-such-layer')], ['GET', desktop.constitution], ['GET', desktop.northStar], ['GET', desktop.contacts],
      ['GET', desktop.claims], ['GET', desktop.graphProposals], ['GET', desktop.sessions], ['GET', desktop.sessionMessages(conversationKey)],
      ['GET', desktop.sessionTurn(conversationKey, 'no-such-turn')], ['GET', desktop.concerns], ['GET', desktop.innerLife],
      ['GET', desktop.schedule], ['GET', desktop.automata(null)], ['GET', desktop.automata('no-such-run')], ['GET', desktop.settings],
      ['POST', desktop.deleteMemory(ghost), {}], ['POST', desktop.restoreMemory, { deleteId: 'no-such-checkpoint' }],
      ['POST', desktop.decideDeletion('no-such-proposal', 'approve')], ['POST', desktop.decideDeletion('no-such-proposal', 'reject')],
      ['POST', desktop.identityRollback, { version: 999_999 }], ['POST', desktop.layerRollback('no-such-layer'), { version: 999_999 }],
      ['POST', desktop.decideGraphProposal('no-such-proposal', 'approve'), {}], ['POST', desktop.decideGraphProposal('no-such-proposal', 'reject')],
      ['POST', desktop.resolveConcern('no-such-concern'), {}], ['POST', desktop.transitionConcern('no-such-concern'), { status: 'watching' }],
      ['PATCH', desktop.patchMemory(ghost), { text: 'x', reason: 'x' }], ['PATCH', desktop.identityField, { field: 'no_such_field', value: 'x' }],
      ['PATCH', desktop.layer('no-such-layer'), { content: 'x' }],
      ['PUT', desktop.tier, { tier: 'omnipotent', customTokens: [] }], ['PUT', desktop.scheduler, { tickIntervalMs: 'never' }],
    ];
    const unserved: string[] = [];
    for (const [method, target, body] of calls) {
      const answer = await garden(w, method, target, body === undefined ? {} : { body });
      if (answer.status === 404 && JSON.stringify(answer.body) === '{"error":"not found"}') unserved.push(`${method} ${target}`);
    }
    expect(unserved).toEqual([]);
    // The guard itself: a path no route serves is told apart.
    expect((await garden(w, 'GET', '/api/admin/no-such-screen')).body).toEqual({ error: 'not found' });
  }, RUNTIME_TIMEOUT_MS);

  it('serves the reads of every screen', async () => {
    const w = world();
    await remember(w, 'read-1', 'Robin plants basil every spring');
    const reads = [
      '/api/lite/overview',
      '/api/admin/memory',
      '/api/admin/memory/search?q=basil',
      '/api/lite/memory-deletions',
      '/api/admin/identity',
      '/api/admin/prompts',
      '/api/admin/prompts/north-star',
      '/api/admin/contacts',
      '/api/admin/biographical-claims',
      '/api/admin/graph-proposals',
      '/api/admin/sessions',
      '/api/admin/concerns',
      '/api/lite/inner-life',
      '/api/admin/scheduler',
      '/api/admin/automata',
      '/api/lite/settings',
    ];
    for (const path of reads) {
      const answer = await garden(w, 'GET', path);
      expect(answer.status, `${path}: ${JSON.stringify(answer.body)}`).toBe(200);
    }
    const overview = (await garden(w, 'GET', '/api/lite/overview')).body;
    expect(overview).toMatchObject({ model: { provider: 'faux', modelId: 'faux-1' }, tier: { tier: 'autonomous' }, restartRequired: false });
    expect(overview['emotion']).toEqual(expect.objectContaining({}));
    expect((overview['recentTurns'] as unknown[]).length).toBeGreaterThan(0);
    const settings = (await garden(w, 'GET', '/api/lite/settings')).body;
    expect(settings).toMatchObject({ model: { provider: 'faux', modelId: 'faux-1' }, tier: { tier: 'autonomous' } });
    expect((await garden(w, 'GET', '/api/lite/inner-life')).body).toMatchObject({ introspectionConsent: { enabled: false } });
    const sessions = (await garden(w, 'GET', '/api/admin/sessions')).body['channels'] as { channelId: string }[];
    expect(sessions.length).toBeGreaterThan(0);
  }, RUNTIME_TIMEOUT_MS);

  it('deletes and restores a memory through the companion\'s store, audited as the operator', async () => {
    const w = world();
    const target = await remember(w, 'del-1', 'Robin\'s locker code is 4711');
    const deleted = await garden(w, 'POST', `/api/lite/memories/${target}/delete`, { body: { reason: 'wrong code' } });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    const deleteId = deleted.body['deleteId'] as string;
    const [row] = await sql<{ deleted_by: string; memory_id: string }>(w, 'SELECT deleted_by, memory_id FROM l2_memory_delete_versions WHERE delete_id = $1', [deleteId]);
    expect(row).toEqual({ deleted_by: 'garden:garden-operator', memory_id: target });
    const [live] = await sql<{ deleted_at: string | null }>(w, 'SELECT deleted_at FROM l2_memories WHERE id = $1', [target]);
    expect(live?.deleted_at).not.toBeNull();
    expect((await garden(w, 'POST', '/api/lite/memories/not-a-memory/delete', { body: {} })).status).toBe(404);

    const restored = await garden(w, 'POST', '/api/lite/memories/restore', { body: { deleteId } });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    const [back] = await sql<{ deleted_at: string | null }>(w, 'SELECT deleted_at FROM l2_memories WHERE id = $1', [target]);
    expect(back?.deleted_at).toBeNull();
    // The donor store's restore is idempotent: a second restore of the checkpoint leaves the memory active.
    expect((await garden(w, 'POST', '/api/lite/memories/restore', { body: { deleteId } })).status).toBe(200);
    expect((await sql<{ deleted_at: string | null }>(w, 'SELECT deleted_at FROM l2_memories WHERE id = $1', [target]))[0]?.deleted_at).toBeNull();
    expect((await garden(w, 'POST', '/api/lite/memories/restore', { body: { deleteId: 'no-such-checkpoint' } })).status).toBe(404);

    // A donor write: redacting the memory's text through the donor memory service.
    const redacted = await garden(w, 'PATCH', `/api/admin/memory/${target}/patch`, { body: { text: 'Robin has a locker code.', reason: 'redact the code' } });
    expect(redacted.status, JSON.stringify(redacted.body)).toBe(200);
    const [text] = await sql<{ text: string }>(w, 'SELECT text FROM l2_memories WHERE id = $1', [target]);
    expect(text?.text).toBe('Robin has a locker code.');

    const entries = await auditEntries(w);
    const memoryWrites = entries.filter((entry) => entry['actionType'] === 'memory_mutation');
    expect(memoryWrites.length).toBeGreaterThanOrEqual(3);
    for (const entry of memoryWrites) expect(entry).toMatchObject({ source: 'garden', actor: 'operator' });
  }, RUNTIME_TIMEOUT_MS);

  it('decides pending deletion proposals but leaves one its host turn still waits on to the host', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const target = await remember(w, 'prop-1', 'Robin\'s bike lock is red');
    const kept = await remember(w, 'prop-2', 'Robin rides on Sundays');

    await hostTurn(w, 'prop-turn', async (client) => {
      const proposed = await tool(client, 'memory', { action: 'delete', memory_id: target, justification_category: 'factually_incorrect', explanation: EXPLANATION });
      const proposalId = /Memory deletion proposal (\S+) is pending/.exec(proposed)?.[1] ?? '';
      const listed = (await garden(w, 'GET', '/api/lite/memory-deletions')).body['pending'] as { id: string; awaitingHostTurn: boolean }[];
      expect(listed.find((p) => p.id === proposalId)?.awaitingHostTurn).toBe(true);
      // The Garden refuses it and does not use up the host's request: the in-turn gate still approves it.
      const refused = await garden(w, 'POST', `/api/lite/memory-deletions/${proposalId}/approve`);
      expect(refused.status).toBe(409);
      expect(refused.body['error']).toMatchObject({ reason: 'awaiting_host_turn' });
      expect((await garden(w, 'POST', `/api/lite/memory-deletions/${proposalId}/reject`)).status).toBe(409);
      const approved = await bridge(w, 'memory-deletion/approve', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, proposalId, memoryId: target });
      expect(approved.status).toBe(200);
    });
    expect((await w.runtime.companion.persistence.memoryStore.getById(target))?.deletedAt).toEqual(expect.any(Number));

    // Proposals no host turn waits on any more are the operator's to decide.
    let approveId = '';
    let rejectId = '';
    await hostTurn(w, 'prop-turn-2', async (client) => {
      const first = await tool(client, 'memory', { action: 'delete', memory_id: kept, justification_category: 'factually_incorrect', explanation: EXPLANATION });
      rejectId = /Memory deletion proposal (\S+) is pending/.exec(first)?.[1] ?? '';
    });
    const rejected = await garden(w, 'POST', `/api/lite/memory-deletions/${rejectId}/reject`);
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await w.runtime.companion.persistence.memoryStore.getById(kept))?.deletedAt).toBeUndefined();
    const [denied] = await sql<{ status: string }>(w, 'SELECT status FROM memory_deletion_proposals WHERE id = $1', [rejectId]);
    expect(denied?.status).toBe('denied');
    expect((await garden(w, 'POST', `/api/lite/memory-deletions/${rejectId}/approve`)).status).toBe(409);

    await hostTurn(w, 'prop-turn-3', async (client) => {
      const second = await tool(client, 'memory', { action: 'delete', memory_id: kept, justification_category: 'factually_incorrect', explanation: EXPLANATION });
      approveId = /Memory deletion proposal (\S+) is pending/.exec(second)?.[1] ?? '';
    });
    const approved = await garden(w, 'POST', `/api/lite/memory-deletions/${approveId}/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ proposalId: approveId, status: 'approved', deleteId: expect.any(String) });
    const [decided] = await sql<{ status: string }>(w, 'SELECT status FROM memory_deletion_proposals WHERE id = $1', [approveId]);
    expect(decided?.status).toBe('approved');
    expect((await w.runtime.companion.persistence.memoryStore.getById(kept))?.deletedAt).toEqual(expect.any(Number));
  }, RUNTIME_TIMEOUT_MS);

  it('writes the owner files for Settings and answers restart-needed, refusing an invalid document', async () => {
    const w = world();
    const tierPath = join(w.install.dataDir, 'capability-tier.json');
    const before = await readFile(tierPath, 'utf8');
    const refused = await garden(w, 'PUT', '/api/lite/settings/tier', { body: { tier: 'omnipotent', customTokens: [] } });
    expect(refused.status).toBe(400);
    expect(await readFile(tierPath, 'utf8')).toBe(before);

    const written = await garden(w, 'PUT', '/api/lite/settings/tier', { body: { tier: 'apprentice', customTokens: [] } });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body).toMatchObject({ restartRequired: true, tier: { tier: 'apprentice' } });
    expect(JSON.parse(await readFile(tierPath, 'utf8'))).toEqual({ tier: 'apprentice', customTokens: [] });

    const scheduler = (await garden(w, 'GET', '/api/lite/settings')).body['scheduler'];
    const saved = await garden(w, 'PUT', '/api/lite/settings/scheduler', { body: scheduler });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body['restartRequired']).toBe(true);
    expect((await garden(w, 'GET', '/api/lite/overview')).body['restartRequired']).toBe(true);

    // A donor persona write, through the donor identity service, audited as the operator as the donor route records it.
    const field = await garden(w, 'PATCH', '/api/admin/identity/fields', { body: { field: 'scenario', value: 'A quiet garden.' } });
    expect(field.status, JSON.stringify(field.body)).toBe(200);
    expect((await garden(w, 'GET', '/api/admin/identity')).body).toMatchObject({ card: { data: { scenario: 'A quiet garden.' } } });
    const entries = await auditEntries(w);
    expect(entries.filter((entry) => entry['actionType'] === 'settings_change' && entry['decision'] === 'allowed')).toHaveLength(2);
    expect(entries.find((entry) => entry['actionType'] === 'identity_edit' && entry['decision'] === 'allowed')).toMatchObject({ source: 'garden', actor: 'operator' });
  }, RUNTIME_TIMEOUT_MS);
});
