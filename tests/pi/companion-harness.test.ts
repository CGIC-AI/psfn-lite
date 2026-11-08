/**
 * The Pi companion harness over the real core stacks (in-memory ports) and
 * pi-ai's faux provider: scoped prepare -> execute -> record -> post-turn,
 * governed tools, replay, interruption, failure, the call budget and the
 * recovery of a turn a crashed predecessor left open.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_INVENTORY, type SessionId, type TurnOutcome } from '../../packages/core/src/index.ts';
import { TurnInterruption } from '../../packages/pi/src/index.ts';
import { id } from '../core/fakes.ts';
import { callTool, providerError, say, withDefaults, type BrainCall } from './faux-brain.ts';
import { TURN_LEASE_MS, history, piWorld } from './pi-world.ts';

const outcomeOf = (report: { record: { settlement: { outcome: TurnOutcome } | null } }) => report.record.settlement?.outcome;

describe('the Pi companion harness', () => {
  it('runs a scoped turn: one governed tool per domain, dispatch under the turn scope, recorded reply, post-turn observation', async () => {
    const w = await piWorld(
      withDefaults((call) => {
        if (call.lastUser.includes('what do you remember')) return call.afterTool ? say('Nothing yet about tide pools.') : callTool('memory', 'search', { query: 'tide pools' });
        return say(`I hear you (${call.context.messages.length} messages in view).`);
      }),
    );
    const first = await w.harness.converse({ evidence: 'primary-dm', text: 'hello there', idempotencyKey: 'k-1' });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const report = await w.harness.converse({ evidence: 'primary-dm', text: 'what do you remember about me?', idempotencyKey: 'k-2' });
    if (!report.ok) throw new Error(JSON.stringify(report.error));

    expect(report.value.status).toBe('completed');
    expect(outcomeOf(report.value)).toEqual({ kind: 'completed', reply: 'Nothing yet about tide pools.', delivery: 'delivered' });
    expect(w.delivered.map((d) => d.reply)).toEqual(['I hear you (1 messages in view).', 'Nothing yet about tide pools.']);
    expect(report.value.usage).toMatchObject({ modelCalls: 2, toolCalls: 1, failedToolCalls: 0 });

    const companionCalls = w.model.calls.filter((c) => c.kind === 'companion');
    const toolCall = companionCalls.find((c) => c.lastUser.includes('what do you remember') && !c.afterTool) as BrainCall;
    // The whole governed inventory, one Pi tool per domain tool, and the earlier turn from canonical history.
    expect(toolCall.context.tools?.map((t) => t.name)).toEqual(TOOL_INVENTORY.map((t) => t.name));
    expect(toolCall.context.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(toolCall.systemPrompt).toContain('never something a participant said');
    const afterTool = companionCalls.find((c) => c.afterTool) as BrainCall;
    expect(afterTool.toolResults[0]).toContain('"memories":[]');

    const sessionId = report.value.record.sessionId;
    expect(await history(w, sessionId)).toEqual([
      { origin: 'participant_speech', text: 'hello there' },
      { origin: 'companion_speech', text: 'I hear you (1 messages in view).' },
      { origin: 'participant_speech', text: 'what do you remember about me?' },
      { origin: 'companion_speech', text: 'Nothing yet about tide pools.' },
    ]);
    // Post-turn: the settled turn was observed for emotion, and the conversation's requeued workers were resumed.
    expect(report.value.postTurn?.emotion).toMatchObject({ ok: true, value: { status: 'observed' } });
    expect(report.value.postTurn?.workers).toEqual({ ok: true, value: [] });
  });

  it('reports a refused tool call to the model and keeps the turn attributable', async () => {
    const w = await piWorld(withDefaults((call) => (call.afterTool ? say(`The tool said: ${call.toolResults[0] ?? ''}`) : callTool('free_time', 'rest', { minutes: 30 }))));
    const report = await w.harness.converse({ evidence: 'primary-dm', text: 'go rest', idempotencyKey: 'k-1' });
    if (!report.ok) throw new Error(JSON.stringify(report.error));
    expect(report.value.status).toBe('completed');
    expect(report.value.reply).toContain('free_time.rest was refused: denied (requires_self_audience)');
    expect(report.value.usage).toMatchObject({ toolCalls: 1, failedToolCalls: 1 });
    expect([...w.activity.restState.lanes.values()]).toEqual([]);
  });

  it('replays a retried request from the ledger without calling the model again', async () => {
    const w = await piWorld(withDefaults(() => say('once only')));
    const first = await w.harness.converse({ evidence: 'primary-dm', text: 'hi', idempotencyKey: 'same-key' });
    const calls = w.model.calls.length;
    const again = await w.harness.converse({ evidence: 'primary-dm', text: 'hi', idempotencyKey: 'same-key' });
    expect(first.ok && first.value.status).toBe('completed');
    expect(again.ok && again.value).toMatchObject({ status: 'replayed', reply: 'once only', delivery: 'delivered' });
    expect(w.model.calls.length).toBe(calls);
    const reused = await w.harness.converse({ evidence: 'primary-dm', text: 'something else', idempotencyKey: 'same-key' });
    expect(reused.ok || reused.error).toMatchObject({ kind: 'conflict', reason: 'idempotency_mismatch' });
  });

  it('records an interruption with its partial reply and who interrupted, and the session goes on', async () => {
    const controller = new AbortController();
    const w = await piWorld(
      withDefaults((call) => {
        if (call.lastUser.endsWith('tell me a long story')) {
          setTimeout(() => controller.abort(new TurnInterruption('participant')), 30);
          return say('Once upon a time '.repeat(200));
        }
        return say('short answer');
      }),
      { tokensPerSecond: 2_000 },
    );
    const report = await w.harness.converse({ evidence: 'primary-dm', text: 'tell me a long story', idempotencyKey: 'k-1', signal: controller.signal });
    if (!report.ok) throw new Error(JSON.stringify(report.error));
    expect(report.value.status).toBe('interrupted');
    const outcome = outcomeOf(report.value);
    expect(outcome).toMatchObject({ kind: 'interrupted', by: 'participant', delivery: 'not_delivered' });
    const partial = outcome?.kind === 'interrupted' ? outcome.partialReply : null;
    expect(partial?.startsWith('Once upon a time')).toBe(true);
    expect(partial?.length).toBeLessThan('Once upon a time '.repeat(200).length);
    expect(w.delivered).toEqual([]);

    const next = await w.harness.converse({ evidence: 'primary-dm', text: 'are you there?', idempotencyKey: 'k-2' });
    expect(next.ok && next.value.status).toBe('completed');
    const entries = await history(w, report.value.record.sessionId);
    expect(entries.map((e) => e.origin)).toEqual(['participant_speech', 'companion_speech', 'system_note', 'participant_speech', 'companion_speech']);
    expect(entries[2]?.text).toBe('turn interrupted by participant');
  });

  it('records a provider failure as a failed turn with its cause', async () => {
    const w = await piWorld(withDefaults(() => providerError('provider overloaded')));
    const report = await w.harness.converse({ evidence: 'primary-dm', text: 'hello', idempotencyKey: 'k-1' });
    if (!report.ok) throw new Error(JSON.stringify(report.error));
    expect(report.value.status).toBe('failed');
    expect(outcomeOf(report.value)).toEqual({ kind: 'failed', error: { code: 'model_error', message: 'provider overloaded' }, partialReply: null, delivery: 'not_attempted' });
    expect((await history(w, report.value.record.sessionId)).at(-1)).toEqual({ origin: 'system_note', text: 'turn failed: model_error: provider overloaded' });
  });

  it('stops a runaway tool loop at the call budget and records why', async () => {
    const w = await piWorld(withDefaults(() => callTool('memory', 'census', {})));
    const report = await w.harness.converse({ evidence: 'primary-dm', text: 'loop forever', idempotencyKey: 'k-1' });
    if (!report.ok) throw new Error(JSON.stringify(report.error));
    expect(report.value.status).toBe('failed');
    expect(outcomeOf(report.value)).toMatchObject({ kind: 'failed', error: { code: 'turn_stopped', message: 'model call budget of 4 reached' } });
    expect(report.value.usage).toMatchObject({ modelCalls: 4, toolCalls: 4 });
  });

  it('recovers a turn a crashed harness left open only after its lease, attributed to the host', async () => {
    const w = await piWorld(withDefaults(() => say('back again')));
    const scope = await w.admit('primary-dm');
    const session = await w.sessions.current(scope);
    if (!session.ok) throw new Error('session');
    const crashed = await w.lifecycle.prepareTurn(scope, {
      sessionId: session.value.sessionId,
      owner: { surface: w.owner.surface, instance: 'crashed-process' },
      idempotencyKey: id('crashed-1'),
      expectedRevision: 0,
      trigger: { kind: 'participant_message', text: 'this turn never finished' },
    });
    expect(crashed.ok).toBe(true);

    const early = await w.harness.converse({ evidence: 'primary-dm', text: 'hello?', idempotencyKey: 'k-1' });
    expect(early.ok || early.error).toMatchObject({ kind: 'conflict', reason: 'turn_lease_active' });

    w.clock.advance(TURN_LEASE_MS + 1);
    const later = await w.harness.converse({ evidence: 'primary-dm', text: 'hello?', idempotencyKey: 'k-1' });
    expect(later.ok && later.value.status).toBe('completed');
    expect(await history(w, session.value.sessionId as SessionId)).toEqual([
      { origin: 'participant_speech', text: 'this turn never finished' },
      { origin: 'system_note', text: 'turn interrupted by host; recovered by pi' },
      { origin: 'participant_speech', text: 'hello?' },
      { origin: 'companion_speech', text: 'back again' },
    ]);
  });

  it('refuses unknown callers and never treats internal evidence as a conversation', async () => {
    const w = await piWorld(withDefaults(() => say('hi')));
    const stranger = await w.harness.converse({ evidence: 'not-a-token', text: 'hi', idempotencyKey: 'k-1' });
    expect(stranger.ok || stranger.error).toMatchObject({ kind: 'denied', reason: 'unknown_authority' });
    const internal = await w.harness.converse({ evidence: 'free-time', text: 'hi', idempotencyKey: 'k-2' });
    expect(internal.ok || internal.error).toMatchObject({ kind: 'invalid' });
    expect(w.model.calls).toEqual([]);
  });

  it('interrupts every running turn on shutdown and records it as such', async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const w = await piWorld(
      withDefaults(() => {
        started();
        return say('a reply that takes a while to stream '.repeat(100));
      }),
      { tokensPerSecond: 2_000 },
    );
    const turn = w.harness.converse({ evidence: 'primary-dm', text: 'hi', idempotencyKey: 'k-1' });
    await running;
    expect(w.harness.activeTurns()).toBe(1);
    expect(w.harness.interruptAll('shutdown')).toBe(1);
    const report = await turn;
    expect(report.ok && outcomeOf(report.value)).toMatchObject({ kind: 'interrupted', by: 'shutdown' });
    expect(w.harness.activeTurns()).toBe(0);
  });
});
