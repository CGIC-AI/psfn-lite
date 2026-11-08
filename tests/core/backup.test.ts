import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  conflict,
  notFound,
  ok,
  createContinuityBackup,
  type BackupComponentPort,
  type BackupFile,
  type BackupStorePort,
  type Result,
} from '../../packages/core/src/index.ts';
import { FixedClock } from './fakes.ts';

class MemoryBackupStore implements BackupStorePort {
  readonly files = new Map<string, Uint8Array>();
  write(path: string, data: Uint8Array): Promise<Result<BackupFile>> {
    if (this.files.has(path)) return Promise.resolve(conflict('already_exists', path));
    this.files.set(path, data);
    return this.digest(path);
  }
  read(path: string): Promise<Result<Uint8Array>> {
    const data = this.files.get(path);
    return Promise.resolve(data === undefined ? notFound(path) : ok(data));
  }
  digest(path: string): Promise<Result<BackupFile>> {
    const data = this.files.get(path);
    if (data === undefined) return Promise.resolve(notFound(path));
    return Promise.resolve(ok({ path, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength }));
  }
}

class MemoryComponent implements BackupComponentPort {
  constructor(
    readonly name: string,
    public rows: string[] = [],
  ) {}
  imports = 0;
  mutateDuringExport = false;
  fingerprint(): Promise<Result<string>> {
    return Promise.resolve(ok(createHash('sha256').update(this.rows.join('\n')).digest('hex')));
  }
  isEmpty(): Promise<Result<boolean>> {
    return Promise.resolve(ok(this.rows.length === 0));
  }
  async exportTo(store: BackupStorePort, prefix: string): Promise<Result<readonly BackupFile[]>> {
    const written = await store.write(`${prefix}rows.jsonl`, new TextEncoder().encode(this.rows.join('\n')));
    if (this.mutateDuringExport) this.rows.push('late write');
    return written.ok ? ok([written.value]) : written;
  }
  async importFrom(store: BackupStorePort, files: readonly BackupFile[]): Promise<Result<void>> {
    this.imports += 1;
    for (const file of files) {
      const data = await store.read(file.path);
      if (!data.ok) return data;
      this.rows = new TextDecoder().decode(data.value).split('\n');
    }
    return ok(undefined);
  }
}

function backupOf(components: BackupComponentPort[]) {
  const created = createContinuityBackup({ components, clock: new FixedClock() });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return created.value;
}

describe('continuity backup use case', () => {
  it('round-trips every component and proves the restored fingerprints', async () => {
    const store = new MemoryBackupStore();
    const manifest = await backupOf([new MemoryComponent('history', ['a', 'b']), new MemoryComponent('state', ['c'])]).backup(store);
    expect(manifest.ok && manifest.value.components.map((c) => c.name)).toEqual(['history', 'state']);
    const history = new MemoryComponent('history');
    const state = new MemoryComponent('state');
    const restored = await backupOf([history, state]).restore(store);
    expect(restored.ok).toBe(true);
    expect([history.rows, state.rows]).toEqual([['a', 'b'], ['c']]);
  });

  it('verifies the whole set before writing anything and refuses non-empty targets', async () => {
    const store = new MemoryBackupStore();
    await backupOf([new MemoryComponent('history', ['a']), new MemoryComponent('state', ['c'])]).backup(store);
    store.files.set('state/rows.jsonl', new TextEncoder().encode('tampered'));
    const history = new MemoryComponent('history');
    const tampered = await backupOf([history, new MemoryComponent('state')]).restore(store);
    expect(tampered.ok || tampered.error).toMatchObject({ kind: 'unavailable', capability: 'backup_set' });
    expect(history.imports).toBe(0);

    const clean = new MemoryBackupStore();
    await backupOf([new MemoryComponent('history', ['a']), new MemoryComponent('state', ['c'])]).backup(clean);
    const occupied = await backupOf([new MemoryComponent('history'), new MemoryComponent('state', ['existing'])]).restore(clean);
    expect(occupied.ok || occupied.error).toMatchObject({ kind: 'conflict', reason: 'already_exists' });
    const partial = await backupOf([new MemoryComponent('history')]).restore(clean);
    expect(partial.ok || partial.error.kind).toBe('invalid');
  });

  it('refuses a set whose component changed during export, and a forged manifest', async () => {
    const moving = new MemoryComponent('history', ['a']);
    moving.mutateDuringExport = true;
    const store = new MemoryBackupStore();
    const result = await backupOf([moving]).backup(store);
    expect(result.ok || result.error).toMatchObject({ kind: 'conflict' });

    // A write landing in an earlier component after its export but before a later component's
    // export (a turn in the ledger, missing from history) must not produce a set.
    const history = new MemoryComponent('history', ['turn 1']);
    const state = new MemoryComponent('state', ['turn 1']);
    const exportState = state.exportTo.bind(state);
    state.exportTo = async (target, prefix) => {
      // History was already exported and re-fingerprinted under a per-component check.
      history.rows.push('turn 2');
      return exportState(target, prefix);
    };
    const skewed = new MemoryBackupStore();
    const skew = await backupOf([history, state]).backup(skewed);
    expect(skew.ok || skew.error).toMatchObject({ kind: 'conflict', reason: 'stale_revision' });
    expect(skewed.files.has('manifest.json')).toBe(false);

    const sealed = new MemoryBackupStore();
    await backupOf([new MemoryComponent('history', ['a'])]).backup(sealed);
    sealed.files.set('manifest.json', new TextEncoder().encode('{"format":"psfn-lite-continuity-backup"}'));
    const forged = await backupOf([new MemoryComponent('history')]).verify(sealed);
    expect(forged.ok || forged.error).toMatchObject({ kind: 'unavailable', detail: 'manifest digest does not match' });
  });
});
