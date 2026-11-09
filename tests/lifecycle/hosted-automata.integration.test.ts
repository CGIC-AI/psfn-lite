/**
 * Hosted automata over the real standalone runtime (docs/extraction.md,
 * operator automata rules): an automaton is spawned through the faculty the
 * donor `subagent` tool drives; core derives its task and Bus scope from
 * that spawn and queues it; the host claims the attempt
 * over the lifecycle bridge with its standing credential, runs it as its own
 * subagent, persists through the attempt's `automata/bus` calls under the
 * per-attempt credential, and reports how the child ended. A lost child
 * ends the attempt and the next attempt's repeat of the same write is the
 * same Bus event.
 */
import { describe, expect, it } from 'vitest';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { buildSubagentWorkSpec } from '../../packages/companion/src/faculties/subagents/work-spec.js';
import { runWithRequestContext } from '../../packages/companion/src/primitives/llm/request-context.js';
import { bridge, useBridgeWorld } from './bridge-world.ts';

const POLICY = { maxAttempts: 2, leaseMs: 60_000, maxIterations: 250 };

interface Claim {
  readonly attemptId: string;
  readonly subagentId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly goal: string;
  readonly credential: string;
  readonly budget: { readonly maxIterations: number };
  readonly busAccess: boolean;
}

/** An admitted owner request context, as a spawning turn carries (the faculty refuses a spawn without one). */
async function asOwner<T>(run: () => Promise<T>): Promise<T> {
  return await runWithRequestContext(
    { callType: 'tool', purpose: 'agent.turn', channelId: 'api:owner-console', viewerTrustLevel: 'primary', viewerChannelPrivacy: 'private' },
    run,
  );
}

describe.skipIf(dockerTestsOptedOut('lifecycle hosted automata'))('hosted automata over the lifecycle bridge', () => {
  const world = useBridgeWorld(() => null, { automata: POLICY });

  it('runs a spawned automaton as host attempts: lost, retried, one Bus event, completed', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const friend = w.credentials['hermes-friend'];
    const claim = async (credential: string, hostInstance: string, maxIterations = 250) =>
      await bridge(w, 'automata/claim', credential, { hostInstance, maxIterations, limit: 4 });

    expect((await claim(operator, 'hermes-1')).body).toEqual({ attempts: [] });
    // Only a principal bound to the primary contact runs the companion's automata.
    expect((await claim(friend, 'hermes-1')).status).toBe(403);

    // Lite's fixed nursery tier denies the `subagent` tool in turns (no shard.spawn), so the
    // automaton is started through the same control port the tool drives, as an admitted owner turn would.
    const faculty = w.runtime.companion.subagentFaculty;
    const spawned = await asOwner(() => faculty.spawn({ name: 'route-research', task: 'Map the route docs.', workSpec: buildSubagentWorkSpec() }));
    const subagentId = spawned.subagentId;
      // The host's per-attempt budget may not exceed the policy's.
      expect((await claim(operator, 'hermes-1', 251)).status).toBe(409);
      let claimed: Claim[] = [];
      for (let tries = 0; tries < 50 && claimed.length === 0; tries += 1) {
        claimed = ((await claim(operator, 'hermes-1')).body['attempts'] as Claim[]);
        if (claimed.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const [first] = claimed;
      expect(first).toMatchObject({ subagentId, attempt: 1, maxAttempts: 2, goal: 'Map the route docs.', budget: { maxIterations: 250 }, busAccess: true });

      // The attempt credential is bound to this principal and host instance.
      const attempt = (credential: string, hostInstance = 'hermes-1') => ({ hostInstance, attemptCredential: credential });
      expect((await bridge(w, 'automata/heartbeat', friend, attempt(first!.credential))).status).toBe(403);
      expect((await bridge(w, 'automata/heartbeat', operator, attempt(first!.credential, 'hermes-2'))).status).toBe(403);
      expect((await bridge(w, 'automata/heartbeat', operator, attempt(first!.credential))).body).toEqual({ status: 'active', attempt: 1 });

      const note = { action: 'note', text: 'Route docs live under docs/routes.' };
      const written = await bridge(w, 'automata/bus', operator, { ...attempt(first!.credential), arguments: note });
      expect(written.status).toBe(200);
      expect(written.body['isError']).toBe(false);
      expect(written.body['text']).toContain('"inserted": true');

      // The child is lost: the attempt ends and its credential is gone.
      const lost = await bridge(w, 'automata/report', operator, { ...attempt(first!.credential), outcome: { kind: 'lost', code: 'process_exit' } });
      expect(lost.body).toEqual({ attempt: 1, next: 'retry' });
      expect((await bridge(w, 'automata/bus', operator, { ...attempt(first!.credential), arguments: note })).status).toBe(410);

      const [second] = (await claim(operator, 'hermes-1')).body['attempts'] as Claim[];
      expect(second).toMatchObject({ subagentId, attempt: 2 });
      expect(second!.credential).not.toBe(first!.credential);
      const repeated = await bridge(w, 'automata/bus', operator, { ...attempt(second!.credential), arguments: note });
      expect(repeated.body['text']).toContain('"inserted": false');
      // The parent waits on the live automaton, as the `subagent` tool's wait does.
      const waiting = asOwner(() => faculty.wait(subagentId));
      const done = await bridge(w, 'automata/report', operator, {
        ...attempt(second!.credential),
        outcome: { kind: 'succeeded', summary: 'Mapped the route docs.', model: null, apiCalls: 3 },
      });
      expect(done.body).toEqual({ attempt: 2, next: 'completed' });

      const result = await waiting;
      expect(result).toMatchObject({ outcome: 'completed', content: 'Mapped the route docs.' });
  });

  it('parses attempt bodies strictly', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const extra = await bridge(w, 'automata/claim', operator, { hostInstance: 'hermes-1', maxIterations: 250, limit: 1, role: 'leaf' });
    expect(extra.status).toBe(400);
    const badOutcome = await bridge(w, 'automata/report', operator, { hostInstance: 'hermes-1', attemptCredential: 'x'.repeat(43), outcome: { kind: 'done' } });
    expect(badOutcome.status).toBe(400);
    const unknown = await bridge(w, 'automata/heartbeat', operator, { hostInstance: 'hermes-1', attemptCredential: 'x'.repeat(43) });
    expect(unknown.status).toBe(404);
    expect((await bridge(w, 'automata/claim', null, { hostInstance: 'hermes-1', maxIterations: 250, limit: 1 })).status).toBe(401);
  });
});
