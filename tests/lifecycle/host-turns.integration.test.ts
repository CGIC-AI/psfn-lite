/**
 * Host-driven turns over the extracted companion core: an external host
 * (Hermes) prepares a turn, calls donor tools over MCP inside it and settles
 * it, and the donor SubstrateAgent does the rest: it assembles the context the
 * host's model sees, runs every tool call in its own loop, and records the
 * turn in its session archive when the host's final reply ends the loop. The
 * host's model answers replace the provider only for that turn: the faux
 * provider never sees the host's message.
 */
import { describe, expect, it } from 'vitest';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { RUNTIME_TIMEOUT_MS, COMPANION_NAME } from '../support/lite-world.ts';
import { bridge, mcpClient, useBridgeWorld } from './bridge-world.ts';

const HOST_MESSAGE = 'Hello from the host, what is on your mind today?';
const HOST_REPLY = 'I was thinking about the garden we planted.';
const HOST_TURN_TIMEOUT_MS = 8_000;

describe.skipIf(dockerTestsOptedOut('lifecycle host-driven turns'))('host-driven turns', () => {
  // One runtime per process (donor readiness ledger); the timeout case needs a short host-turn timeout.
  const world = useBridgeWorld(() => null, { hostTurnTimeoutMs: HOST_TURN_TIMEOUT_MS });

  it('prepares the donor context, runs a donor tool in the turn and archives the settled turn', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const prepared = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', idempotencyKey: 'msg-1', sessionId: 'session-a', message: HOST_MESSAGE });
    expect(prepared.status).toBe(200);
    expect(prepared.body['kind']).toBe('prepared');
    expect(prepared.body['resumed']).toBe(false);
    const turnId = prepared.body['turnId'] as string;
    const context = prepared.body['context'] as { systemPrompt: string; messages: { role: string; text: string }[]; tools: string[] };
    expect(context.systemPrompt).toContain(COMPANION_NAME);
    expect(context.messages.filter((m) => m.role === 'user').at(-1)?.text).toContain(HOST_MESSAGE);
    expect(context.tools).toContain('orient');

    // The MCP surface is the donor catalog, one tool per donor tool.
    const client = await mcpClient(w, operator);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      for (const name of ['tool_search', 'toolset', 'orient', 'memory', 'scratchpad', 'contact', 'journal']) expect(names).toContain(name);

      // A tool call inside the open turn is run by the donor loop.
      const called = await client.callTool({ name: 'orient', arguments: { action: 'values_list' } });
      expect(called.isError ?? false).toBe(false);
      expect((called.structuredContent as { origin: string }).origin).toBe('tool_result');
    } finally {
      await client.close();
    }

    // Re-preparing the open key answers the same turn.
    const again = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', idempotencyKey: 'msg-1', sessionId: 'session-a', message: HOST_MESSAGE });
    expect(again.body).toMatchObject({ kind: 'prepared', turnId, resumed: true });

    const open = await bridge(w, 'checkpoint', operator, { sessionId: 'session-a', turnIds: [turnId] });
    expect(open.body).toEqual({ settled: [], open: [turnId] });

    const settled = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId, outcome: { kind: 'completed', reply: HOST_REPLY } });
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({ turnId, status: 'completed' });

    // The donor recorded the turn in its archive; a repeated settle answers the same; a replayed prepare is refused as recorded.
    const checkpoint = await bridge(w, 'checkpoint', operator, { sessionId: 'session-a', turnIds: [turnId] });
    expect(checkpoint.body).toEqual({ settled: [turnId], open: [] });
    const repeated = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId, outcome: { kind: 'completed', reply: HOST_REPLY } });
    expect(repeated.body).toEqual(settled.body);
    const replayed = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', idempotencyKey: 'msg-1', sessionId: 'session-a', message: HOST_MESSAGE });
    expect(replayed.body).toEqual({ kind: 'replayed' });

    // The provider never answered the host's turn.
    expect(w.model.calls.some((call) => call.lastUser.includes(HOST_MESSAGE))).toBe(false);
    expect(settled.body['reply']).toBe(HOST_REPLY);

    // The next turn of the session is assembled from the donor's archive: the first exchange is its history.
    const next = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', idempotencyKey: 'msg-2', sessionId: 'session-a', message: 'And after that?' });
    expect(next.body['kind']).toBe('prepared');
    const history = (next.body['context'] as { messages: { role: string; text: string }[] }).messages;
    expect(history.some((m) => m.role === 'user' && m.text.includes(HOST_MESSAGE))).toBe(true);
    expect(history.some((m) => m.role === 'assistant' && m.text.includes(HOST_REPLY))).toBe(true);
    const done = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId: next.body['turnId'], outcome: { kind: 'completed', reply: 'Then we rest.' } });
    expect(done.body['status']).toBe('completed');
  }, RUNTIME_TIMEOUT_MS);

  it('records an interrupted and a failed host turn as the donor ends them, and refuses tools outside an open turn', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const friend = w.credentials['hermes-friend'];

    const client = await mcpClient(w, operator);
    try {
      const outside = await client.callTool({ name: 'orient', arguments: { action: 'values_list' } });
      expect(outside.isError).toBe(true);
      expect(JSON.stringify(outside.structuredContent)).toContain('no_open_turn');
    } finally {
      await client.close();
    }

    const first = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', idempotencyKey: 'i-1', sessionId: 'session-b', message: 'Wait, never mind.' });
    expect(first.body['kind']).toBe('prepared');
    // One agent: another principal's turn waits for this one.
    const busy = await bridge(w, 'prepare', friend, { hostInstance: 'hermes-2', idempotencyKey: 'f-1', sessionId: 'session-f', message: 'Hi!' });
    expect(busy.status).toBe(503);
    const sameAgain = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', idempotencyKey: 'i-2', sessionId: 'session-b', message: 'Another.' });
    expect(sameAgain.status).toBe(409);
    const interrupted = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId: first.body['turnId'], outcome: { kind: 'interrupted' } });
    expect(interrupted.body).toMatchObject({ status: 'interrupted' });

    const second = await bridge(w, 'prepare', friend, { hostInstance: 'hermes-2', idempotencyKey: 'f-1', sessionId: 'session-f', message: 'Hi!' });
    expect(second.body['kind']).toBe('prepared');
    const notOwner = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId: second.body['turnId'], outcome: { kind: 'completed', reply: 'x' } });
    expect(notOwner.status).toBe(403);
    const failed = await bridge(w, 'settle', friend, { hostInstance: 'hermes-2', turnId: second.body['turnId'], outcome: { kind: 'failed', error: { code: 'host_model_error', message: 'the host model failed' } } });
    expect(failed.body).toMatchObject({ status: 'failed', reply: null });
    const checkpoint = await bridge(w, 'checkpoint', friend, { sessionId: 'session-f', turnIds: [second.body['turnId']] });
    expect(checkpoint.body).toEqual({ settled: [second.body['turnId']], open: [] });
  }, RUNTIME_TIMEOUT_MS);

  it('fails a host turn the host leaves open past its timeout', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const prepared = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', idempotencyKey: 't-1', sessionId: 'session-t', message: 'Are you there?' });
    expect(prepared.body['kind']).toBe('prepared');
    await new Promise((resolve) => setTimeout(resolve, HOST_TURN_TIMEOUT_MS + 1_500));
    const late = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId: prepared.body['turnId'], outcome: { kind: 'completed', reply: 'Yes.' } });
    expect(late.body).toMatchObject({ status: 'failed' });
  }, RUNTIME_TIMEOUT_MS);
});
