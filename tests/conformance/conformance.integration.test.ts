/**
 * Continuity conformance: every scenario in tests/conformance/scenarios runs
 * through the real standalone runtime (the extracted companion core) in its
 * own host process, over a throwaway Postgres and a temporary data directory,
 * with donor-driven Pi turns and host-driven Hermes-protocol turns (the
 * lifecycle bridge and MCP) as the two surfaces of one donor session, in both
 * orders where the scenario says so. The same scenario files run against the
 * real Hermes plugin in integrations/hermes/tests/test_conformance.py.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_START_TIMEOUT_MS, dockerTestsOptedOut, startPostgresHarness, type PostgresHarness } from '../support/postgres-harness.ts';
import { HermesProtocolDriver } from './drivers.ts';
import { excludedName } from './excluded-names.ts';
import { HostProcess } from './host-client.ts';
import type { HostState } from './host/host.ts';
import { loadScenarios, ordersOf } from './scenario.ts';
import { runScenario } from './runner.ts';

/** A scenario boots the companion core in a fresh process (twice with a crash step) and waits out a host-turn timeout at most once. */
const SCENARIO_TIMEOUT_MS = 300_000;

describe.skipIf(dockerTestsOptedOut('continuity conformance'))('continuity conformance over Pi and the Hermes protocol', () => {
  let harness: PostgresHarness | undefined;
  const bases: string[] = [];
  beforeAll(async () => {
    harness = await startPostgresHarness();
  }, HARNESS_START_TIMEOUT_MS);
  afterAll(async () => {
    harness?.stop();
    for (const base of bases) await rm(base, { recursive: true, force: true });
  });

  const freshState = async (): Promise<HostState> => {
    if (harness === undefined) throw new Error('postgres harness did not start');
    const base = await mkdtemp(join(tmpdir(), 'lite-conformance-'));
    bases.push(base, `${base}-workspace`);
    return { databaseUrl: await harness.createDatabase(), base, companionId: null, credentials: null, ports: null, generation: 0 };
  };

  it('serves the donor tool catalog over MCP, offers the same tools on both surfaces, and serves no cut scaffolding tool', async () => {
    const host = await HostProcess.start(await freshState());
    const hermes = new HermesProtocolDriver(() => host);
    try {
      await host.request('pi_turn', { say: 'hello', calls: [], reply: 'Hello.', vars: {}, key: 'inventory-pi' });
      const inventory = await host.request<{ catalog: string[]; offered: string[] }>('inventory');
      const operator = host.ready.credentials['hermes-operator'];
      const listed = (await (await hermes.client(operator)).listTools()).tools.map((tool) => tool.name);
      expect(inventory.catalog.length).toBeGreaterThan(0);
      expect([...listed].sort()).toEqual([...inventory.catalog].sort());
      expect(listed.filter((name) => excludedName(name) !== null)).toEqual([]);
      // The donor offers the model its core tools and whatever it loaded; both surfaces get the same assembly.
      const prepared = await hermes.bridge('prepare', operator, { hostInstance: 'inventory', idempotencyKey: 'inventory-hermes', sessionId: 'inventory', message: 'hello again' });
      const offered = (prepared.body['context'] as { tools: string[] }).tools;
      expect([...offered].sort()).toEqual([...inventory.offered].sort());
      for (const name of offered) expect(listed).toContain(name);
      await hermes.bridge('settle', operator, { hostInstance: 'inventory', turnId: prepared.body['turnId'], outcome: { kind: 'completed', reply: 'Hi.' } });
    } finally {
      await hermes.reset();
      await host.close();
    }
  }, SCENARIO_TIMEOUT_MS);

  for (const scenario of loadScenarios()) {
    for (const order of ordersOf(scenario)) {
      it(`${scenario.name} [a=${order.a}, b=${order.b}]: ${scenario.invariant}`, async () => {
        const report = await runScenario(scenario, order, await freshState());
        expect(report.issues).toEqual([]);
      }, SCENARIO_TIMEOUT_MS);
    }
  }
});
