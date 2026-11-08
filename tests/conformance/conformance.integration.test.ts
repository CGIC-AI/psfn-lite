/**
 * Continuity conformance: every scenario in tests/conformance/scenarios runs
 * through the real standalone runtime in its own host process, over a
 * throwaway Postgres and temporary storage roots, with the Pi harness and
 * the Hermes protocol (lifecycle bridge + MCP) as the two surfaces, in both
 * orders where the scenario says so. The same scenario files run against the
 * real Hermes plugin in integrations/hermes/tests/test_conformance.py.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_START_TIMEOUT_MS, dockerTestsOptedOut, startPostgresHarness, type PostgresHarness } from '../support/postgres-harness.ts';
import { loadScenarios, ordersOf } from './scenario.ts';
import { runScenario } from './runner.ts';

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

  for (const scenario of loadScenarios()) {
    for (const order of ordersOf(scenario)) {
      it(`${scenario.name} [a=${order.a}, b=${order.b}]: ${scenario.invariant}`, async () => {
        if (harness === undefined) throw new Error('postgres harness did not start');
        const base = await mkdtemp(join(tmpdir(), 'lite-conformance-'));
        bases.push(base);
        const report = await runScenario(scenario, order, {
          databaseUrl: await harness.createDatabase(),
          spareDatabaseUrl: await harness.createDatabase(),
          base,
          roots: null,
          clockMs: 0,
          credentials: null,
          ports: null,
          internalTurns: scenario.internalTurns,
          generation: 0,
        });
        expect(report.issues).toEqual([]);
      }, SCENARIO_TIMEOUT_MS);
    }
  }
});
