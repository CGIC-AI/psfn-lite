import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHistoryBackupComponent, openFileBackupStore } from '../../packages/adapters/src/index.ts';
import { createContinuityBackup, type BackupStorePort, type SessionId } from '../../packages/core/src/index.ts';
import { FixedClock } from '../core/fakes.ts';
import { entry, layoutFor, openArchive, tempRoots, type TempRoots } from './fs-support.ts';

const errorOf = (result: { ok: boolean; error?: unknown }) => (result.ok ? 'ok' : result.error);

async function store(dir: string): Promise<BackupStorePort> {
  const opened = await openFileBackupStore(dir);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  return opened.value;
}

async function archiveWithHistory(roots: TempRoots) {
  const archive = await openArchive(await layoutFor(roots));
  await archive.append([entry('s-1', 1, 'we met at the library'), entry('s-1', 2)]);
  await archive.append([entry('s-2', 1)]);
  return archive;
}

function backupOf(archive: Parameters<typeof createHistoryBackupComponent>[0]) {
  const created = createContinuityBackup({ components: [createHistoryBackupComponent(archive)], clock: new FixedClock() });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return created.value;
}

describe('file backup store and history component', () => {
  it('restores canonical history into a fresh root with identical chains', async () => {
    const source = await tempRoots();
    const archive = await archiveWithHistory(source);
    const set = await store(join(source.backups, 'set-1'));
    const made = await backupOf(archive).backup(set);
    expect(made.ok && made.value.components.map((c) => c.files.map((f) => f.path))).toEqual([
      ['history/sessions/s-1.jsonl', 'history/sessions/s-2.jsonl'],
    ]);

    const target = await tempRoots();
    const fresh = await openArchive(await layoutFor(target));
    const restored = await backupOf(fresh).restore(set);
    expect(restored.ok).toBe(true);
    for (const sessionId of ['s-1', 's-2'] as SessionId[]) {
      expect(await fresh.head(sessionId)).toEqual(await archive.head(sessionId));
      expect(await fresh.readRange(sessionId, 1, 10)).toEqual(await archive.readRange(sessionId, 1, 10));
    }
    // Restored history stays appendable and keeps its lineage.
    expect((await fresh.append([entry('s-1', 3)])).ok).toBe(true);
  });

  it('refuses to write into an existing set, to restore over history, or to restore a tampered set', async () => {
    const source = await tempRoots();
    const archive = await archiveWithHistory(source);
    const dir = join(source.backups, 'set-1');
    const set = await store(dir);
    await backupOf(archive).backup(set);
    expect(errorOf(await backupOf(archive).backup(set))).toMatchObject({ kind: 'conflict', reason: 'already_exists' });
    expect(errorOf(await backupOf(archive).restore(set))).toMatchObject({ kind: 'conflict', reason: 'already_exists' });

    const file = join(dir, 'history', 'sessions', 's-1.jsonl');
    await writeFile(file, (await readFile(file, 'utf8')).replace('library', 'station'));
    const target = await tempRoots();
    const fresh = await openArchive(await layoutFor(target));
    expect(errorOf(await backupOf(fresh).restore(set))).toMatchObject({ kind: 'unavailable', capability: 'backup_set' });
    expect(fresh.sessionIds()).toEqual([]);
  });

  it('keeps backup paths inside the set', async () => {
    const roots = await tempRoots();
    const set = await store(join(roots.backups, 'set-1'));
    expect(errorOf(await set.write('../escape.txt', new Uint8Array([1])))).toMatchObject({ kind: 'invalid' });
    expect(errorOf(await set.read('/etc/hostname'))).toMatchObject({ kind: 'invalid' });
    expect(errorOf(await set.read('missing.json'))).toMatchObject({ kind: 'not_found' });
  });
});
