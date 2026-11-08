/**
 * Endings the harness must still record when something around the turn
 * fails: a settlement write that fails after the reply went out, a turn this
 * harness left open, a throwing delivery port, and shutdown reaching turns
 * still preparing and workers running inside a turn. A turn is never run
 * twice, and no ending is dropped.
 */
import { describe, expect, it } from 'vitest';
import { unavailable, type Result, type SessionId, type TurnOutcome, type TurnRecord } from '../../packages/core/src/index.ts';
import { effectKey } from '../../packages/pi/src/index.ts';
import { id } from '../core/fakes.ts';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { callTool, say, withDefaults } from './faux-brain.ts';
import { history, piWorld } from './pi-world.ts';

type World = Awaited<ReturnType<typeof piWorld>>;
type SettleInput = Parameters<World['ledger']['settle']>[0];

const outcomeOf = (report: { record: { settlement: { outcome: TurnOutcome } | null } }) => report.record.settlement?.outcome;

/** Makes the ledger's settle write fail with `unavailable` while `failing()` says so. */
function breakSettlement(w: World, failing: () => boolean): { readonly attempts: () => number } {
  const ledger = w.ledger as { settle: (input: SettleInput) => Promise<Result<TurnRecord>> };
  const settle = ledger.settle.bind(ledger);
  let attempts = 0;
  ledger.settle = (input) => {
    if (!failing()) return settle(input);
    attempts += 1;
    return Promise.resolve(unavailable('postgres', 'connection reset'));
  };
  return { attempts: () => attempts };
}

const callToolWithId = (toolCallId: string, tool: string, action: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(tool, { action, args }, { id: toolCallId })], { stopReason: 'toolUse' });

const companionCalls = (w: World) => w.model.calls.filter((c) => c.kind === 'companion').length;

describe('recording a turn when storage fails', () => {
  it('retries a transient settlement failure, so the reply is delivered once and recorded', async () => {
    const w = await piWorld(withDefaults(() => say('reply')));
    let failures = 1;
    breakSettlement(w, () => failures-- > 0);
    const report = await w.harness.converse({ evidence: 'primary-dm', text: 'one', idempotencyKey: 'k-1' });
    expect(report.ok && report.value).toMatchObject({ status: 'completed', reply: 'reply', delivery: 'delivered' });
    expect(w.delivered.map((d) => d.reply)).toEqual(['reply']);
    expect(w.harness.unsettledTurns()).toEqual([]);
  });

  it('holds an outcome it could not record, and a same-key retry records it without running the turn again', async () => {
    const w = await piWorld(withDefaults(() => say('reply')));
    let broken = true;
    const settlement = breakSettlement(w, () => broken);
    const first = await w.harness.converse({ evidence: 'primary-dm', text: 'one', idempotencyKey: 'k-1' });
    expect(first.ok || first.error).toMatchObject({ kind: 'unavailable', capability: 'postgres' });
    expect(settlement.attempts()).toBeGreaterThan(1);
    expect(w.delivered.map((d) => d.reply)).toEqual(['reply']);
    expect(w.harness.unsettledTurns()).toHaveLength(1);

    broken = false;
    const retry = await w.harness.converse({ evidence: 'primary-dm', text: 'one', idempotencyKey: 'k-1' });
    if (!retry.ok) throw new Error(JSON.stringify(retry.error));
    expect(retry.value).toMatchObject({ status: 'completed', reply: 'reply', delivery: 'delivered', usage: null });
    expect(retry.value.postTurn?.emotion.ok).toBe(true);
    expect(w.delivered.map((d) => d.reply)).toEqual(['reply']);
    expect(companionCalls(w)).toBe(1);
    expect(w.harness.unsettledTurns()).toEqual([]);
    expect(await history(w, retry.value.record.sessionId)).toEqual([
      { origin: 'participant_speech', text: 'one' },
      { origin: 'companion_speech', text: 'reply' },
    ]);
    const replayed = await w.harness.converse({ evidence: 'primary-dm', text: 'one', idempotencyKey: 'k-1' });
    expect(replayed.ok && replayed.value.status).toBe('replayed');
  });

  it('records held outcomes when the host asks before closing, and reports the ones storage still refuses', async () => {
    const w = await piWorld(withDefaults(() => say('reply')));
    let broken = true;
    breakSettlement(w, () => broken);
    expect((await w.harness.converse({ evidence: 'primary-dm', text: 'one', idempotencyKey: 'k-1' })).ok).toBe(false);
    const stillHeld = await w.harness.settleHeld();
    expect(stillHeld).toHaveLength(1);

    broken = false;
    expect(await w.harness.settleHeld()).toEqual([]);
    const scope = await w.admit('primary-dm');
    const session = await w.sessions.current(scope);
    if (!session.ok) throw new Error('session');
    expect((await history(w, session.value.sessionId as SessionId)).map((e) => e.text)).toEqual(['one', 'reply']);
  });

  it('records a held outcome before the next turn of the session, so one failure does not end the conversation', async () => {
    const w = await piWorld(withDefaults((call) => say(call.lastUser.endsWith('two') ? 'second' : 'first')));
    let broken = true;
    breakSettlement(w, () => broken);
    const first = await w.harness.converse({ evidence: 'primary-dm', text: 'one', idempotencyKey: 'k-1' });
    expect(first.ok).toBe(false);

    broken = false;
    const next = await w.harness.converse({ evidence: 'primary-dm', text: 'two', idempotencyKey: 'k-2' });
    if (!next.ok) throw new Error(JSON.stringify(next.error));
    expect(next.value).toMatchObject({ status: 'completed', reply: 'second' });
    expect(w.harness.unsettledTurns()).toEqual([]);
    expect(await history(w, next.value.record.sessionId)).toEqual([
      { origin: 'participant_speech', text: 'one' },
      { origin: 'companion_speech', text: 'first' },
      { origin: 'participant_speech', text: 'two' },
      { origin: 'companion_speech', text: 'second' },
    ]);
  });

  it('records an open turn of its own that is not running as interrupted by the host, delivery unknown, and never runs it', async () => {
    const w = await piWorld(withDefaults(() => say('fresh')));
    const scope = await w.admit('primary-dm');
    const session = await w.sessions.current(scope);
    if (!session.ok) throw new Error('session');
    // A turn this owner opened and then lost track of (a throw between prepare and settle, for example).
    const lost = await w.lifecycle.prepareTurn(scope, {
      sessionId: session.value.sessionId,
      owner: w.owner,
      idempotencyKey: id('lost-1'),
      expectedRevision: 0,
      trigger: { kind: 'participant_message', text: 'lost' },
    });
    expect(lost.ok).toBe(true);

    const again = await w.harness.converse({ evidence: 'primary-dm', text: 'lost', idempotencyKey: 'lost-1' });
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    expect(again.value.status).toBe('interrupted');
    expect(outcomeOf(again.value)).toEqual({ kind: 'interrupted', by: 'host', partialReply: null, delivery: 'unknown' });
    expect(companionCalls(w)).toBe(0);
    expect(w.delivered).toEqual([]);

    const next = await w.harness.converse({ evidence: 'primary-dm', text: 'hello', idempotencyKey: 'k-2' });
    expect(next.ok && next.value.status).toBe('completed');
    expect(await history(w, session.value.sessionId as SessionId)).toEqual([
      { origin: 'participant_speech', text: 'lost' },
      { origin: 'system_note', text: 'turn interrupted by host' },
      { origin: 'participant_speech', text: 'hello' },
      { origin: 'companion_speech', text: 'fresh' },
    ]);
  });

  it('settles the open turn of a different request the same way before preparing a new one', async () => {
    const w = await piWorld(withDefaults(() => say('fresh')));
    const scope = await w.admit('primary-dm');
    const session = await w.sessions.current(scope);
    if (!session.ok) throw new Error('session');
    await w.lifecycle.prepareTurn(scope, {
      sessionId: session.value.sessionId,
      owner: w.owner,
      idempotencyKey: id('lost-1'),
      expectedRevision: 0,
      trigger: { kind: 'participant_message', text: 'lost' },
    });
    const next = await w.harness.converse({ evidence: 'primary-dm', text: 'hello', idempotencyKey: 'k-2' });
    expect(next.ok && next.value.status).toBe('completed');
    expect((await history(w, session.value.sessionId as SessionId)).map((e) => e.text)).toEqual(['lost', 'turn interrupted by host', 'hello', 'fresh']);
  });

  it('records a reply whose delivery port threw as delivery unknown', async () => {
    const w = await piWorld(withDefaults(() => say('reply')), { deliver: () => Promise.reject(new Error('socket closed')) });
    const report = await w.harness.converse({ evidence: 'primary-dm', text: 'one', idempotencyKey: 'k-1' });
    if (!report.ok) throw new Error(JSON.stringify(report.error));
    expect(outcomeOf(report.value)).toEqual({ kind: 'completed', reply: 'reply', delivery: 'unknown' });
    expect(w.harness.activeTurns()).toBe(0);
  });
});

describe('shutdown', () => {
  it('refuses new turns, and records a turn still preparing as interrupted by shutdown without calling the model', async () => {
    const w = await piWorld(withDefaults(() => say('should not run')));
    // Hold prepare at its first ledger read until shutdown has begun.
    const ledger = w.ledger as { head: World['ledger']['head'] };
    const head = ledger.head.bind(ledger);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const preparing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let first = true;
    ledger.head = async (sessionId) => {
      if (first) {
        first = false;
        reached();
        await held;
      }
      return head(sessionId);
    };
    const turn = w.harness.converse({ evidence: 'primary-dm', text: 'hi', idempotencyKey: 'k-1' });
    await preparing;
    expect(w.harness.shutdown()).toBe(1);
    release();
    const report = await turn;
    if (!report.ok) throw new Error(JSON.stringify(report.error));
    expect(outcomeOf(report.value)).toEqual({ kind: 'interrupted', by: 'shutdown', partialReply: null, delivery: 'not_attempted' });
    expect(w.model.calls).toEqual([]);
    expect((await history(w, report.value.record.sessionId)).map((e) => e.text)).toEqual(['hi', 'turn interrupted by shutdown']);

    const late = await w.harness.converse({ evidence: 'primary-dm', text: 'too late', idempotencyKey: 'k-2' });
    expect(late.ok || late.error).toMatchObject({ kind: 'unavailable', capability: 'companion_harness' });
  });

  it('cancels a worker running inside the interrupted turn, recorded as host_shutdown, and refuses new attempts', async () => {
    let started: () => void = () => undefined;
    const working = new Promise<void>((resolve) => {
      started = resolve;
    });
    const full = 'worker summary that streams slowly '.repeat(400).trim();
    const w = await piWorld(
      withDefaults((call) => {
        if (call.kind === 'worker') {
          started();
          return say(full);
        }
        if (call.afterTool) return say('spawned');
        return callTool('automata', 'spawn', { spawnId: 'slow-1', label: 'slow', task: 'Slow task', actions: ['memory.search'], maxTurns: 3, maxSensitivity: 'personal' });
      }),
      { tokensPerSecond: 2_000 },
    );
    const turn = w.harness.converse({ evidence: 'primary-dm', text: 'go', idempotencyKey: 'k-1' });
    await working;
    expect(w.harness.shutdown()).toBe(1);
    expect(w.workerHost.shutdown()).toBe(1);
    const report = await turn;
    expect(report.ok && outcomeOf(report.value)).toMatchObject({ kind: 'interrupted', by: 'shutdown' });
    const [run] = [...w.activity.workerRuns.runs.values()];
    expect(run).toMatchObject({ outcome: 'cancelled', reason: 'host_shutdown' });
    expect(run?.result?.summary).not.toBe(full);
    expect(w.workerHost.running()).toEqual([]);
  });
});

describe('worker effect keys', () => {
  it('records a worker write whose provider tool-call id holds characters core refuses in a key', async () => {
    const w = await piWorld(
      withDefaults((call) => {
        if (call.kind === 'worker') {
          return call.afterTool
            ? say('Saved.')
            : callToolWithId('call_abc|fc_123', 'memory', 'write', { writeId: 'w-1', kind: 'fact', content: 'Robin likes tea.', sensitivity: 'personal' });
        }
        if (call.afterTool) return say('A worker is saving it.');
        return callTool('automata', 'spawn', { spawnId: 'save-1', label: 'save', task: 'Save that Robin likes tea', actions: ['memory.write'], maxTurns: 3, maxSensitivity: 'personal' });
      }),
    );
    const report = await w.harness.converse({ evidence: 'primary-dm', text: 'remember tea', idempotencyKey: 'k-1' });
    expect(report.ok && report.value.status).toBe('completed');
    const afterWrite = w.model.calls.find((c) => c.kind === 'worker' && c.afterTool);
    expect(afterWrite?.toolResults[0]).not.toMatch(/refused|invalid/i);
    const [run] = [...w.activity.workerRuns.runs.values()];
    expect(run).toMatchObject({ outcome: 'completed' });
    const scope = await w.admit('primary-dm');
    const found = await w.must<{ memories: { content: string }[] }>(scope, 'memory', 'search', { query: 'Robin tea' });
    expect(found.memories.map((m) => m.content)).toEqual(['Robin likes tea.']);
  });

  it('derives the key from a digest of the call id: stable per call, distinct per call, inside core\'s alphabet', () => {
    const key = effectKey(2, 'call_abc|fc_123');
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/);
    expect(effectKey(2, 'call_abc|fc_123')).toBe(key);
    expect(effectKey(2, 'call_abc|fc_124')).not.toBe(key);
    expect(effectKey(3, 'call_abc|fc_123')).not.toBe(key);
  });
});

