// @vitest-environment jsdom
/**
 * The light Garden's Desktop screens in a DOM, against a stubbed plugin
 * context: each screen renders what its route answers, the writes go to the
 * right route with the right body, Settings writes say restart-needed, the
 * transcript directives check their attributes before reading, and the side
 * pane is registered only while the operator keeps it open.
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Garden, RestOptions } from '../../integrations/hermes/desktop/src/api.ts';
import { LayerDiffDirective, MemoryDirective } from '../../integrations/hermes/desktop/src/directives.tsx';
import { lineDiff } from '../../integrations/hermes/desktop/src/diff.ts';
import { gardenContributions, PLUGIN_ID } from '../../integrations/hermes/desktop/src/plugin.tsx';
import { GardenScreen } from '../../integrations/hermes/desktop/src/screens.tsx';
import { navigations } from '../support/hermes-plugin-sdk.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEMORY_ID = '0193f1c2-6fbf-76dc-80e1-57e4ab19b200';

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

type Answer = unknown | ((call: Call) => unknown);

/** A plugin `rest` answering from a table keyed by "METHOD path"; anything else is a 404, as the backend answers it. */
function stubRest(table: Record<string, Answer>) {
  const calls: Call[] = [];
  const rest = <T,>(path: string, options: RestOptions = {}): Promise<T> => {
    const call = { path, method: options.method ?? 'GET', body: options.body };
    calls.push(call);
    const key = `${call.method} ${path}`;
    if (!(key in table)) return Promise.reject(new Error(`404 not a Garden route: ${key}`));
    const answer = table[key];
    try {
      return Promise.resolve((typeof answer === 'function' ? (answer as (c: Call) => unknown)(call) : answer) as T);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const garden: Garden = { rest, navigate: (target) => navigations.push(target) };
  return { calls, garden, writes: () => calls.filter((c) => c.method !== 'GET') };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(element: ReactElement): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  await settle();
  return container;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await act(async () => Promise.resolve());
}

function button(within: HTMLElement, text: string): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  if (found === undefined) throw new Error(`no button "${text}" in: ${within.textContent}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await settle();
}

/** Types into a React-controlled field, as the browser does: the native value setter, then the event React listens to. */
async function type(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

function field<T extends Element>(within: HTMLElement, label: string): T {
  const found = within.querySelector<T>(`[aria-label="${label}"]`);
  if (found === null) throw new Error(`no field "${label}"`);
  return found;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  navigations.length = 0;
});

const memory = { id: MEMORY_ID, text: 'Robin keeps the shed key on the red hook.', type: 'semantic', importance: 0.6, sensitivity: 'personal', extractedAt: 1_762_000_000_000 };
const noDeletions = { pending: [], recoverable: [] };

describe('the Garden screens', () => {
  it('Overview shows the companion, its model and tier, and that a restart is due', async () => {
    const { garden } = stubRest({
      'GET /api/lite/overview': {
        companionId: 'artie', model: { provider: 'deepseek', modelId: 'deepseek-chat' }, tier: { tier: 'apprentice' }, restartRequired: true,
        heartbeat: { tasks: [{ id: 't1', name: 'memory maintenance', state: 'idle', lastOutcome: 'ok' }], reflections: [] },
        openConcerns: [{ id: 'k1', text: 'Water the seedlings', priority: 'normal', status: 'active', createdAt: 'today' }],
        latestSession: null, recentTurns: [{ role: 'user', content: 'hello there', timestamp: 1_762_000_000_000 }],
        focus: [{ focusId: 'f1', channelId: 'cli', scope: 'seed sorting', startedAt: 1 }],
        emotion: { vad: { valence: 0.1, arousal: 0.2, dominance: 0.3 }, mood: { valence: 0, arousal: 0, dominance: 0 }, discrete: { calm: 0.7 }, confidence: 0.5 },
      },
    });
    const page = await render(createElement(GardenScreen, { garden, screen: 'overview' }));
    expect(page.textContent).toContain('deepseek / deepseek-chat');
    expect(page.textContent).toContain('apprentice');
    expect(page.textContent).toContain('memory maintenance');
    expect(page.textContent).toContain('hello there');
    expect(page.textContent).toContain('Water the seedlings');
    expect(page.textContent).toContain('seed sorting');
    expect(page.textContent).toContain('calm 0.70');
    expect(page.querySelector('[role="status"]')?.textContent).toContain('Restart Lite');
  });

  it('navigates between the eight screens through Desktop', async () => {
    const { garden } = stubRest({ 'GET /api/lite/settings': { model: { provider: 'p', modelId: 'm' }, tier: { tier: 'nursery', customTokens: [] }, scheduler: {} } });
    const page = await render(createElement(GardenScreen, { garden, screen: 'settings' }));
    const nav = page.querySelector('nav[aria-label="Garden"]') as HTMLElement;
    expect([...nav.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Overview', 'Memories', 'Persona & prompts', 'People', 'Sessions', 'Inner life', 'Automata', 'Settings']);
    expect(button(nav, 'Settings').getAttribute('aria-current')).toBe('page');
    await click(button(nav, 'Inner life'));
    expect(navigations).toEqual(['/garden-inner-life']);
  });

  it('a failed read says why instead of an empty screen', async () => {
    const { garden } = stubRest({});
    const page = await render(createElement(GardenScreen, { garden, screen: 'people' }));
    expect([...page.querySelectorAll('[role="alert"]')].map((a) => a.textContent)).toContain('404 not a Garden route: GET /api/admin/contacts');
  });

  it('Memories deletes with a reason and undoes it with the delete checkpoint', async () => {
    let deleted = false;
    const { garden, writes } = stubRest({
      'GET /api/admin/memory': () => ({ memories: deleted ? [] : [memory], withheldBySubjectAuthorizationCount: 0, pagination: { total: deleted ? 0 : 1 } }),
      'GET /api/lite/memory-deletions': noDeletions,
      [`POST /api/lite/memories/${MEMORY_ID}/delete`]: () => {
        deleted = true;
        return { memoryId: MEMORY_ID, deleteId: 'del-1', deletedAt: 1 };
      },
      'POST /api/lite/memories/restore': () => {
        deleted = false;
        return { memoryId: MEMORY_ID, deleteId: 'del-1', restoredAt: 2 };
      },
    });
    const page = await render(createElement(GardenScreen, { garden, screen: 'memories' }));
    expect(page.textContent).toContain('Robin keeps the shed key');
    await click(button(page, 'Delete…'));
    await type(field<HTMLInputElement>(page, 'Reason'), 'moved');
    await click(button(page, 'Delete'));
    expect(page.textContent).not.toContain('Robin keeps the shed key');
    await click(button(page, 'Undo'));
    expect(page.textContent).toContain('Robin keeps the shed key');
    expect(writes()).toEqual([
      { path: `/api/lite/memories/${MEMORY_ID}/delete`, method: 'POST', body: { reason: 'moved' } },
      { path: '/api/lite/memories/restore', method: 'POST', body: { deleteId: 'del-1' } },
    ]);
  });

  it('Memories searches through the donor search route', async () => {
    const { garden, calls } = stubRest({
      'GET /api/admin/memory': { memories: [], pagination: { total: 0 } },
      'GET /api/lite/memory-deletions': noDeletions,
      'GET /api/admin/memory/search?q=shed%20key': { results: [memory] },
    });
    const page = await render(createElement(GardenScreen, { garden, screen: 'memories' }));
    await type(field<HTMLInputElement>(page, 'Search memories'), 'shed key');
    await click(button(page, 'Search'));
    expect(calls.map((c) => c.path)).toContain('/api/admin/memory/search?q=shed%20key');
    expect(page.textContent).toContain('Matching “shed key”');
    expect(page.textContent).toContain('Robin keeps the shed key');
  });

  it('Memories shows a memory’s detail and redacts it with a reason', async () => {
    let text = memory.text;
    const { garden, writes } = stubRest({
      'GET /api/admin/memory': () => ({ memories: [{ ...memory, text }], pagination: { total: 1 } }),
      'GET /api/lite/memory-deletions': noDeletions,
      [`GET /api/admin/memory/${MEMORY_ID}`]: { memory: { ...memory, sourceType: 'tool', provenance: { toolName: 'memory' }, tags: ['home'] } },
      [`PATCH /api/admin/memory/${MEMORY_ID}/patch`]: (call: Call) => {
        text = (call.body as { text: string }).text;
        return { ok: true };
      },
    });
    const page = await render(createElement(GardenScreen, { garden, screen: 'memories' }));
    await click(button(page, 'Details'));
    expect(page.textContent).toContain('home');
    await click(button(page, 'Redact…'));
    expect(button(page, 'Save redaction').disabled).toBe(true);
    await type(field<HTMLTextAreaElement>(page, 'Redacted text'), 'Robin keeps a key somewhere.');
    await type(field<HTMLInputElement>(page, 'Reason'), 'too specific');
    await click(button(page, 'Save redaction'));
    expect(page.textContent).toContain('Robin keeps a key somewhere.');
    expect(writes()).toEqual([{ path: `/api/admin/memory/${MEMORY_ID}/patch`, method: 'PATCH', body: { text: 'Robin keeps a key somewhere.', reason: 'too specific' } }]);
  });

  it('a deletion the Hermes turn is still deciding offers no decision; another is approved or kept', async () => {
    const proposal = (id: string, awaitingHostTurn: boolean) => ({ id, memoryId: MEMORY_ID, justificationCategory: 'factually_incorrect', explanation: `proposal ${id}`, status: 'pending', proposedAt: 1, awaitingHostTurn });
    const { garden, writes } = stubRest({
      'GET /api/admin/memory': { memories: [], pagination: { total: 0 } },
      'GET /api/lite/memory-deletions': { pending: [proposal('p-open', true), proposal('p-idle', false)], recoverable: [] },
      'POST /api/lite/memory-deletions/p-idle/reject': { proposalId: 'p-idle', status: 'denied' },
    });
    const page = await render(createElement(GardenScreen, { garden, screen: 'memories' }));
    const open = page.querySelector('[aria-label="proposal p-open"]') as HTMLElement;
    expect(open.textContent).toContain('still deciding');
    expect(open.querySelectorAll('button')).toHaveLength(0);
    await click(button(page.querySelector('[aria-label="proposal p-idle"]') as HTMLElement, 'Keep the memory'));
    expect(writes()).toEqual([{ path: '/api/lite/memory-deletions/p-idle/reject', method: 'POST', body: undefined }]);
  });

  it('Persona edits a card field and a prompt layer, and shows a layer’s last change', async () => {
    const { garden, writes } = stubRest({
      'GET /api/admin/identity': { card: { data: { name: 'Artie', description: 'A gardener.', personality: '', scenario: '', first_mes: '', mes_example: '' } }, version: 3, history: [{ version: 2, timestamp: 'yesterday', updatedBy: 'operator' }] },
      'GET /api/admin/prompts/constitution': { companionLayer: { title: 'Companion-Derived Values Layer', content: 'Tend what grows.' } },
      'GET /api/admin/prompts/north-star': { items: [{ id: 'n1', title: 'Grow food', content: 'Keep the garden alive.', enabled: true, scope: 'companion' }], preview: { text: '' } },
      'GET /api/admin/prompts/layer-a': { layer: {}, layerHistory: [{ version: 1, timestamp: 'monday', updatedBy: 'operator', reason: 'first' }] },
      'POST /api/admin/prompts/layer-a/rollback': { ok: true },
      'POST /api/admin/identity/rollback': { ok: true },
      'GET /api/admin/prompts': { canWriteOperatorLayers: true, layers: [{ id: 'layer-a', type: 'operator', name: 'Voice', identifier: 'voice', enabled: true, version: 2, updatedAt: 'today', content: 'Speak plainly.' }] },
      'PATCH /api/admin/identity/fields': { ok: true },
      'PATCH /api/admin/prompts/layer-a': { ok: true },
      'GET /api/admin/prompts/layer-a/diff': { oldContent: 'Speak softly.\nBe kind.', newContent: 'Speak plainly.\nBe kind.' },
    });
    const page = await render(createElement(GardenScreen, { garden, screen: 'persona' }));
    const scenario = page.querySelector('[aria-label="card scenario"]') as HTMLElement;
    await click(button(scenario, 'Edit'));
    await type(field<HTMLTextAreaElement>(page, 'scenario'), 'A quiet garden.');
    await click(button(scenario, 'Save'));
    const layer = page.querySelector('[aria-label="layer layer-a"]') as HTMLElement;
    await click(button(layer, 'Edit'));
    await type(field<HTMLTextAreaElement>(page, 'Voice content'), 'Speak warmly.');
    await click(button(layer, 'Save'));
    await click(button(layer, 'Last change'));
    const lines = [...layer.querySelectorAll('[data-diff]')].map((l) => `${l.getAttribute('data-diff') ?? ''}:${l.textContent.slice(2)}`);
    expect(lines).toEqual(['removed:Speak softly.', 'added:Speak plainly.', 'same:Be kind.']);
    await click(button(layer, 'History'));
    await click(button(layer, 'Roll back to v1'));
    await click(button(page, 'Roll back to v2'));
    expect(page.textContent).toContain('Tend what grows.');
    expect(page.textContent).toContain('Keep the garden alive.');
    expect(writes()).toEqual([
      { path: '/api/admin/identity/fields', method: 'PATCH', body: { field: 'scenario', value: 'A quiet garden.' } },
      { path: '/api/admin/prompts/layer-a', method: 'PATCH', body: { content: 'Speak warmly.' } },
      { path: '/api/admin/prompts/layer-a/rollback', method: 'POST', body: { version: 1 } },
      { path: '/api/admin/identity/rollback', method: 'POST', body: { version: 2 } },
    ]);
  });

  it('an operator layer offers no edit to a principal that may not write it', async () => {
    const { garden } = stubRest({
      'GET /api/admin/identity': { card: { data: { name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '' } }, version: 1, history: [] },
      'GET /api/admin/prompts': { canWriteOperatorLayers: false, layers: [
        { id: 'op', type: 'operator', name: 'Operator', identifier: 'op', enabled: true, version: 1, updatedAt: 'x', content: 'x' },
        { id: 'rt', type: 'runtime', name: 'Runtime', identifier: 'rt', enabled: true, version: 1, updatedAt: 'x', content: 'x' },
      ] },
    });
    const page = await render(createElement(GardenScreen, { garden, screen: 'persona' }));
    const labels = (id: string) => [...(page.querySelector(`[aria-label="layer ${id}"]`) as HTMLElement).querySelectorAll('button')].map((b) => b.textContent);
    expect(labels('op')).toEqual(['Last change', 'History']);
    expect(labels('rt')).toEqual(['Edit', 'Last change', 'History']);
  });

  it('Sessions opens one conversation and a turn’s prompt, memories and tools', async () => {
    const record = { turnId: 't-1', startedAt: 5, status: 'completed', userMessage: { content: 'how is the basil?' }, toolCalls: [{ toolName: 'memory', outcome: 'success' }], extractedMemoryIds: ['m1'], versionPointers: { model: 'deepseek-chat', promptHash: 'abc123' } };
    const { garden } = stubRest({
      'GET /api/admin/sessions': { channels: [{ sessionId: 's-1', channelId: 'cli:operator', messageCount: 2, lastActivityAt: 1 }] },
      'GET /api/admin/sessions/cli%3Aoperator?limit=50': { messages: [{ role: 'assistant', content: 'The basil is thriving.', timestamp: 1 }], turns: [{ record, retrievals: [] }] },
      'GET /api/admin/sessions/cli%3Aoperator/turns/t-1': { turn: { record, retrievals: [{ count: 2, retrievalSource: 'embedding' }] } },
    });
    const page = await render(createElement(GardenScreen, { garden, screen: 'sessions' }));
    await click(button(page, 'cli:operator'));
    expect(page.textContent).toContain('The basil is thriving.');
    expect(page.textContent).toContain('how is the basil?');
    const turn = page.querySelector('[aria-label="turn t-1"]') as HTMLElement;
    await click(turn.querySelector('button') as HTMLButtonElement);
    expect(turn.textContent).toContain('deepseek-chat · abc123');
    expect(turn.textContent).toContain('2 (embedding)');
    expect(turn.textContent).toContain('memory (success)');
  });

  it('People, Inner life and Automata show what their routes answer and make their writes', async () => {
    const { garden, writes } = stubRest({
      'GET /api/admin/contacts': { contacts: [{ id: 'c1', displayName: 'Robin', trustLevel: 'primary', relationshipType: 'operator', lastSeen: 'today' }] },
      'GET /api/admin/biographical-claims': { claims: [{ id: 'b1', kind: 'preference', status: 'candidate' }] },
      'GET /api/admin/graph-proposals': { proposals: [{ id: 'g1', sourceDisplayName: 'Robin', targetDisplayName: 'Sam', relationshipType: 'friend', status: 'pending', rationale: 'They garden together.' }] },
      'POST /api/admin/graph-proposals/g1/approve': { ok: true },
      'POST /api/admin/concerns/k1/resolve': { ok: true },
      'POST /api/admin/concerns/k1/transition': { ok: true },
      'GET /api/admin/scheduler': { tasks: [{ id: 't1', name: 'memory maintenance', state: 'idle', intervalMs: 600_000, lastRunAt: 1 }], reflections: [{ id: 'r1', name: 'evening reflection', enabled: true, mode: 'solo' }] },
      'GET /api/admin/automata?limit=20&busLimit=20&busRunId=r1': {
        classes: [], coverage: null, runs: [{ runId: 'r1', automatonClass: 'memory_extraction', status: 'completed' }],
        bus: { available: true, health: { condition: 'healthy', freshness: 'fresh' }, events: [{ eventId: 'e9', type: 'finding', sequence: 9, occurredAt: 'now' }] },
      },
      'GET /api/lite/inner-life': {
        focus: [{ focusId: 'f1', channelId: 'cli', scope: 'seed sorting', startedAt: 1 }],
        emotion: { vad: { valence: 0.1, arousal: 0.2, dominance: 0.3 }, mood: { valence: 0, arousal: 0, dominance: 0 }, discrete: { neutral: 1 }, confidence: 0.5 },
        introspectionConsent: { status: 'default', enabled: false },
        wakeWindow: { timingMode: 'fixed', source: 'config', timeZone: 'UTC', effective: { localTime: '07:30' } },
      },
      'GET /api/admin/concerns': { concerns: [{ id: 'k1', text: 'Water the seedlings', priority: 'normal', status: 'active', createdAt: 'today' }] },
      'GET /api/admin/automata?limit=20&busLimit=20': {
        classes: [{ id: 'memory_extraction', workerKind: 'llm', trigger: 'turn', busEligibility: 'eligible' }],
        coverage: { available: true, classes: [{ automatonClass: 'memory_extraction', health: 'healthy', runs: { total: 3, active: 0, failed: 0 } }] },
        runs: [{ runId: 'r1', automatonClass: 'memory_extraction', status: 'completed' }],
        bus: { available: true, health: { condition: 'healthy', freshness: 'fresh' }, events: [] },
      },
    });
    const people = await render(createElement(GardenScreen, { garden, screen: 'people' }));
    expect(people.textContent).toContain('Robin');
    expect(people.textContent).toContain('preference');
    await click(button(people, 'Approve'));
    act(() => root?.render(createElement(GardenScreen, { garden, screen: 'inner-life' })));
    await settle();
    expect(people.textContent).toContain('seed sorting');
    expect(people.textContent).toContain('07:30 UTC');
    expect(people.textContent).toContain('Water the seedlings');
    expect(people.textContent).toContain('every 10 min');
    expect(people.textContent).toContain('evening reflection');
    const concern = people.querySelector('[aria-label="concern k1"]') as HTMLElement;
    await click(button(concern, 'Resolve'));
    await type(field<HTMLSelectElement>(concern, 'status of k1'), 'watching');
    await click(button(concern, 'Move'));
    act(() => root?.render(createElement(GardenScreen, { garden, screen: 'automata' })));
    await settle();
    expect(people.textContent).toContain('healthy, 3 runs');
    expect(people.textContent).toContain('No bus events.');
    await click(button(people, 'Inspect'));
    expect(people.textContent).toContain('Bus events of run r1');
    expect(people.textContent).toContain('#9 finding');
    expect(writes()).toEqual([
      { path: '/api/admin/graph-proposals/g1/approve', method: 'POST', body: {} },
      { path: '/api/admin/concerns/k1/resolve', method: 'POST', body: {} },
      { path: '/api/admin/concerns/k1/transition', method: 'POST', body: { status: 'watching' } },
    ]);
  });

  it('Settings saves the tier and the scheduler and says a restart applies them; invalid JSON is not sent', async () => {
    const scheduler = { tickIntervalMs: 1000 };
    const { garden, writes } = stubRest({
      'GET /api/lite/settings': { model: { provider: 'deepseek', modelId: 'deepseek-chat' }, tier: { tier: 'nursery', customTokens: [] }, scheduler },
      'PUT /api/lite/settings/tier': { restartRequired: true },
      'PUT /api/lite/settings/scheduler': { restartRequired: true },
    });
    const page = await render(createElement(GardenScreen, { garden, screen: 'settings' }));
    await type(field<HTMLSelectElement>(page, 'Capability tier'), 'apprentice');
    await click(button(page, 'Save tier'));
    expect(page.querySelector('[role="status"]')?.textContent).toContain('Restart Lite');
    await type(field<HTMLTextAreaElement>(page, 'Scheduler settings'), '{ not json');
    await click(button(page, 'Save scheduler'));
    expect(page.querySelector('[role="alert"]')?.textContent).toContain('not valid JSON');
    await type(field<HTMLTextAreaElement>(page, 'Scheduler settings'), '{"tickIntervalMs": 2000}');
    await click(button(page, 'Save scheduler'));
    expect(writes()).toEqual([
      { path: '/api/lite/settings/tier', method: 'PUT', body: { tier: 'apprentice', customTokens: [] } },
      { path: '/api/lite/settings/scheduler', method: 'PUT', body: { tickIntervalMs: 2000 } },
    ]);
  });
});

describe('the transcript directives', () => {
  it('a memory card reads only a valid memory id', async () => {
    const { garden, calls } = stubRest({ [`GET /api/admin/memory/${MEMORY_ID}`]: { memory } });
    const card = await render(createElement(MemoryDirective, { rest: garden.rest, attrs: { id: MEMORY_ID } }));
    expect(card.textContent).toContain('Robin keeps the shed key');
    act(() => root?.render(createElement(MemoryDirective, { rest: garden.rest, attrs: { id: '../../api/lite/settings' } })));
    await settle();
    expect(card.textContent).toContain('without a valid memory id');
    expect(calls.map((c) => c.path)).toEqual([`/api/admin/memory/${MEMORY_ID}`]);
  });

  it('a layer diff reads only a valid layer id, and says when there is no change to show', async () => {
    const { garden, calls } = stubRest({});
    const view = await render(createElement(LayerDiffDirective, { rest: garden.rest, attrs: { layer: 'voice/../x' } }));
    expect(view.textContent).toContain('without a valid layer id');
    expect(calls).toEqual([]);
    act(() => root?.render(createElement(LayerDiffDirective, { rest: garden.rest, attrs: { layer: 'voice' } })));
    await settle();
    expect(view.textContent).toContain('No change to show');
  });

  it('the line diff keeps shared lines and marks the rest', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'removed', text: 'b' }, { kind: 'same', text: 'c' }, { kind: 'added', text: 'd' },
    ]);
    expect(lineDiff('', 'x')).toEqual([{ kind: 'added', text: 'x' }]);
  });
});

describe('the side pane', () => {
  it('is registered only while the operator keeps it open, and the choice is remembered', async () => {
    const stored = new Map<string, unknown>();
    const panes: string[] = [];
    const ctx = {
      source: `plugin:${PLUGIN_ID}`,
      register: (c: { id: string; area: string }) => {
        if (c.area === 'panes') panes.push(c.id);
        return () => {
          panes.splice(panes.indexOf(c.id), 1);
        };
      },
      registerMany: () => () => undefined,
      onDispose: () => undefined,
      rest: stubRest({ 'GET /api/admin/memory': { memories: [], pagination: { total: 0 } }, 'GET /api/lite/memory-deletions': noDeletions }).garden.rest,
      storage: { get: <T,>(key: string, fallback: T): T => (stored.has(key) ? (stored.get(key) as T) : fallback), set: (key: string, value: unknown) => void stored.set(key, value) },
    };
    const contributions = gardenContributions(ctx);
    expect(panes).toEqual([]);
    const memories = contributions.find((c) => c.id === 'route-memories');
    const page = await render(memories?.render?.() as ReactElement);
    await click(button(page, 'Show beside the chat'));
    expect(panes).toEqual(['deletions']);
    expect(stored.get('deletionsPane')).toBe(true);
    await click(button(page, 'Hide the side pane'));
    expect(panes).toEqual([]);
    expect(stored.get('deletionsPane')).toBe(false);
    // A remembered open pane comes back when the plugin loads again.
    stored.set('deletionsPane', true);
    gardenContributions(ctx);
    expect(panes).toEqual(['deletions']);
  });
});
