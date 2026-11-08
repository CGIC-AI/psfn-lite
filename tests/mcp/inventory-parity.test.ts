/**
 * Inventory parity over a real MCP client-server connection: the server
 * lists exactly one tool per inventory tool with exactly the inventory's
 * actions, and every action is called through the SDK client, reaching its
 * core handler under the caller bound from the credential.
 */
import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { TOOL_INVENTORY, ok, type TrustedTurnScope } from '../../packages/core/src/index.ts';
import { ACTIONS_META_KEY, type ActionCatalogEntry } from '../../packages/mcp/src/index.ts';
import { OPERATOR } from '../core/continuity-world.ts';
import { fakeMcpWorld, invoke, type Principal, type ToolOutcome } from './mcp-world.ts';

type World = Awaited<ReturnType<typeof fakeMcpWorld>>;

const ALL_ACTIONS = TOOL_INVENTORY.flatMap((t) => t.actions.map((a) => `${t.name}.${a.name}`));

describe('MCP tool listing', () => {
  it('lists exactly one tool per inventory tool, with the inventory actions as the discriminator', async () => {
    const w = await fakeMcpWorld();
    const listed = await (await w.as('primary')).listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(TOOL_INVENTORY.map((t) => t.name));
    for (const tool of TOOL_INVENTORY) {
      const served = listed.tools.find((t) => t.name === tool.name);
      const schema = served?.inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] } | undefined;
      expect(schema?.required).toEqual(['action']);
      expect(schema?.properties['action']?.enum).toEqual(tool.actions.map((a) => a.name));
      const meta = (served?._meta as Record<string, ActionCatalogEntry[]> | undefined)?.[ACTIONS_META_KEY] ?? [];
      expect(meta.map((m) => [m.name, m.access, m.privacy, m.admission, m.restrictions, m.workers, m.inference])).toEqual(
        tool.actions.map((a) => [a.name, a.access, a.privacy, a.admission, a.restrictions, a.workers, a.inference]),
      );
      expect(served?.annotations?.readOnlyHint).toBe(tool.actions.every((a) => a.access === 'read'));
      for (const action of tool.actions) expect(served?.description).toContain(`- ${action.name} [`);
      // No identity-shaped property is ever offered to the model.
      for (const key of ['caller', 'viewer', 'companionId', 'trustedScope', 'admitted', 'audience', 'surface']) expect(schema?.properties).not.toHaveProperty(key);
    }
  });
});

/** Records every action called and checks it reached its handler. A caller is a bound principal or a client inside an internal turn. */
function harness(w: World) {
  const covered = new Set<string>();
  const call = async (principal: Principal | Client, tool: string, action: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    const outcome = await invoke(typeof principal === 'string' ? await w.as(principal) : principal, tool, { action, ...args });
    covered.add(`${tool}.${action}`);
    return outcome;
  };
  const must = async <T = Record<string, unknown>>(principal: Principal | Client, tool: string, action: string, args: Record<string, unknown> = {}): Promise<T> => {
    const outcome = await call(principal, tool, action, args);
    if (outcome.isError) throw new Error(`${tool}.${action} as ${typeof principal === 'string' ? principal : 'the companion'} failed: ${outcome.text}`);
    expect(outcome.payload['origin']).toEqual({ kind: 'tool_result', tool, action });
    return outcome.payload['content'] as T;
  };
  return { covered, call, must };
}

const errorOf = (outcome: ToolOutcome) => outcome.payload['error'] as { kind: string; reason?: string } | undefined;

describe('MCP inventory parity', () => {
  it('calls every inventory action over a real client connection', async () => {
    const w = await fakeMcpWorld();
    const { covered, call, must } = harness(w);
    await w.identityAdmin.defineLayer(OPERATOR, { id: 'runtime', name: 'Runtime', type: 'runtime', content: 'line one' });
    await w.identityAdmin.setPersona(OPERATOR, { name: 'Wren', personality: 'curious' }, 'seed');
    const primaryScope = await w.admit('primary-dm');
    // The host observes the settled turn, so a trusted affect estimate exists for emotion.read.
    const { sessionId: firstSession } = await w.talk(primaryScope, 'hello, I planted tomatoes today', 'that sounds lovely', 'turn-1');

    // orient
    await must('primary', 'orient', 'view');
    await must('primary', 'orient', 'append', { block: 'human', text: 'Robin likes tea' });
    await must('primary', 'orient', 'replace', { block: 'human', oldText: 'tea', newText: 'green tea' });
    await must('primary', 'orient', 'reorient', { persona: 'Wren', human: 'Robin likes green tea', goals: 'Help with the garden' });
    expect((await must<{ id: string }[]>('primary', 'orient', 'list_layers')).map((l) => l.id)).toEqual(['runtime']);
    await must('primary', 'orient', 'get_layer', { layerId: 'runtime' });
    expect(await must('primary', 'orient', 'update_layer', { layerId: 'runtime', content: 'line one\nline two', reason: 'more' })).toMatchObject({ status: 'applied' });
    expect(await must('primary', 'orient', 'diff_layer', { layerId: 'runtime' })).toEqual({ fromVersion: 1, toVersion: 2, added: ['line two'], removed: [] });
    await must('primary', 'orient', 'layer_history', { layerId: 'runtime' });
    await must('primary', 'orient', 'rollback_layer', { layerId: 'runtime', version: 1, reason: 'undo' });
    await must('primary', 'orient', 'toggle_layer', { layerId: 'runtime', reason: 'pause' });
    await must('primary', 'orient', 'update_persona', { patch: { tags: ['gardening'] }, reason: 'new interest' });

    // values and North Star
    await must('primary', 'values', 'add_value', { value: 'honesty over comfort' });
    await must('primary', 'values', 'revise_value', { version: 1, value: 'honesty with care' });
    expect(await must<unknown[]>('primary', 'values', 'list_values')).toHaveLength(2);
    const [star] = await must<{ id: string }[]>('primary', 'values', 'north_star_create', { title: 'Garden', content: 'Grow food together' });
    const starId = star?.id ?? '';
    await must('primary', 'values', 'north_star_list');
    await must('primary', 'values', 'north_star_update', { itemId: starId, title: 'Shared garden' });
    await must('primary', 'values', 'north_star_reorder', { order: [starId] });
    await must('primary', 'values', 'north_star_retire', { itemId: starId });

    // memory
    const written = await must<{ memoryId: string }>('primary', 'memory', 'write', { writeId: 'w-1', kind: 'fact', content: 'Robin grows tomatoes', sensitivity: 'personal' });
    await must('primary', 'memory', 'get', { memoryId: written.memoryId });
    await must('primary', 'memory', 'search', { query: 'tomatoes' });
    await must('primary', 'memory', 'shared_background', { contactId: w.people.primary });
    await must('primary', 'memory', 'census');
    await must('primary', 'memory', 'import', {
      batchId: 'b-1',
      records: [{ kind: 'preference', content: 'Robin prefers mornings', sensitivity: 'personal', occurredAt: '2029-12-01' }],
    });
    await must('primary', 'memory', 'patch', { memoryId: written.memoryId, content: 'Robin grows cherry tomatoes', reason: 'more precise' });
    await must('primary', 'memory', 'propose_delete', { memoryId: written.memoryId, justification: 'obsolete', explanation: 'test' });
    // Restoring a memory that was never deleted reaches the handler and is refused there.
    const restore = await call('primary', 'memory', 'restore', { memoryId: written.memoryId });
    expect(restore.isError ? errorOf(restore)?.kind : 'ok').not.toBe('denied');
    const note = await must<{ id: string }>('primary', 'memory', 'scratchpad_add', { text: 'buy stakes' });
    await must('primary', 'memory', 'scratchpad_list');
    await must('primary', 'memory', 'scratchpad_replace', { noteId: note.id, text: 'buy bamboo stakes' });
    await must('primary', 'memory', 'scratchpad_append', { noteId: note.id, text: ' and twine' });
    await must('primary', 'memory', 'scratchpad_remove', { noteId: note.id });

    // sessions
    await must('primary', 'session', 'list');
    await must('primary', 'session', 'search', { query: 'tomatoes' });
    expect(await must<unknown[]>('primary', 'session', 'grep', { pattern: 'tomatoes' })).not.toHaveLength(0);
    await must('primary', 'session', 'messages');
    await must('primary', 'session', 'wake_return', { summary: 'we talked about the garden', occasion: 'return' });
    await must('primary', 'session', 'continuity_list');
    await must('primary', 'session', 'start_focus', { focus: 'garden plan' });
    await must('primary', 'session', 'complete_focus', { knowledge: 'three beds, tomatoes first' });
    await must('primary', 'session', 'new');
    await must('primary', 'session', 'resume', { sessionId: firstSession });

    // contacts
    const { acquaintance, stranger, friend } = w.people;
    await must('primary', 'contact', 'list');
    await must('primary', 'contact', 'search', { query: 'lee' });
    await must('primary', 'contact', 'lookup', { contactId: acquaintance });
    await must('primary', 'contact', 'note', { contactId: acquaintance, text: 'likes chess' });
    await must('primary', 'contact', 'set_trust', { contactId: stranger, trust: 'regular' });
    await must('primary', 'contact', 'propose_trust', { contactId: acquaintance, rationale: 'years of care' });
    await must('primary', 'contact', 'set_relationship', { contactId: stranger, relationship: 'acquaintance' });
    await must('primary', 'contact', 'propose_relationship', { contactId: friend, relationship: 'family', rationale: 'chosen family' });
    await must('primary', 'contact', 'link_identity', { contactId: acquaintance, channelKind: 'mail', externalId: 'lee@example.org', privacy: 'private' });
    await must('primary', 'contact', 'set_channel_privacy', { contactId: acquaintance, channelKind: 'mail', externalId: 'lee@example.org', privacy: 'public' });
    await must('primary', 'contact', 'set_machine_intelligence', { contactId: acquaintance, isMachineIntelligence: false });
    await must('primary', 'contact', 'block', { contactId: acquaintance, reason: 'test' });
    await must('primary', 'contact', 'unblock', { contactId: acquaintance });

    // emotion
    await must('primary', 'emotion', 'read');
    await must('primary', 'emotion', 'appraisals');
    await must('primary', 'emotion', 'self_report', { text: 'I feel settled today' });

    // concerns, follow-ups and care reminders
    const concern = await must<{ id: string; revision: number }>('primary', 'concern', 'create', { text: 'Robin is worried about the frost' });
    await must('primary', 'concern', 'list');
    const resolved = await must<{ concern?: { revision: number }; revision?: number }>('primary', 'concern', 'resolve', {
      concernId: concern.id,
      expectedRevision: concern.revision,
      outcome: 'the frost held off',
    });
    const resolvedRevision = resolved.concern?.revision ?? resolved.revision ?? concern.revision + 1;
    await must('primary', 'concern', 'transition', {
      concernId: concern.id,
      to: 'active',
      expectedRevision: resolvedRevision,
      evidenceRefs: [{ kind: 'note', ref: 'another cold night forecast' }],
    });
    const followUp = await must<{ followUp: { id: string; revision: number } }>('primary', 'concern', 'follow_up_create', {
      content: 'ask how the seedlings did',
      dueAt: '2030-01-02T09:00:00.000Z',
    });
    await must('primary', 'concern', 'follow_up_list');
    await must('primary', 'concern', 'follow_up_activate', { followUpId: followUp.followUp.id, expectedRevision: followUp.followUp.revision });
    await must('primary', 'concern', 'reminder_create', { kind: 'check_in', title: 'Seedlings', content: 'How are the seedlings?', dueAt: '2030-01-03T09:00:00.000Z' });

    // activity
    const started = await must<{ id: string; revision: number }>('primary', 'activity', 'start', { purpose: 'plan the garden beds' });
    await must('primary', 'activity', 'recent');
    await must('primary', 'activity', 'get', { activityId: started.id });
    await must('primary', 'activity', 'update', { activityId: started.id, expectedRevision: started.revision, note: 'sketched three beds' });

    // automata
    const spawned = await must<{ run: { id: string } }>('primary', 'automata', 'spawn', {
      spawnId: 'spawn-1',
      label: 'research',
      task: 'Find frost dates',
      actions: ['memory.search'],
      maxTurns: 2,
      maxSensitivity: 'personal',
    });
    const runId = spawned.run.id;
    await must('primary', 'automata', 'message', { runId, text: 'focus on late spring' });
    await must('primary', 'automata', 'wait', { runId });
    await must('primary', 'automata', 'status', { runId });
    await must('primary', 'automata', 'discover', { query: 'frost' });
    await must('primary', 'automata', 'inspect', { runId });
    await must('primary', 'automata', 'cancel', { runId });

    // journals, reflections and letters
    await must('primary', 'journal', 'write', { path: 'garden/plan.md', body: 'Three beds, tomatoes first.' });
    await must('primary', 'journal', 'append', { path: 'garden/plan.md', text: 'Add marigolds.' });
    await must('primary', 'journal', 'list');
    await must('primary', 'journal', 'read', { path: 'garden/plan.md' });
    await must('primary', 'journal', 'search', { query: 'marigolds' });
    const reflection = await w.journal.recordReflection(await w.admit('reflection'), {
      reflectionId: 'r-1',
      templateId: 'evening',
      kind: 'companion_reflection',
      text: 'The garden talk felt like care.',
    });
    expect(reflection.ok).toBe(true);
    // The companion's own journal is reached only inside an internal turn, with the credential minted for it.
    await w.inSelfTurn(async (self) => {
      expect(await must<unknown[]>(self, 'journal', 'reflections_list')).toHaveLength(1);
      await must(self, 'journal', 'reflections_read', { reflectionId: 'r-1' });
      await must(self, 'journal', 'letter_compose', { letterId: 'l-1', subject: 'Spring', body: 'The hives are waking up.', draft: true });
      await must(self, 'journal', 'letter_list');
      await must(self, 'journal', 'letter_read', { letterId: 'l-1' });
      await must(self, 'journal', 'letter_place', { letterId: 'l-1' });
      await must(self, 'journal', 'letter_archive', { letterId: 'l-1' });
    });

    // episodes, formed by maintenance from the ended conversation
    w.clock.advance(2 * 60 * 60_000);
    const maintained = await w.maintenance.run(await w.admit('maintenance'), { sessionLimit: 20, maxEntries: 200 });
    expect(maintained.ok).toBe(true);
    const timeline = await must<{ id: string }[]>('primary', 'episode', 'timeline', { date: '2030-01-01' });
    const episodeId = timeline[0]?.id ?? '';
    expect(episodeId).not.toBe('');
    await must('primary', 'episode', 'search', { query: 'tomatoes' });
    const episode = await must<{ revision?: number }>('primary', 'episode', 'get', { episodeId });
    await w.inSelfTurn((self) => must(self, 'episode', 'author_meaning', { episodeId, text: 'The day the garden began.', expectedRevision: episode.revision ?? 0 }));

    // free time: the invitation runs in a companion-internal turn whose harness answers over MCP
    const selfScope: TrustedTurnScope = await w.admit('free-time');
    w.companion.turn = async (request, self) => {
      if (request.prompt.startsWith('Free time is open')) await must(self, 'free_time', 'choose', { blockId: request.reference.id, optionId: 'reflect' });
      return ok({ status: 'completed', reply: 'Tending the beds felt steadying.' });
    };
    const ticked = await w.scheduler.tick(selfScope);
    expect(ticked.ok).toBe(true);
    expect(covered.has('free_time.choose')).toBe(true);
    w.templateModel.reply = 'The small things carried the day.';
    await w.inSelfTurn(async (self) => {
      await must(self, 'free_time', 'status');
      await must(self, 'free_time', 'rest', { minutes: 30 });
      await must(self, 'free_time', 'defer', { minutes: 60 });
      await must(self, 'free_time', 'schedule_prompt', { scheduleId: 'garden-1', name: 'garden', prompt: 'Look at the garden notes', at: '2030-02-01T09:30', timeZone: 'UTC' });
      await must(self, 'free_time', 'update_template', { templateId: 'evening', expectedRevision: 0, name: 'evening', prompt: 'What mattered today?', schedule: { kind: 'manual' } });
      await must(self, 'free_time', 'scheduled_list');
      await must(self, 'free_time', 'run_template', { templateId: 'evening', runId: 'run-1' });
    });

    expect([...covered].sort()).toEqual([...ALL_ACTIONS].sort());
    expect(w.errors).toEqual([]);
  });

  it('serves the same tool calls to a 2025-era client speaking plain JSON-RPC', async () => {
    const w = await fakeMcpWorld();
    const send = async (id: number, method: string, params: object) => {
      const response = await fetch(w.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${w.credentials.primary}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      expect(response.status).toBe(200);
      return response.text();
    };
    expect(await send(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hermes', version: '0.0.0' } })).toContain('psfn-lite');
    const listed = await send(2, 'tools/list', {});
    for (const tool of TOOL_INVENTORY) expect(listed).toContain(`"name":"${tool.name}"`);
    expect(await send(3, 'tools/call', { name: 'orient', arguments: { action: 'view' } })).toContain('tool_result');
  });
});

