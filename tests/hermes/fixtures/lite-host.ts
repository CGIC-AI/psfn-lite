/**
 * A PSFN Lite host for the Hermes plugin's end-to-end tests: the real
 * standalone runtime (every core stack, the Postgres and file adapters, the
 * Pi harness with pi-ai's faux model) over a throwaway Postgres, with the MCP
 * transport and the lifecycle bridge mounted on loopback. Before it reports
 * ready, the operator's own standalone (Pi) turn starts an activity, so a
 * Hermes turn has another surface's recent activity to see.
 *
 * Run: tsx tests/hermes/fixtures/lite-host.ts. It prints one JSON line
 * ({mcpUrl, lifecycleUrl, credentials}) and runs until stdin closes, then
 * closes the runtime and removes exactly its own Postgres container and
 * temporary roots. Credentials are random per run and never written to disk.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiteRuntime, parseLiteConfig, randomIds, type LiteDiagnostic } from '../../../apps/standalone/src/index.ts';
import { createDisabledEmbeddings } from '../../../packages/pi/src/index.ts';
import { FixedClock } from '../../core/fakes.ts';
import { callTool, fauxRuntime, say, withDefaults } from '../../pi/faux-brain.ts';
import { startPostgresHarness } from '../../support/postgres-harness.ts';
import { HERMES_BINDINGS } from '../../lifecycle/bindings.ts';
import { liteConfigDocument } from '../../standalone/lite-config.ts';

const envName = (principal: string) => `LITE_HERMES_E2E_${principal.toUpperCase().replace(/-/g, '_')}`;

async function main(): Promise<void> {
  const harness = await startPostgresHarness();
  const base = await mkdtemp(join(tmpdir(), 'lite-hermes-e2e-'));
  const roots = { history: join(base, 'history'), workspace: join(base, 'workspace'), backups: join(base, 'backups') };
  for (const dir of Object.values(roots)) await mkdir(dir);
  const cleanup = async () => {
    harness.stop();
    await rm(base, { recursive: true, force: true });
  };
  try {
    const databaseUrl = await harness.createDatabase();
    const credentials = Object.fromEntries(Object.keys(HERMES_BINDINGS).map((p) => [p, randomBytes(32).toString('base64url')]));
    const document = {
      ...liteConfigDocument(roots),
      mcp: {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: null,
        bindings: Object.entries(HERMES_BINDINGS).map(([principal, attestation]) => ({ principal, credential: { env: envName(principal) }, attestation })),
        internalTurnTtlMs: 120_000,
        maxOpenInternalTurns: 4,
      },
      lifecycle: { host: '127.0.0.1', port: 0, allowedHosts: null, internalTurns: { kind: 'harness' } },
    };
    const config = parseLiteConfig(document);
    if (!config.ok) throw new Error(JSON.stringify(config.error));
    const clock = new FixedClock();
    clock.advance(12 * 3_600_000);
    const model = fauxRuntime(
      withDefaults((call) => {
        if (call.lastUser.includes('seed packets')) return call.afterTool ? say('Started.') : callTool('activity', 'start', { purpose: 'Sorting the seed packets for spring' });
        return say('ok');
      }),
    );
    const diagnostics: LiteDiagnostic[] = [];
    const runtime = await createLiteRuntime({
      config: config.value,
      databaseUrl,
      env: Object.fromEntries(Object.entries(credentials).map(([p, c]) => [envName(p), c])),
      host: {
        clock,
        ids: randomIds,
        model: model.runtime,
        embeddings: createDisabledEmbeddings(),
        channel: { reply: () => Promise.resolve({ ok: true, value: undefined }), reminder: () => Promise.resolve({ ok: true, value: undefined }) },
        instance: 'hermes-e2e',
        onDiagnostic: (d) => diagnostics.push(d),
      },
    });
    if (!runtime.ok) throw new Error(JSON.stringify(runtime.error));
    const lite = runtime.value;
    try {
      const operator = await lite.ensureOperator();
      if (!operator.ok) throw new Error(JSON.stringify(operator.error));
      const friend = await lite.stacks.contactAdmin.register('test:seed', {
        displayName: 'Sam',
        identity: { channelKind: 'telegram', externalId: 'friend-1' },
        trust: 'regular',
        relationship: 'friend',
        consent: 'granted',
        sensitivity: 'personal',
      });
      if (!friend.ok) throw new Error(JSON.stringify(friend.error));
      const turn = await lite.converse({ text: 'please start on the seed packets', idempotencyKey: 'cli:seed' });
      if (!turn.ok || turn.value.status !== 'completed') throw new Error(`the standalone turn did not complete: ${JSON.stringify(turn)}`);
      process.stdout.write(`${JSON.stringify({ mcpUrl: lite.transports.mcpUrl, lifecycleUrl: lite.transports.lifecycleUrl, credentials })}\n`);
      // Runs until the test closes stdin; diagnostics go to stderr for the test log.
      process.stdin.resume();
      await new Promise<void>((resolve) => process.stdin.once('end', resolve));
      for (const d of diagnostics) if (d.kind === 'transport') process.stderr.write(`[lite] ${JSON.stringify(d)}\n`);
    } finally {
      await lite.close();
    }
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`lite-host failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
