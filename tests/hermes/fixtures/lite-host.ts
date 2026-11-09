/**
 * A PSFN Lite host for the Hermes plugin's end-to-end tests: the conformance
 * host (the real standalone runtime over the extracted companion core, with
 * pi-ai's faux model, the MCP transport and the lifecycle bridge on loopback)
 * over a throwaway Postgres. Before it reports ready, the operator's own Pi
 * turn writes what the companion knows about Robin into its orientation, so a
 * Hermes turn has another surface's work to see.
 *
 * Run: node --import tsx tests/hermes/fixtures/lite-host.ts. It prints one
 * JSON line ({mcpUrl, lifecycleUrl, credentials, hostTurnTimeoutMs}) and runs
 * until stdin closes, then closes the runtime and removes exactly its own
 * Postgres container and temporary directories. Credentials are random per
 * run and never written to disk. The donor logger's stdout lines go to stderr.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConformanceHost, HOST_TURN_TIMEOUT_MS } from '../../conformance/host/host.ts';
import { HERMES_TEST_INSTALL_ID } from '../../support/lite-install.ts';
import { startPostgresHarness } from '../../support/postgres-harness.ts';

const protocol = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

/** What the seed turn writes; the Python tests look for it. */
const SEED_THREAD = 'Robin is sorting the seed packets for spring';

async function main(): Promise<void> {
  const harness = await startPostgresHarness();
  const root = await mkdtemp(join(tmpdir(), 'lite-hermes-e2e-'));
  const base = join(root, 'data');
  try {
    const host = new ConformanceHost({ databaseUrl: await harness.createDatabase(), base, companionId: null, credentials: null, sessionKeys: null, ports: null, generation: 0 });
    const ready = await host.open();
    try {
      const seed = await host.piTurn({
        say: 'please start on the seed packets',
        calls: [{ tool: 'orient', action: 'create_concern', args: { text: SEED_THREAD, contactId: ready.vars['contact.operator'], sensitivity: 'personal' } }],
        reply: 'Started.',
        vars: {},
        key: 'seed',
      });
      if (seed.results.some((r) => !r.ok)) throw new Error(`the seed turn failed: ${JSON.stringify(seed.results)}`);
      protocol(`${JSON.stringify({ mcpUrl: ready.mcpUrl, lifecycleUrl: ready.lifecycleUrl, credentials: ready.credentials, hermesInstallId: HERMES_TEST_INSTALL_ID, hostTurnTimeoutMs: HOST_TURN_TIMEOUT_MS })}\n`);
      process.stdin.resume();
      await new Promise<void>((resolve) => process.stdin.once('end', resolve));
    } finally {
      await host.close();
    }
  } finally {
    harness.stop();
    await rm(root, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`lite-host failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
