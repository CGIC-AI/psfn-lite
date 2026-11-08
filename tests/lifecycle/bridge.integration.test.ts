/**
 * The lifecycle bridge an external companion host drives, end to end over
 * the standalone runtime and a throwaway Postgres: callers bound from their
 * credential, completed, interrupted and failed turns archived under stable
 * identities, a resumed preparation, a checkpoint that proves history before
 * the host compacts, cross-surface activity seen only where it is
 * authorized, and internal turns core delegates to the host attributed as
 * system notes, never participant speech.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { SessionId } from '../../packages/core/src/index.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { callTool, say, withDefaults, type BrainCall } from '../pi/faux-brain.ts';
import { archived, unwrap } from '../standalone/standalone-world.ts';
import { bridge, useBridgeWorld, type BridgeWorld } from './bridge-world.ts';

/** The Pi harness's script for the operator's CLI turns and internal turns run in-process. */
function companion(call: BrainCall) {
  if (call.lastUser.includes('seed packets')) {
    return call.afterTool ? say('Started on the seed packets.') : callTool('activity', 'start', { purpose: 'Sorting the seed packets for spring' });
  }
  return say('ok');
}

const prepareBody = (key: string, message: string | null) => ({ hostInstance: 'hermes-proc-1', idempotencyKey: key, message });
const completed = (reply: string) => ({ kind: 'completed', reply, delivery: 'delivered' });

async function prepared(world: BridgeWorld, credential: string, key: string, message: string) {
  const reply = await bridge(world, 'prepare', credential, prepareBody(key, message));
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expect(reply.body['kind']).toBe('prepared');
  return reply.body as { turnId: string; sessionId: string; resumed: boolean; context: { activity: { label: string; text: string }[]; history: { role: string; label: string | null; text: string }[] } };
}

async function settle(world: BridgeWorld, credential: string, turnId: string, outcome: unknown) {
  return bridge(world, 'settle', credential, { hostInstance: 'hermes-proc-1', turnId, outcome, toolCallCount: 0 });
}

describe.skipIf(dockerTestsOptedOut('lifecycle bridge'))('the lifecycle bridge over the standalone runtime and Postgres', () => {
  const open = useBridgeWorld();

  it('binds the caller from the credential and archives completed, interrupted and failed turns under stable identities', async () => {
    const world = await open(withDefaults(companion), { delegated: false });
    await world.seedContacts();
    const operator = world.credentials['hermes-operator'];

    expect((await bridge(world, 'prepare', null, prepareBody('k-0', 'hi'))).status).toBe(401);
    expect((await bridge(world, 'prepare', 'not-a-bound-credential-but-long-enough-xx', prepareBody('k-0', 'hi'))).status).toBe(401);
    // The body never names the caller: an unknown field is refused, not trusted.
    const smuggled = await bridge(world, 'prepare', operator, { ...prepareBody('k-0', 'hi'), speaker: 'contact-x' });
    expect(smuggled).toMatchObject({ status: 400, body: { error: { kind: 'invalid' } } });

    const first = await prepared(world, operator, 'hermes:t-1', 'hello from hermes');
    expect(first.resumed).toBe(false);
    // The same key while the turn is open resumes it, with the same identity and the history before its trigger.
    const again = await prepared(world, operator, 'hermes:t-1', 'hello from hermes');
    expect(again).toMatchObject({ turnId: first.turnId, sessionId: first.sessionId, resumed: true });
    expect(again.context.history.map((e) => e.text)).not.toContain('hello from hermes');
    // A second turn cannot start while this host's own turn is open.
    expect((await bridge(world, 'prepare', operator, prepareBody('hermes:t-x', 'another'))).body).toMatchObject({ error: { kind: 'conflict', reason: 'turn_already_open' } });

    const done = await settle(world, operator, first.turnId, completed('hello, operator'));
    expect(done).toMatchObject({ status: 200, body: { turnId: first.turnId, status: 'completed', reply: 'hello, operator', settledNow: true, postTurn: { emotion: { ok: true }, workers: { ok: true } } } });
    // Settling again with the same outcome only repairs history; post-turn work does not run twice.
    expect((await settle(world, operator, first.turnId, completed('hello, operator'))).body).toMatchObject({ settledNow: false, postTurn: { emotion: null } });
    expect((await settle(world, operator, first.turnId, completed('a different reply'))).body).toMatchObject({ error: { kind: 'conflict', reason: 'turn_already_settled' } });
    // A replayed key returns the recorded outcome instead of running again.
    expect((await bridge(world, 'prepare', operator, prepareBody('hermes:t-1', 'hello from hermes'))).body).toMatchObject({ kind: 'replayed', turnId: first.turnId, status: 'completed', reply: 'hello, operator' });

    const second = await prepared(world, operator, 'hermes:t-2', 'tell me a long story');
    expect(second.context.history.map((e) => [e.role, e.text])).toEqual([
      ['participant', 'hello from hermes'],
      ['companion', 'hello, operator'],
    ]);
    expect((await settle(world, operator, second.turnId, { kind: 'interrupted', by: 'participant', partialReply: null, delivery: 'unknown' })).body).toMatchObject({ status: 'interrupted' });
    const third = await prepared(world, operator, 'hermes:t-3', 'and now?');
    const failure = { kind: 'failed', error: { code: 'hermes_turn_failed', message: 'the provider refused the request' }, partialReply: null, delivery: 'not_attempted' };
    expect((await settle(world, operator, third.turnId, failure)).body).toMatchObject({ status: 'failed' });

    // Another principal's credential cannot settle or see this host's turns.
    const friend = world.credentials['hermes-friend'];
    expect((await settle(world, friend, third.turnId, completed('x'))).body).toMatchObject({ error: { kind: 'not_found' } });

    const history = await archived(world.runtime, first.sessionId as SessionId);
    expect(history).toEqual([
      { origin: 'participant_speech', text: 'hello from hermes' },
      { origin: 'companion_speech', text: 'hello, operator' },
      { origin: 'participant_speech', text: 'tell me a long story' },
      { origin: 'system_note', text: 'turn interrupted by participant' },
      { origin: 'participant_speech', text: 'and now?' },
      { origin: 'system_note', text: 'turn failed: hermes_turn_failed: the provider refused the request' },
    ]);
    const ids = unwrap(await world.runtime.storage.archive.readTail(first.sessionId as SessionId, 100)).map((e) => e.entryId);
    expect(ids).toEqual([
      `${first.turnId}:trigger`,
      `${first.turnId}:reply`,
      `${second.turnId}:trigger`,
      `${second.turnId}:outcome`,
      `${third.turnId}:trigger`,
      `${third.turnId}:outcome`,
    ]);
  });

  it('proves canonical history before the host compacts, and refuses a checkpoint naming a turn it cannot prove', async () => {
    const world = await open(withDefaults(companion), { delegated: false });
    await world.seedContacts();
    const operator = world.credentials['hermes-operator'];
    const a = await prepared(world, operator, 'hermes:c-1', 'first');
    await settle(world, operator, a.turnId, completed('one'));
    const b = await prepared(world, operator, 'hermes:c-2', 'second, still running');

    expect(await bridge(world, 'checkpoint', operator, { turnIds: [a.turnId, b.turnId] })).toMatchObject({ status: 200, body: { settled: [a.turnId], open: [b.turnId] } });
    expect(await bridge(world, 'checkpoint', operator, { turnIds: [a.turnId, 'turn-that-never-was'] })).toMatchObject({ status: 404 });
    // Another audience's turn reads as missing, so its host cannot vouch for it either.
    expect(await bridge(world, 'checkpoint', world.credentials['hermes-friend'], { turnIds: [a.turnId] })).toMatchObject({ status: 404 });
    // Compaction never touched the archive: every source entry is still there.
    expect((await archived(world.runtime, a.sessionId as SessionId)).map((e) => e.text)).toEqual(['first', 'one', 'second, still running']);
  });

  it('shows recent activity from another surface to the operator, and not to a contact it is not disclosed to', async () => {
    const world = await open(withDefaults(companion), { delegated: false });
    await world.seedContacts();
    // The operator's turn on the standalone CLI (the Pi harness) starts an activity.
    const cli = unwrap(await world.runtime.converse({ text: 'please start on the seed packets', idempotencyKey: 'cli:seed' }));
    expect(cli.status).toBe('completed');

    const operator = await prepared(world, world.credentials['hermes-operator'], 'hermes:a-1', 'what have you been up to?');
    const seen = operator.context.activity.map((e) => e.text).join('\n');
    expect(seen).toContain('Sorting the seed packets for spring');
    expect(seen).toContain('in another conversation');
    expect(operator.context.activity.every((e) => e.label === 'internal signal: activity')).toBe(true);

    const friend = await prepared(world, world.credentials['hermes-friend'], 'hermes:a-2', 'what have you been up to?');
    expect(JSON.stringify(friend.context)).not.toContain('seed packets');
  });

  it('serves the governed tools to the Hermes credential over MCP on the same runtime', async () => {
    const world = await open(withDefaults(companion), { delegated: false });
    await world.seedContacts();
    const client = new Client({ name: 'hermes-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(world.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${world.credentials['hermes-operator']}` } } }));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['journal', 'memory', 'automata', 'free_time', 'activity', 'session']));
      const recent = await client.callTool({ name: 'activity', arguments: { action: 'recent', limit: 5 } });
      expect(JSON.stringify(recent.content)).not.toContain('error');
      expect(recent.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('delegates internal turns to the configured host, which runs them with the minted credential as system notes', async () => {
    const world = await open(withDefaults(companion), { delegated: true });
    await world.seedContacts();
    const operator = world.credentials['hermes-operator'];
    // Only the configured internal-turn host may claim; the friend's credential is refused.
    expect((await bridge(world, 'internal/claim', world.credentials['hermes-friend'], { waitMs: 0 })).status).toBe(403);

    const ran: { purpose: string; prompt: string; turnId: string; sessionId: string }[] = [];
    const host = (async () => {
      for (let i = 0; i < 4; i += 1) {
        const claim = await bridge(world, 'internal/claim', operator, { waitMs: 3_000 });
        const job = claim.body['job'] as { jobId: string; credential: string; purpose: string; prompt: string } | null;
        if (job === null) return;
        // The minted credential carries no message: core fixed the trigger.
        expect((await bridge(world, 'prepare', job.credential, prepareBody('ignored-key', 'injected speech'))).status).toBe(400);
        const turn = await bridge(world, 'prepare', job.credential, prepareBody('ignored-key', null));
        expect(turn.status, JSON.stringify(turn.body)).toBe(200);
        const turnId = turn.body['turnId'] as string;
        ran.push({ purpose: job.purpose, prompt: job.prompt, turnId, sessionId: turn.body['sessionId'] as string });
        const invitation = /blockId (\S+)\)/.exec(job.prompt);
        if (invitation !== null) {
          const mcp = new Client({ name: 'hermes-internal', version: '0.0.0' });
          await mcp.connect(new StreamableHTTPClientTransport(new URL(world.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${job.credential}` } } }));
          const chose = await mcp.callTool({ name: 'free_time', arguments: { action: 'choose', blockId: invitation[1], optionId: 'reflect' } });
          await mcp.close();
          expect(chose.isError, JSON.stringify(chose.content)).toBeFalsy();
        }
        const settled = await bridge(world, 'settle', job.credential, { hostInstance: 'ignored', turnId, outcome: completed('A quiet thought about the garden.'), toolCallCount: invitation === null ? 0 : 1 });
        expect(settled.status, JSON.stringify(settled.body)).toBe(200);
      }
    })();
    const tick = unwrap(await world.runtime.tick());
    await host;
    expect(tick.scheduler.ok && tick.scheduler.value.freeTime.some((r) => r.ok && r.value.kind === 'ran')).toBe(true);
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.every((r) => r.purpose === 'free_time')).toBe(true);
    const history = await archived(world.runtime, ran[0]!.sessionId as SessionId);
    // The internal trigger is a system note in the companion's own session, never participant speech.
    expect(history[0]).toMatchObject({ origin: 'system_note' });
    expect(history.some((e) => e.origin === 'participant_speech')).toBe(false);
    expect(history.filter((e) => e.origin === 'companion_speech').map((e) => e.text)).toContain('A quiet thought about the garden.');
  }, 30_000);

  it('fails a delegated internal turn visibly when the host releases it', async () => {
    const world = await open(withDefaults(companion), { delegated: true });
    await world.seedContacts();
    const operator = world.credentials['hermes-operator'];
    const host = (async () => {
      const claim = await bridge(world, 'internal/claim', operator, { waitMs: 3_000 });
      const job = claim.body['job'] as { jobId: string; credential: string } | null;
      if (job === null) return null;
      const turn = await bridge(world, 'prepare', job.credential, prepareBody('k', null));
      const released = await bridge(world, 'internal/release', operator, { jobId: job.jobId, error: { code: 'hermes_runner_failed', message: 'the hermes subprocess exited with status 1' } });
      expect(released.status).toBe(200);
      return turn.body['sessionId'] as string;
    })();
    const tick = unwrap(await world.runtime.tick());
    const sessionId = await host;
    expect(sessionId).not.toBeNull();
    expect(tick.scheduler.ok && tick.scheduler.value.freeTime.some((r) => !r.ok || r.value.kind !== 'ran')).toBe(true);
    // The abandoned turn is settled as failed in history, not left open or dropped.
    const history = await archived(world.runtime, sessionId as SessionId);
    expect(history.at(-1)).toEqual({ origin: 'system_note', text: 'turn failed: hermes_runner_failed: the hermes subprocess exited with status 1' });
    expect(world.diagnostics.some((d) => JSON.stringify(d).includes('released'))).toBe(true);
  }, 30_000);
});
