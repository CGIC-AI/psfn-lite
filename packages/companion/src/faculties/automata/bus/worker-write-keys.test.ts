/**
 * Lite (operator automata rule 1): every worker write is exactly-once across
 * attempts via a stable write key. The donor minted `randomUUID()` event ids
 * for the worker's note, append, correct and handoff writes
 * (production-worker-adapter.ts at donor e6a9546), so the same write repeated
 * by a model or by a later attempt of the same task became a second Bus
 * event. These tests drive the real governed `automata_bus` tool over the
 * real production worker port and canonical writer; only the Postgres store
 * and the index are in-memory stand-ins (test-support/in-memory-automata-bus.ts)
 * with the store's own eventId semantics.
 */
import { describe, expect, it } from 'vitest';

import { loadAutomataPolicySeedDefaults } from '../../../system/config/inner-life-config.js';
import { NO_AUTOMATA_REDELIVERY } from '../../../test-support/automata-run-redelivery.js';
import { createInMemoryAutomataBus } from '../../../test-support/in-memory-automata-bus.js';
import { AutomataRunRegistry, InMemoryAutomataRunStore } from '../run-registry.js';
import {
  CanonicalAutomataBusWriter,
  createProductionAutomataBusWorkerAccess,
} from './production-worker-adapter.js';
import { buildAutomataBusWorkerScope } from './worker-access-formation.js';
import { createAutomataBusTool } from './worker-access-tool.js';

const COMPANION = 'companion-a';
const TASK = 'task-research-1';
const BOUNDS = {
  maxQueryChars: 200,
  maxTextChars: 400,
  maxArrayItems: 8,
  maxSearchResults: 10,
  maxRunResults: 20,
  maxBriefingChars: 400,
  maxBriefingItems: 4,
  maxToolResultChars: 4_000,
} as const;

/** Two attempts of one task, as the donor records a retry: a fresh run id, the next worker generation, the first run as its source. */
async function createAttempts() {
  const registry = await AutomataRunRegistry.hydrate({
    redelivery: NO_AUTOMATA_REDELIVERY,
    companionId: COMPANION,
    policy: loadAutomataPolicySeedDefaults(),
    store: new InMemoryAutomataRunStore(),
  });
  for (const [runId, generation] of [['subagent-attempt-1', 1], ['subagent-attempt-2', 2]] as const) {
    await registry.register({
      runId,
      automatonClass: 'subagent.bounded',
      workerId: runId,
      workerGeneration: generation,
      taskId: TASK,
      taskLabel: 'Research',
      taskSummary: 'Research the route',
      ...(generation === 2 ? { sourceRunId: 'subagent-attempt-1' } : {}),
      sessionIds: [`subagent:${runId}`],
    });
    await registry.transition(runId, { status: 'running', reason: 'agent_initialized' });
  }
  return registry;
}

async function createWorld() {
  const bus = createInMemoryAutomataBus();
  const registry = await createAttempts();
  const access = createProductionAutomataBusWorkerAccess({
    companionId: COMPANION,
    registry,
    store: bus.store,
    runtime: bus.runtime,
    writer: new CanonicalAutomataBusWriter({ companionId: COMPANION, store: bus.store, runtime: bus.runtime }),
    bounds: BOUNDS,
  });
  const toolFor = (runId: string, taskId = TASK) => createAutomataBusTool({
    access,
    scope: buildAutomataBusWorkerScope(access, { automatonClass: 'subagent.bounded', runId, taskId }),
  });
  return { ...bus, registry, access, toolFor };
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('');
}

describe('Lite operator automata rule 1: worker writes are exactly-once across attempts', () => {
  it('stores a note repeated by one attempt once, and answers the repeat with the same event', async () => {
    const world = await createWorld();
    const tool = world.toolFor('subagent-attempt-1');
    const first = JSON.parse(textOf(await tool.execute('call-1', { action: 'note', text: 'Route docs live under docs/routes.' })));
    const second = JSON.parse(textOf(await tool.execute('call-2', { action: 'note', text: 'Route docs live under docs/routes.' })));
    expect(world.events.size).toBe(1);
    expect(first.result.inserted).toBe(true);
    expect(second.result.inserted).toBe(false);
    expect(second.result.event.eventId).toBe(first.result.event.eventId);
  });

  it('stores the same note from a later attempt of the task once, keeping the first attempt as its run', async () => {
    const world = await createWorld();
    await world.toolFor('subagent-attempt-1').execute('call-1', { action: 'note', text: 'Route docs live under docs/routes.' });
    const replay = JSON.parse(textOf(await world.toolFor('subagent-attempt-2')
      .execute('call-1', { action: 'note', text: 'Route docs live under docs/routes.' })));
    expect(world.events.size).toBe(1);
    expect(replay.result.inserted).toBe(false);
    const [stored] = [...world.events.values()];
    // The write is the first attempt's: its run context and evidence name attempt 1.
    expect(stored!.event.context.runId).toBe('subagent-attempt-1');
    expect(replay.result.event.context.runId).toBe('subagent-attempt-1');
  });

  it('keeps distinct writes distinct: other text, other action, another task', async () => {
    const world = await createWorld();
    await world.registry.register({
      runId: 'subagent-other-task',
      automatonClass: 'subagent.bounded',
      workerId: 'subagent-other-task',
      taskId: 'task-other',
      taskLabel: 'Other',
      taskSummary: 'Other work',
      sessionIds: ['subagent:subagent-other-task'],
    });
    await world.registry.transition('subagent-other-task', { status: 'running', reason: 'agent_initialized' });
    const tool = world.toolFor('subagent-attempt-1');
    await tool.execute('a', { action: 'note', text: 'Route docs live under docs/routes.' });
    await tool.execute('b', { action: 'note', text: 'The route tests need docker.' });
    await tool.execute('c', {
      action: 'handoff',
      summary: 'Route docs live under docs/routes.',
      output_refs: ['artifact:routes'],
    });
    await world.toolFor('subagent-other-task', 'task-other')
      .execute('d', { action: 'note', text: 'Route docs live under docs/routes.' });
    expect(world.events.size).toBe(4);
  });

  it('stores a repeated handoff and a repeated correction once across attempts', async () => {
    const world = await createWorld();
    const first = world.toolFor('subagent-attempt-1');
    const later = world.toolFor('subagent-attempt-2');
    const note = JSON.parse(textOf(await first.execute('n', { action: 'note', text: 'The cache is warm by default.' })));
    const target = note.result.event.eventId as string;
    const handoff = { action: 'handoff', summary: 'Mapped the routes.', output_refs: ['artifact:routes'], validation_performed: ['read the index'] };
    const correction = { action: 'correct', target_event_id: target, relation: 'retracts', reason: 'The cache starts cold.' };
    for (const tool of [first, later]) {
      expect(textOf(await tool.execute('h', handoff))).not.toContain('failed safely');
      expect(textOf(await tool.execute('c', correction))).not.toContain('failed safely');
    }
    const types = [...world.events.values()].map(entry => entry.event.type).sort();
    expect(types).toEqual(['finding', 'finding', 'relation']);
  });

  it('replays a repeated supersede as the stored relation after its target left the current set', async () => {
    const world = await createWorld();
    const first = world.toolFor('subagent-attempt-1');
    const later = world.toolFor('subagent-attempt-2');
    const note = JSON.parse(textOf(await first.execute('n', { action: 'note', text: 'The cache is warm by default.' })));
    const correction = {
      action: 'correct',
      target_event_id: note.result.event.eventId as string,
      relation: 'supersedes',
      reason: 'The cache starts cold.',
      replacement_claim: 'The cache starts cold after a deploy.',
    };
    const stored = JSON.parse(textOf(await first.execute('c', correction)));
    expect(stored.result.inserted).toBe(true);
    const replayed = JSON.parse(textOf(await later.execute('c', correction)));
    expect(replayed.result.inserted).toBe(false);
    expect(replayed.result.event.eventId).toBe(stored.result.event.eventId);
    expect([...world.events.values()].map(entry => entry.event.type).sort()).toEqual(['finding', 'relation']);
  });

  it('derives the same key from a direct port write without a tool-supplied key', async () => {
    const world = await createWorld();
    const scope = (runId: string) => buildAutomataBusWorkerScope(world.access, {
      automatonClass: 'subagent.bounded',
      runId,
      taskId: TASK,
    });
    const write = {
      claim: 'The index rebuild takes about a minute.',
      provenance: 'computed' as const,
      evidence: [{ kind: 'command' as const, reference: 'cmd:rebuild', summary: 'Timed the rebuild.' }],
      artifactRefs: [],
      verificationStatus: 'pending' as const,
    };
    await world.access.port.append({ scope: scope('subagent-attempt-1'), ...write });
    await world.access.port.append({ scope: scope('subagent-attempt-2'), ...write });
    expect(world.events.size).toBe(1);
  });
});
