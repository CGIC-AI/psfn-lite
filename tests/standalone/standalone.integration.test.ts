/**
 * The standalone CLI over a real PostgreSQL. `init` seeds the companion's
 * owner files; `once` runs one operator turn through the donor
 * SubstrateAgent. The donor runs one companion runtime per process, so the
 * restart case runs each start in its own child process (the CLI with the
 * test host ports) against the same database and data directory, and checks
 * that the second process's turn is assembled from the first one's archive.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEED_FILES } from '../../apps/standalone/src/index.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { COMPANION_NAME, DATABASE_URL_ENV, RUNTIME_TIMEOUT_MS, useLiteWorld } from '../support/lite-world.ts';

const REPO = join(import.meta.dirname, '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');

function run(entry: string, args: readonly string[], env: Record<string, string>) {
  return spawnSync(TSX, [entry, ...args], { cwd: REPO, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...env }, timeout: RUNTIME_TIMEOUT_MS });
}

describe.skipIf(dockerTestsOptedOut('standalone CLI'))('standalone CLI', () => {
  const lite = useLiteWorld();

  it('init seeds every owner file once and keeps the owner\'s own files', async () => {
    const install = await lite.install();
    for (const name of SEED_FILES) expect(existsSync(join(install.dataDir, `${name}.json`)), name).toBe(true);
    const policy = JSON.parse(readFileSync(join(install.dataDir, 'automata-policy.json'), 'utf8')) as { bus: { reviewer: { model: string } } };
    expect(policy.bus.reviewer.model).toBe('host-model');
    await writeFile(join(install.dataDir, 'settings.json'), '{"owned":true}\n');
    const again = await lite.cli(install, ['init', '--config', install.configPath]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`kept ${join(install.dataDir, 'settings.json')}`);
    expect(await readFile(join(install.dataDir, 'settings.json'), 'utf8')).toBe('{"owned":true}\n');
  }, RUNTIME_TIMEOUT_MS);

  it('once runs one operator turn through the donor agent, and a restart continues from the archive', async () => {
    const install = await lite.install();
    const callsFile = join(install.dataDir, 'calls.jsonl');
    const fixture = join(import.meta.dirname, 'fixtures', 'cli.ts');
    const env = { ...install.env, LITE_TEST_CALLS_FILE: callsFile };
    const first = run(fixture, ['once', '--config', install.configPath, '--text', 'MARK-1 I keep bees on the roof garden.', '--json'], { ...env, LITE_TEST_MARKER: 'MARK-1', LITE_TEST_REPLY: 'Bees on a roof, how lovely.' });
    expect(first.stderr).not.toContain('turn failed');
    expect(first.status).toBe(0);
    // The donor logger shares stdout; the JSON answer is its own block.
    expect(first.stdout).toContain(JSON.stringify({ reply: 'Bees on a roof, how lovely.', channelId: 'terminal:robin' }, null, 2));
    const firstCall = JSON.parse(readFileSync(callsFile, 'utf8').trim().split('\n')[0] ?? '{}') as { systemPrompt: string };
    expect(firstCall.systemPrompt).toContain(COMPANION_NAME);

    const second = run(fixture, ['once', '--config', install.configPath, '--text', 'MARK-2 What do I keep?'], { ...env, LITE_TEST_MARKER: 'MARK-2', LITE_TEST_REPLY: 'Bees.' });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('Bees.');
    const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.stringify((JSON.parse(line) as { messages: unknown }).messages));
    const seen = calls.find((messages) => messages.includes('MARK-2')) ?? '';
    expect(seen).toContain('I keep bees on the roof garden.');
    expect(seen).toContain('Bees on a roof, how lovely.');
  }, RUNTIME_TIMEOUT_MS);

  it('runs the real process entry: a missing secret is named, never shown, and an unreadable config is refused', async () => {
    const install = await lite.install();
    const document = { ...install.document, model: { provider: 'openai', modelId: 'gpt-4o', apiKeyEnv: 'LITE_TEST_MODEL_KEY', maxOutputTokens: 256 } };
    const configPath = join(install.dataDir, 'process.json');
    await writeFile(configPath, JSON.stringify(document));
    const main = join(REPO, 'apps', 'standalone', 'src', 'main.ts');
    const missing = run(main, ['once', '--config', configPath, '--text', 'hi'], { ...install.env });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('environment variable LITE_TEST_MODEL_KEY is not set');
    expect(missing.stderr).not.toContain(install.env[DATABASE_URL_ENV]);
    const unreadable = run(main, ['once', '--config', join(install.dataDir, 'absent.json'), '--text', 'hi'], {});
    expect(unreadable.status).toBe(2);
    expect(unreadable.stderr).toContain('cannot read the config file');
    const usage = run(main, ['tick', '--config', configPath], {});
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('unknown command tick');
  }, RUNTIME_TIMEOUT_MS);
});
