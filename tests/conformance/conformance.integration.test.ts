/**
 * Continuity conformance: every scenario in tests/conformance/scenarios runs
 * through the real standalone runtime in its own host process, over a
 * throwaway Postgres and temporary storage roots, with the Pi harness and
 * the Hermes protocol (lifecycle bridge + MCP) as the two surfaces, in both
 * orders where the scenario says so. The same scenario files run against the
 * real Hermes plugin in integrations/hermes/tests/test_conformance.py, except
 * those it skips with a stated reason (delegated internal turns).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_START_TIMEOUT_MS, dockerTestsOptedOut, startPostgresHarness, type PostgresHarness } from '../support/postgres-harness.ts';
import { HermesProtocolDriver } from './drivers.ts';
import { HostProcess } from './host-client.ts';
import { loadScenarios, ordersOf } from './scenario.ts';
import { runScenario } from './runner.ts';

type Surface = readonly { readonly name: string; readonly actions: readonly string[] }[];

/** Measured at 3-12 s per run locally (process start, migrations, a backup restore); four times that leaves headroom. */
const SCENARIO_TIMEOUT_MS = 60_000;

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

  const freshState = async () => {
    if (harness === undefined) throw new Error('postgres harness did not start');
    const base = await mkdtemp(join(tmpdir(), 'lite-conformance-'));
    bases.push(base);
    return {
      databaseUrl: await harness.createDatabase(),
      spareDatabaseUrl: await harness.createDatabase(),
      base,
      roots: null,
      clockMs: 0,
      credentials: null,
      ports: null,
      internalTurns: 'harness' as const,
      generation: 0,
    };
  };

  it('offers the companion the same full tool inventory on Pi and over MCP: every tool and every action core declares', async () => {
    const host = await HostProcess.start(await freshState());
    const hermes = new HermesProtocolDriver(() => host);
    try {
      const inventory = await host.request<Surface>('inventory', {});
      await host.request('pi_turn', { say: 'hello', calls: [], reply: 'Hello.', hang: false, vars: {}, key: 'inventory-pi' });
      const pi = await host.request<Surface>('pi_tools', {});
      const listed = await (await hermes.client(host.ready.credentials['hermes-operator'])).listTools();
      const mcp: Surface = listed.tools.map((tool) => ({
        name: tool.name,
        actions: (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties['action']?.enum ?? [],
      }));
      expect(inventory.length).toBeGreaterThan(0);
      expect(pi).toEqual(inventory);
      expect(mcp).toEqual(inventory);
    } finally {
      await hermes.reset();
      await host.close();
    }
  }, SCENARIO_TIMEOUT_MS);

  for (const scenario of loadScenarios()) {
    for (const order of ordersOf(scenario)) {
      it(`${scenario.name} [a=${order.a}, b=${order.b}]: ${scenario.invariant}`, async () => {
        const report = await runScenario(scenario, order, { ...(await freshState()), internalTurns: scenario.internalTurns });
        expect(report.issues).toEqual([]);
      }, SCENARIO_TIMEOUT_MS);
    }
  }
});
