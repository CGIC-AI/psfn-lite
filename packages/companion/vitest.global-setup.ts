/**
 * Per-run isolation for the donor Postgres harness
 * (src/test-support/postgres-test-harness.ts). The donor names its containers
 * from a fixed profile and reuses warm ones, which would touch containers other
 * checkouts own. Here every run gets its own profile, so container names are
 * new, and its own short TMPDIR, so the harness lock files are private (a short
 * path also keeps donor diagnostics that embed temp paths under their length
 * budgets).
 *
 * Teardown removes exactly the containers labelled with this run's profile.
 * A run that was killed never reaches teardown, so setup also removes the
 * containers and temp directories of earlier Lite runs whose process is gone:
 * only profiles of the form `lite-companion-<pid>-<token>`, which this file
 * alone creates, and only when <pid> is no longer running.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE_LABEL = 'io.test-harness.postgres.profile';
const PROFILE_PATTERN = /^lite-companion-(\d+)-[0-9a-f]+$/u;
const TMP_ROOT = '/tmp';
const TMP_PATTERN = /^lc-(\d+)-/u;

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function harnessContainers(): { name: string; profile: string }[] {
  const listed = spawnSync('docker', ['ps', '-a', '--filter', `label=${PROFILE_LABEL}`, '--format', `{{.Names}}\t{{.Label "${PROFILE_LABEL}"}}`], { encoding: 'utf8' });
  if (listed.error !== undefined || listed.status !== 0) return [];
  return listed.stdout
    .split('\n')
    .map((line) => line.trim().split('\t'))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== '' && parts[1] !== '')
    .map(([name, profile]) => ({ name, profile }));
}

function removeContainers(match: (profile: string) => boolean): void {
  for (const { name, profile } of harnessContainers()) {
    if (match(profile)) spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
  }
}

function reapAbandonedRuns(): void {
  removeContainers((profile) => {
    const pid = PROFILE_PATTERN.exec(profile)?.[1];
    return pid !== undefined && !running(Number(pid));
  });
  for (const entry of readdirSync(TMP_ROOT)) {
    const pid = TMP_PATTERN.exec(entry)?.[1];
    if (pid !== undefined && !running(Number(pid))) rmSync(join(TMP_ROOT, entry), { recursive: true, force: true });
  }
}

export default function setup(): () => void {
  reapAbandonedRuns();
  const profile = `lite-companion-${process.pid}-${randomBytes(6).toString('hex')}`;
  const tmp = mkdtempSync(join(TMP_ROOT, `lc-${process.pid}-`));
  process.env['PSFN_POSTGRES_TEST_PROFILE_OVERRIDE'] = profile;
  process.env['TMPDIR'] = tmp;
  return () => {
    removeContainers((candidate) => candidate === profile);
    rmSync(tmp, { recursive: true, force: true });
  };
}
