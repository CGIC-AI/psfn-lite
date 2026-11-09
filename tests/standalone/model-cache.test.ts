/**
 * The text-emotion model cache lives under the companion's data directory,
 * never in the working directory the host was started from. The donor's
 * seeded settings.json value is relative (`models/transformers`); the
 * 2026-11-09 shakedown downloaded the 478 MB model into the source checkout
 * through it. The substrate config is built here exactly as the runtime
 * builds it, from a data directory seeded by the real `init`.
 */
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DONOR_TEXT_EMOTION_CACHE_DIR, buildSubstrateConfig, parseLiteConfig, runCli, type CliIo } from '../../apps/standalone/src/index.ts';
import { COMPANION_SEED_DIR } from '../../apps/standalone/src/companion.ts';
import { liteConfigDocument } from '../support/lite-install.ts';

// The donor's default factories read their seeds from CONFIG_DIR, which the runtime points at the shipped seeds (runtime.ts).
process.env['CONFIG_DIR'] ??= fileURLToPath(COMPANION_SEED_DIR);
const MODEL = { modelId: 'faux-1', provider: 'faux', maxOutputTokens: 1024, contextWindow: 8192, registry: { models: [] } };

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

describe('text-emotion model cache', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  const seededInstall = async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lite-model-cache-'));
    dirs.push(dataDir);
    const document = liteConfigDocument(dataDir, crypto.randomUUID());
    const configPath = join(dataDir, 'lite.json');
    await writeFile(configPath, JSON.stringify(document));
    const io: CliIo = {
      stdout: () => undefined,
      stderr: () => undefined,
      env: {},
      readFile: (path) => readFile(path, 'utf8'),
      lines: async function* () {},
      onInterrupt: () => () => undefined,
    };
    expect(await runCli(['init', '--config', configPath], io)).toBe(0);
    const parsed = parseLiteConfig(document);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    return { dataDir, config: parsed.value };
  };
  const cacheDirOf = (config: Parameters<typeof buildSubstrateConfig>[0]) =>
    buildSubstrateConfig(config, { databaseUrl: 'postgres://unused', model: MODEL }).textEmotionCacheDir;

  it('the seeded relative setting resolves under the data directory, not the working directory', async () => {
    const { dataDir, config } = await seededInstall();
    const settings = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(settings['textEmotionCacheDir']).toBe(DONOR_TEXT_EMOTION_CACHE_DIR);
    const cacheDir = cacheDirOf(config);
    expect(cacheDir).toBe(join(dataDir, 'models', 'transformers'));
    expect(inside(process.cwd(), cacheDir ?? '')).toBe(false);
  });

  it('an owner\'s absolute setting is kept, and a removed one still defaults under the data directory', async () => {
    const { dataDir, config } = await seededInstall();
    const path = join(dataDir, 'settings.json');
    const settings = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const elsewhere = join(dataDir, 'shared-model-cache');
    await writeFile(path, JSON.stringify({ ...settings, textEmotionCacheDir: elsewhere }));
    expect(cacheDirOf(config)).toBe(elsewhere);
    const { textEmotionCacheDir: _removed, ...without } = settings;
    await writeFile(path, JSON.stringify(without));
    expect(cacheDirOf(config)).toBe(join(dataDir, 'models', 'transformers'));
  });
});
