import { describe, expect, it } from 'vitest';
import { deriveWorkerScope, type RenderedEntry, type SessionSummary } from '../../packages/core/src/index.ts';
import { continuityWorld } from './continuity-world.ts';
import { TOOL_TRANSPORT, id } from './fakes.ts';

const errorOf = (result: { ok: boolean; error?: unknown }) => (result.ok ? 'ok' : result.error);
const sessionIdsOf = (content: unknown) => (content as SessionSummary[]).map((s) => s.session.sessionId);
const textsOf = (content: unknown) => (content as RenderedEntry[]).map((e) => e.text);

describe('session tool visibility', () => {
  it('lets the primary DM read other conversations but keeps the primary DM from other contacts', async () => {
    const world = await continuityWorld();
    const primary = await world.admit('primary-dm');
    const friend = await world.admit('friend-dm');
    const primarySession = await world.converse(primary, 'I am nervous about tomorrow', 'I am here with you', 'k1');
    const friendSession = await world.converse(friend, 'hiking on saturday?', 'yes, gladly', 'k2');

    const fromFriend = await world.call(friend, 'session', 'list');
    expect(fromFriend.ok && sessionIdsOf(fromFriend.value.content)).toEqual([friendSession]);
    expect(errorOf(await world.call(friend, 'session', 'messages', { sessionId: primarySession }))).toEqual({
      kind: 'not_found',
      subject: `session ${primarySession}`,
    });
    expect(errorOf(await world.call(friend, 'session', 'grep', { pattern: 'nervous' }))).toBe('ok');
    const grep = await world.call(friend, 'session', 'grep', { pattern: 'nervous' });
    expect(grep.ok && grep.value.content).toEqual([]);

    const fromPrimary = await world.call(primary, 'session', 'messages', { sessionId: friendSession });
    expect(fromPrimary.ok && textsOf(fromPrimary.value.content)).toEqual(['hiking on saturday?', 'yes, gladly']);
    const roles = fromPrimary.ok ? (fromPrimary.value.content as RenderedEntry[]).map((e) => e.role) : [];
    expect(roles).toEqual(['participant', 'companion']);
  });

  it('keeps companion-internal sessions from every participant and caps workers at their grant', async () => {
    const world = await continuityWorld();
    const self = await world.admit('free-time');
    const selfSession = await world.sessions.current(self);
    if (!selfSession.ok) throw new Error('self session');
    const primary = await world.admit('primary-dm');
    expect(errorOf(await world.call(primary, 'session', 'messages', { sessionId: selfSession.value.sessionId }))).toMatchObject({ kind: 'not_found' });

    await world.converse(primary, 'private thing', 'held', 'k1');
    const worker = deriveWorkerScope(primary, id('run-1'), {
      actions: [{ tool: 'session', action: 'messages' }],
      maxTurns: 1,
      maxSensitivity: 'personal',
    });
    if (!worker.ok) throw new Error('worker');
    expect(errorOf(await world.call(worker.value, 'session', 'messages'))).toMatchObject({ kind: 'not_found' });
  });

  it('serves search only from a projection proven level with the canon, rebuilding a divergent one', async () => {
    const world = await continuityWorld();
    const primary = await world.admit('primary-dm');
    const session = await world.converse(primary, 'the lighthouse trip', 'the fog was beautiful', 'k1');
    const first = await world.call(primary, 'session', 'search', { query: 'lighthouse' });
    expect(first.ok && textsOf((first.value.content as { hits: unknown }).hits)).toEqual(['the lighthouse trip']);

    // Corrupt the projection: a row the canon never held, at a position the canon disagrees with.
    const rows = world.projection.rows.get(session) ?? [];
    const forged = rows.map((row) => ({ ...row, hash: 'forged', entry: { ...row.entry, text: 'lighthouse forged' } }));
    world.projection.rows.set(session, forged);
    await world.converse(primary, 'and back again', 'safe home', 'k2');
    const repaired = await world.call(primary, 'session', 'search', { query: 'lighthouse' });
    expect(repaired.ok && textsOf((repaired.value.content as { hits: unknown }).hits)).toEqual(['the lighthouse trip']);
    expect(world.projection.rows.get(session)).toHaveLength(4);
  });

  it('attributes a requested search summary as machine inference, never companion speech', async () => {
    const world = await continuityWorld();
    const primary = await world.admit('primary-dm');
    await world.converse(primary, 'garden plans', 'tomatoes first', 'k1');
    const result = await world.call(primary, 'session', 'search', { query: 'garden', summarize: true });
    expect(result.ok && result.value.content).toMatchObject({ summary: { origin: { kind: 'machine_inference' }, text: 'machine summary' } });
    expect(world.model.calls[0]?.attribution.output).toBe('machine_inference');
  });
});

describe('session lineage and continuity', () => {
  it('starts new sessions with lineage, resumes own sessions and continues others in this conversation', async () => {
    const world = await continuityWorld();
    const primary = await world.admit('primary-dm');
    const first = await world.converse(primary, 'one', 'a', 'k1');
    const fresh = await world.call(primary, 'session', 'new');
    expect(fresh.ok && fresh.value.content).toMatchObject({ previousSessionId: first, audience: primary.audience });
    const current = await world.sessions.current(primary);
    expect(current.ok && current.value.sessionId).not.toBe(first);

    const resumed = await world.call(primary, 'session', 'resume', { sessionId: first });
    expect(resumed.ok && resumed.value.content).toMatchObject({ sessionId: first });
    expect((await world.sessions.current(primary)).ok && (await world.sessions.current(primary))).toMatchObject({ value: { sessionId: first } });

    const friend = await world.admit('friend-dm');
    const friendSession = await world.converse(friend, 'two', 'b', 'k2');
    const continued = await world.call(primary, 'session', 'resume', { sessionId: friendSession });
    expect(continued.ok && continued.value.content).toMatchObject({ continuesFrom: friendSession, audience: primary.audience });
    expect(errorOf(await world.call(friend, 'session', 'resume', { sessionId: first }))).toMatchObject({ kind: 'not_found' });
  });

  it('records attributed wake/return notes and focus knowledge, with model summaries kept machine-attributed', async () => {
    const world = await continuityWorld();
    const primary = await world.admit('primary-dm');
    const session = await world.converse(primary, 'before', 'x', 'k1');
    const note = await world.call(primary, 'session', 'wake_return', { summary: 'we left off planning the move', occasion: 'return' });
    expect(note.ok && note.value.content).toMatchObject({ sessionId: session, author: { kind: 'companion' }, kind: 'wake_return' });
    const listed = await world.call(primary, 'session', 'continuity_list');
    expect(listed.ok && (listed.value.content as unknown[]).length).toBe(1);

    await world.call(primary, 'session', 'start_focus', { focus: 'moving plan' });
    expect(errorOf(await world.call(primary, 'session', 'start_focus', { focus: 'again' }))).toMatchObject({ kind: 'conflict' });
    await world.converse(primary, 'boxes on friday', 'van on saturday', 'k2');
    const done = await world.call(primary, 'session', 'complete_focus');
    expect(done.ok && done.value.content).toMatchObject({
      startSeq: 2,
      completion: { endSeq: 4, knowledge: 'machine summary', author: { kind: 'machine', producer: 'session_summary' } },
    });
    expect(world.model.calls[0]?.messages.map((m) => m.text)).toContain('boxes on friday');

    await world.call(primary, 'session', 'start_focus', { focus: 'second' });
    const authored = await world.call(primary, 'session', 'complete_focus', { knowledge: 'I decided to keep the piano' });
    expect(authored.ok && authored.value.content).toMatchObject({ completion: { author: { kind: 'companion' } } });
  });

  it('keeps every session and entry across a harness reset and a different surface', async () => {
    const world = await continuityWorld();
    const primary = await world.admit('primary-dm');
    const first = await world.converse(primary, 'remember the blue door', 'always', 'k1');
    await world.call(primary, 'session', 'new');
    // A replacement harness on another surface: new lifecycle instance, new scope, same core state.
    world.authenticator.tokens.set('primary-dm-mcp', { ...(world.authenticator.tokens.get('primary-dm') as object), surface: TOOL_TRANSPORT });
    const replacement = await world.admit('primary-dm-mcp');
    const history = await world.call(replacement, 'session', 'messages', { sessionId: first });
    expect(history.ok && textsOf(history.value.content)).toEqual(['remember the blue door', 'always']);
    const listed = await world.call(replacement, 'session', 'list');
    expect(listed.ok && sessionIdsOf(listed.value.content)).toHaveLength(2);
  });

  it('refuses session switching in background turns and by workers', async () => {
    const world = await continuityWorld();
    expect(errorOf(await world.call(await world.admit('friend-dm-background'), 'session', 'new'))).toMatchObject({ reason: 'background_turn' });
    const parent = await world.admit('primary-dm');
    const worker = deriveWorkerScope(parent, id('run-2'), { actions: [{ tool: 'session', action: 'list' }], maxTurns: 1, maxSensitivity: 'confidential' });
    if (!worker.ok) throw new Error('worker');
    expect(errorOf(await world.sessions.startNew(worker.value))).toMatchObject({ reason: 'worker_not_permitted' });
  });
});
