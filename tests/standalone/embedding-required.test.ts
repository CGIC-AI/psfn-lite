/**
 * `embedding.provider: disabled` with no host-supplied port: the real process
 * entry refuses to start by name, before any database, model or classifier
 * work, as the donor refused to start without an embedding provider
 * (faculties/memory/embedding.ts resolveEmbeddingProviderKind). The shakedown
 * of 2026-11-09 found `serve` reaching the donor's fail-closed startup warmup
 * instead ("embedding provider startup warmup failed"), because every other
 * test supplies `overrides.embeddings`. This one supplies no override at all.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EMBEDDING_PROVIDER_REQUIRED, createLiteRuntime, parseLiteConfig } from '../../apps/standalone/src/index.ts';
import { DATABASE_URL_ENV, SESSION_KEYS_ENV, liteConfigDocument, newSessionKeys } from '../support/lite-install.ts';

const REPO = join(import.meta.dirname, '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const MAIN = join(REPO, 'apps', 'standalone', 'src', 'main.ts');
/** A database URL nothing listens on: the refusal must come before any connection is tried. */
const UNREACHABLE_DATABASE = 'postgres://lite:unused@127.0.0.1:9/lite';

describe('embedding provider required', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it('serve with embedding.provider disabled and no overrides is refused by name, never at the startup warmup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lite-embedding-required-'));
    dirs.push(dataDir);
    const document = liteConfigDocument(dataDir, crypto.randomUUID());
    expect(document.embedding.provider).toEqual({ kind: 'disabled' });
    const configPath = join(dataDir, 'lite.json');
    await writeFile(configPath, JSON.stringify(document));
    const env = { PATH: process.env['PATH'] ?? '', [DATABASE_URL_ENV]: UNREACHABLE_DATABASE, [SESSION_KEYS_ENV]: newSessionKeys() };
    const run = spawnSync(TSX, [MAIN, 'serve', '--config', configPath], { cwd: dataDir, encoding: 'utf8', env, timeout: 60_000 });
    expect(run.stderr).toContain(EMBEDDING_PROVIDER_REQUIRED);
    expect(run.stderr).not.toContain('warmup');
    expect(run.status).toBe(1);
  }, 90_000);

  it('createLiteRuntime refuses it with an invalid result before building anything', async () => {
    const parsed = parseLiteConfig(liteConfigDocument('/srv/lite/data', crypto.randomUUID()));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    const refused = await createLiteRuntime({
      config: parsed.value,
      secrets: { databaseUrl: UNREACHABLE_DATABASE, modelApiKey: null, embeddingApiKey: null },
      env: {},
      onDiagnostic: () => undefined,
    });
    expect(refused).toEqual({ ok: false, error: { kind: 'invalid', issues: [EMBEDDING_PROVIDER_REQUIRED] } });
  });
});
