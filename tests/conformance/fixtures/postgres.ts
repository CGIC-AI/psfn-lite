/**
 * A throwaway Postgres for a runner outside vitest (the Python conformance
 * runner inside the pinned Hermes): the same labelled pgvector container the
 * TypeScript integration suites use.
 *
 * Run: node --import tsx tests/conformance/fixtures/postgres.ts. Each stdin
 * line `create` is answered with one line {"databaseUrl": "..."} naming a new
 * empty database. When stdin ends the process removes exactly its own
 * container and exits.
 */
import { createInterface } from 'node:readline';
import { startPostgresHarness } from '../../support/postgres-harness.ts';

async function main(): Promise<void> {
  const harness = await startPostgresHarness();
  try {
    process.stdout.write(`${JSON.stringify({ event: 'ready' })}\n`);
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (line.trim() !== 'create') throw new Error(`unknown request ${JSON.stringify(line)}`);
      process.stdout.write(`${JSON.stringify({ databaseUrl: await harness.createDatabase() })}\n`);
    }
  } finally {
    harness.stop();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`postgres fixture failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
