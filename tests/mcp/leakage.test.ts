/**
 * Nothing crosses the transport that core would not show the bound caller:
 * no credential in any response or operator report, no other audience's
 * content or counts, no companion-private state for participants, and no
 * storage detail in an unavailable error.
 */
import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_DISCLOSURE_POLICY,
  createContactAuthority,
  createTrustedIngress,
  unavailable,
  type ToolDispatcher,
} from '../../packages/core/src/index.ts';
import { createMcpSurface, type McpErrorReport } from '../../packages/mcp/src/index.ts';
import { COMPANION } from '../core/fakes.ts';
import { fakeMcpWorld, invoke, mustInvoke, type ToolOutcome } from './mcp-world.ts';

const errorOf = (outcome: ToolOutcome) => outcome.payload['error'] as Record<string, unknown> | undefined;

describe('cross-audience disclosure over MCP', () => {
  it('hides another conversation’s memory, notes, journal and activity, including from counts', async () => {
    const w = await fakeMcpWorld();
    const friend = await w.as('friend');
    const acquaintance = await w.as('acquaintance');
    await w.converse(await w.admit('friend-dm'), 'my sister is ill', 'I am sorry, Sam', 'friend-1');
    const secret = 'Sam’s sister has a diagnosis nobody else knows';
    const written = await mustInvoke<{ memoryId: string }>(friend, 'memory', { action: 'write', writeId: 'f-1', kind: 'event', content: secret, sensitivity: 'personal' });
    await mustInvoke(friend, 'journal', { action: 'write', path: 'sam/sister.md', body: secret });
    const activity = await mustInvoke<{ id: string }>(friend, 'activity', { action: 'start', purpose: secret });
    const before = await mustInvoke<Record<string, unknown>>(acquaintance, 'memory', { action: 'census' });

    const outcomes: ToolOutcome[] = [
      await invoke(acquaintance, 'memory', { action: 'search', query: 'sister diagnosis' }),
      await invoke(acquaintance, 'memory', { action: 'census' }),
      await invoke(acquaintance, 'journal', { action: 'list' }),
      await invoke(acquaintance, 'journal', { action: 'search', query: 'sister' }),
      await invoke(acquaintance, 'activity', { action: 'recent' }),
      await invoke(acquaintance, 'session', { action: 'grep', pattern: 'sister' }),
    ];
    for (const outcome of outcomes) expect(outcome.text).not.toContain('sister');
    expect(outcomes[1]?.payload['content']).toEqual(before);

    // A withheld record reads exactly like one that does not exist.
    const hidden = await invoke(acquaintance, 'memory', { action: 'get', memoryId: written.memoryId });
    const absent = await invoke(acquaintance, 'memory', { action: 'get', memoryId: 'memory-does-not-exist' });
    expect(errorOf(hidden)?.['kind']).toBe('not_found');
    expect(Object.keys(errorOf(hidden) ?? {})).toEqual(Object.keys(errorOf(absent) ?? {}));
    expect(errorOf(await invoke(acquaintance, 'journal', { action: 'read', path: 'sam/sister.md' }))?.['kind']).toBe('not_found');
    expect(errorOf(await invoke(acquaintance, 'activity', { action: 'get', activityId: activity.id }))?.['kind']).toBe('not_found');
    expect(errorOf(await invoke(acquaintance, 'activity', { action: 'update', activityId: activity.id, expectedRevision: 1, note: 'x' }))?.['kind']).toBe('not_found');

    // The friend's own room still sees it.
    expect((await invoke(friend, 'memory', { action: 'get', memoryId: written.memoryId })).text).toContain('sister');
  });

  it('keeps companion-private state from participants and keeps each scope’s affect local', async () => {
    const w = await fakeMcpWorld();
    const privateText = 'a private reflection about the move';
    expect((await w.journal.recordReflection(await w.admit('reflection'), { reflectionId: 'r-1', templateId: 't', kind: 'companion_reflection', text: privateText })).ok).toBe(true);
    await w.talk(await w.admit('primary-dm'), 'we are moving', 'that is a big change', 'p-1');
    expect(await w.inSelfTurn(async (self) => (await invoke(self, 'journal', { action: 'reflections_read', reflectionId: 'r-1' })).text)).toContain(privateText);

    const friend = await w.as('friend');
    for (const [tool, action] of [
      ['journal', 'reflections_list'],
      ['journal', 'letter_list'],
      ['emotion', 'appraisals'],
      ['free_time', 'status'],
      ['free_time', 'scheduled_list'],
    ] as const) {
      const outcome = await invoke(friend, tool, { action });
      expect(errorOf(outcome), `${tool}.${action}`).toMatchObject({ kind: 'denied', reason: 'audience_not_admitted' });
      expect(outcome.payload).not.toHaveProperty('content');
    }
    const read = await invoke(friend, 'journal', { action: 'reflections_read', reflectionId: 'r-1' });
    expect(read.text).not.toContain(privateText);
    const meaning = await invoke(await w.as('primary'), 'episode', { action: 'author_meaning', episodeId: 'ep-1', text: 'x', expectedRevision: 0 });
    expect(errorOf(meaning)?.['kind']).toBe('denied');
    // Robin's DM has a trusted estimate; Sam's scope never sees it.
    expect((await invoke(await w.as('primary'), 'emotion', { action: 'read' })).isError).toBe(false);
    expect(errorOf(await invoke(friend, 'emotion', { action: 'read' }))?.['kind']).toBe('not_found');
  });

  it('never returns or reports a credential', async () => {
    const w = await fakeMcpWorld();
    const seen: string[] = [];
    const record = (outcome: ToolOutcome) => seen.push(outcome.text, JSON.stringify(outcome.payload));
    const probe = async (client: Client, smuggled: string) => {
      seen.push(JSON.stringify(await client.listTools()));
      record(await invoke(client, 'memory', { action: 'census' }));
      record(await invoke(client, 'memory', { action: 'census', caller: w.credentials.primary }));
      // Core echoes a caller's own argument (a missing subject); a credential smuggled as an authority key is refused without echo.
      record(await invoke(client, 'journal', { action: 'reflections_list', viewer: smuggled }));
    };
    const turnCredential = await w.inSelfTurn(async (self, credential) => {
      await probe(self, w.credentials.friend);
      return credential;
    });
    for (const principal of ['primary', 'friend', 'nobody', 'self-claim'] as const) await probe(await w.as(principal), turnCredential);
    const refused = await fetch(w.url, { method: 'POST', headers: { Authorization: `Bearer ${w.credentials.primary}x` } });
    seen.push(await refused.text(), JSON.stringify([...refused.headers]));
    seen.push(JSON.stringify(w.errors), JSON.stringify(w.surface.tools));
    const all = seen.join('\n');
    for (const credential of [...Object.values(w.credentials), turnCredential]) {
      expect(all).not.toContain(credential);
      expect(all).not.toContain(credential.slice(0, 16));
    }
  });
});

describe('failure rendering', () => {
  async function surfaceWith(dispatch: ToolDispatcher['dispatch']) {
    const w = await fakeMcpWorld();
    const ingress = createTrustedIngress({
      companionId: COMPANION,
      authenticator: w.bindings.authenticator,
      contacts: createContactAuthority(w.contactStore),
      policy: BASELINE_DISCLOSURE_POLICY,
    });
    if (!ingress.ok) throw new Error('ingress');
    const reports: McpErrorReport[] = [];
    const surface = createMcpSurface({ dispatcher: { dispatch }, ingress: ingress.value, onError: (r) => reports.push(r) });
    if (!surface.ok) throw new Error('surface');
    return { w, surface: surface.value, reports };
  }

  it('redacts unavailable details for the client and gives them to the operator', async () => {
    const leak = 'connect ECONNREFUSED postgres://lite:hunter2@db/lite relation "memories"';
    const { w, surface, reports } = await surfaceWith(() => Promise.resolve(unavailable('postgres', leak)));
    const result = await surface.call(w.credentials.primary, 'memory', { action: 'census' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(result.structuredContent).toEqual({ error: { kind: 'unavailable', capability: 'postgres', detail: 'the capability is unavailable; try again later' } });
    expect(reports).toEqual([{ stage: 'dispatch', tool: 'memory', action: 'census', error: { kind: 'unavailable', capability: 'postgres', detail: leak } }]);
  });

  it('turns a thrown failure into a generic unavailable result', async () => {
    const { w, surface, reports } = await surfaceWith(() => Promise.reject(new Error('stack with secret-token-material')));
    const result = await surface.call(w.credentials.primary, 'memory', { action: 'census' });
    expect(JSON.stringify(result)).not.toContain('secret-token-material');
    expect(result.structuredContent).toMatchObject({ error: { kind: 'unavailable', capability: 'memory.census' } });
    expect(reports[0]).toMatchObject({ stage: 'dispatch', error: { kind: 'exception', message: 'stack with secret-token-material' } });
  });

  it('admits before dispatching: an unbound credential never reaches the dispatcher', async () => {
    let dispatched = 0;
    const { surface } = await surfaceWith(() => {
      dispatched += 1;
      return Promise.resolve(unavailable('x', 'y'));
    });
    const result = await surface.call('not-a-bound-credential-but-long-enough-000', 'memory', { action: 'census' });
    expect(result.structuredContent).toMatchObject({ error: { kind: 'denied', reason: 'unknown_authority' } });
    expect(dispatched).toBe(0);
  });
});
