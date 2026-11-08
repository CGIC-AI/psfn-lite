/**
 * Throwaway Postgres for integration tests, adapted from the donor's
 * `src/test-support/postgres-test-harness.ts` idea: a pinned pgvector image,
 * PGDATA on tmpfs, a label, and a random host port. Unlike the donor it never
 * reuses a warm container: every harness starts its own uniquely named
 * container and removes exactly that container afterwards. It never lists,
 * stops or removes any other container.
 *
 * Docker is required. When it is unavailable the harness throws, so the suite
 * fails loudly. Set `LITE_SKIP_DOCKER_TESTS=1` to opt out explicitly; the
 * opt-out is printed and the dependent tests report as skipped.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

export const PGVECTOR_TEST_IMAGE =
  'pgvector/pgvector:0.8.2-pg16-bookworm@sha256:6f2fedef8e4311682b3a5989a21bf527d3310ab5421258ad6e41e52955c16294';

const LABEL = 'io.psfn-lite.test-harness';
const OPT_OUT_ENV = 'LITE_SKIP_DOCKER_TESTS';
const READY_ATTEMPTS = 120;
const READY_DELAY_MS = 250;

/** Container start plus readiness, measured at ~2-4 s locally; 120 s leaves wide headroom. */
export const HARNESS_START_TIMEOUT_MS = 120_000;

export interface PostgresHarness {
  readonly containerName: string;
  /** Creates a fresh, empty database and returns its connection string. */
  createDatabase(): Promise<string>;
  stop(): void;
}

/** True when the operator explicitly opted out of docker-backed tests. Prints the opt-out. */
export function dockerTestsOptedOut(suite: string): boolean {
  if (process.env[OPT_OUT_ENV] !== '1') return false;
  // Written to stderr directly: the runner discards console output of files whose tests all skip.
  process.stderr.write(`[lite] ${OPT_OUT_ENV}=1: skipping docker-backed integration suite "${suite}"\n`);
  return true;
}

function docker(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error !== undefined) {
    throw new Error(`docker is unavailable (${result.error.message}); set ${OPT_OUT_ENV}=1 to skip integration tests explicitly`);
  }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function dockerOrThrow(args: readonly string[]): string {
  const result = docker(args);
  if (result.status !== 0) {
    throw new Error(`docker ${args[0] ?? ''} failed: ${result.stderr || result.stdout || 'unknown failure'}`);
  }
  return result.stdout;
}

const live = new Set<string>();
let exitHookInstalled = false;

function removeContainer(name: string): void {
  if (!live.delete(name)) return;
  // Exact name only; this container was created by this process.
  docker(['rm', '-f', name]);
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const name of [...live]) removeContainer(name);
  });
}

export async function startPostgresHarness(): Promise<PostgresHarness> {
  const version = docker(['version', '--format', '{{.Server.Version}}']);
  if (version.status !== 0) {
    throw new Error(`docker daemon is unavailable: ${version.stderr || version.stdout}; set ${OPT_OUT_ENV}=1 to skip explicitly`);
  }
  const token = randomBytes(6).toString('hex');
  const containerName = `lite-pg-${token}`;
  const password = randomBytes(12).toString('hex');
  installExitHook();
  dockerOrThrow([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--label',
    `${LABEL}=${token}`,
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--publish',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,size=512m',
    '--shm-size',
    '128m',
    PGVECTOR_TEST_IMAGE,
  ]);
  live.add(containerName);
  try {
    const port = parsePort(dockerOrThrow(['port', containerName, '5432/tcp']));
    const adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    await waitUntilReady(containerName, adminUrl);
    let counter = 0;
    return {
      containerName,
      async createDatabase() {
        counter += 1;
        const name = `lite_test_${counter}`;
        const admin = new pg.Client({ connectionString: adminUrl });
        await admin.connect();
        try {
          await admin.query(`CREATE DATABASE ${name}`);
        } finally {
          await admin.end();
        }
        return `postgres://postgres:${password}@127.0.0.1:${port}/${name}`;
      },
      stop: () => {
        removeContainer(containerName);
      },
    };
  } catch (error) {
    removeContainer(containerName);
    throw error;
  }
}

function parsePort(output: string): number {
  const match = /127\.0\.0\.1:(\d+)/.exec(output);
  const port = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`unexpected docker port output: ${output}`);
  return port;
}

/**
 * The image runs initdb with a socket-only server and then restarts it, so a
 * TCP `pg_isready` inside the container only succeeds against the final
 * server. A host-side query then confirms the published port works.
 */
async function waitUntilReady(containerName: string, adminUrl: string): Promise<void> {
  let lastError = 'not ready';
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    const ready = docker(['exec', containerName, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1']);
    if (ready.status === 0) {
      const client = new pg.Client({ connectionString: adminUrl });
      try {
        await client.connect();
        await client.query('SELECT 1');
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        await client.end().catch(() => undefined);
      }
    } else {
      lastError = ready.stdout || ready.stderr;
    }
    await delay(READY_DELAY_MS);
  }
  throw new Error(`postgres in ${containerName} did not become ready: ${lastError}`);
}
