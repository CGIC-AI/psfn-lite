import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations } from '../../packages/adapters/src/index.ts';

const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function dirWith(files: readonly string[]): Promise<URL> {
  const dir = await mkdtemp(join(tmpdir(), 'psfn-migrations-'));
  made.push(dir);
  for (const file of files) await writeFile(join(dir, file), `-- ${file}\n`);
  return pathToFileURL(`${dir}/`);
}

describe('migration numbering', () => {
  it('accepts a reserved gap left by a parallel lane, in version order', async () => {
    const loaded = loadMigrations(await dirWith(['0003_c.sql', '0001_a.sql']));
    expect(loaded.map((m) => m.version)).toEqual([1, 3]);
  });

  it('rejects a duplicate version, a first migration other than 0001 and a misnamed file', async () => {
    const duplicate = await dirWith(['0001_a.sql', '0001_b.sql']);
    const late = await dirWith(['0002_a.sql']);
    const misnamed = await dirWith(['0001_a.sql', '2_b.sql']);
    expect(() => loadMigrations(duplicate)).toThrow(/unique increasing/);
    expect(() => loadMigrations(late)).toThrow(/start at 0001/);
    expect(() => loadMigrations(misnamed)).toThrow(/NNNN_name/);
  });

  it('ships this lane at 0003 next to the base schema', () => {
    expect(loadMigrations().map((m) => `${String(m.version)}_${m.name}`)).toContain('3_self_state');
  });
});
