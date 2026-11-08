import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openFileSessionArchive, resolveStorageLayout, type StorageLayout } from '../../packages/adapters/src/index.ts';
import type { SessionId } from '../../packages/core/src/index.ts';
import { entry, layoutFor, openArchive, tempRoots } from './fs-support.ts';

const S1 = 's-1' as SessionId;
const S2 = 's-2' as SessionId;
const errorOf = (result: { ok: boolean; error?: unknown }) => (result.ok ? 'ok' : result.error);

describe('storage layout', () => {
  it('accepts disjoint roots and rejects equal, nested or symlinked-into roots', async () => {
    const roots = await tempRoots();
    expect((await resolveStorageLayout({ historyRoot: roots.history, workspaceRoot: roots.workspace })).ok).toBe(true);

    const same = await resolveStorageLayout({ historyRoot: roots.history, workspaceRoot: roots.history });
    expect(errorOf(same)).toMatchObject({ kind: 'invalid', issues: ['historyRoot and workspaceRoot are the same directory'] });

    const nested = join(roots.workspace, 'state');
    await mkdir(nested);
    expect(errorOf(await resolveStorageLayout({ historyRoot: nested, workspaceRoot: roots.workspace }))).toMatchObject({
      issues: ['historyRoot is inside workspaceRoot'],
    });
    expect(errorOf(await resolveStorageLayout({ historyRoot: roots.history, workspaceRoot: roots.base }))).toMatchObject({
      issues: ['historyRoot is inside workspaceRoot'],
    });

    // A symlink that looks separate but resolves inside the workspace is still rejected.
    const disguised = join(roots.base, 'looks-separate');
    await symlink(nested, disguised);
    expect(errorOf(await resolveStorageLayout({ historyRoot: disguised, workspaceRoot: roots.workspace }))).toMatchObject({ kind: 'invalid' });

    const credentials = join(roots.history, 'creds');
    await mkdir(credentials);
    expect(
      errorOf(await resolveStorageLayout({ historyRoot: roots.history, workspaceRoot: roots.workspace, credentialsRoot: credentials })),
    ).toMatchObject({ issues: ['credentialsRoot is inside historyRoot'] });
    expect(errorOf(await resolveStorageLayout({ historyRoot: join(roots.base, 'missing'), workspaceRoot: roots.workspace }))).toMatchObject({
      kind: 'invalid',
    });
  });

  it('refuses to open history from a layout that was not resolved', async () => {
    const roots = await tempRoots();
    const forged: StorageLayout = { historyRoot: roots.history, workspaceRoot: roots.history, credentialsRoot: null, backupRoot: null };
    expect(errorOf(await openFileSessionArchive(forged))).toMatchObject({ kind: 'invalid' });
  });
});

describe('JSONL session archive', () => {
  it('appends durably, reads back in order and survives reopening', async () => {
    const roots = await tempRoots();
    const layout = await layoutFor(roots);
    const archive = await openArchive(layout);
    expect((await archive.append([entry(S1, 1), entry(S1, 2)])).ok).toBe(true);
    expect((await archive.append([entry(S2, 1)])).ok).toBe(true);
    const head = await archive.head(S1);
    expect(head.ok && head.value.count).toBe(2);
    await archive.close();

    const reopened = await openArchive(layout);
    const range = await reopened.readRange(S1, 2, 10);
    expect(range.ok && range.value.map((a) => [a.seq, a.entry.text])).toEqual([[2, 'entry 2']]);
    expect((await reopened.head(S1)).ok && (await reopened.head(S1))).toEqual(head);
    const tail = await reopened.readTail(S1, 1);
    expect(tail.ok && tail.value.map((e) => e.text)).toEqual(['entry 2']);
    expect(reopened.sessionIds()).toEqual([S1, S2]);
    expect(reopened.repairs).toEqual([]);
  });

  it('treats re-appended identical entries as no-ops and refuses changed ones without writing', async () => {
    const roots = await tempRoots();
    const archive = await openArchive(await layoutFor(roots));
    await archive.append([entry(S1, 1)]);
    expect((await archive.append([entry(S1, 1), entry(S1, 2)])).ok).toBe(true);
    const changed = await archive.append([entry(S1, 3), entry(S1, 1, 'rewritten')]);
    expect(errorOf(changed)).toMatchObject({ kind: 'conflict', reason: 'entry_mismatch' });
    const head = await archive.head(S1);
    expect(head.ok && head.value.count).toBe(2);
    const lines = (await readFile(join(roots.history, 'sessions', `${S1}.jsonl`), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(errorOf(await archive.append([entry(S1, 4), entry(S2, 1)]))).toMatchObject({ kind: 'invalid' });
  });

  it('serializes concurrent appends into one verified chain', async () => {
    const roots = await tempRoots();
    const layout = await layoutFor(roots);
    const archive = await openArchive(layout);
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => archive.append([entry(S1, i + 1)])));
    expect(results.every((r) => r.ok)).toBe(true);
    await archive.close();
    const reopened = await openArchive(layout);
    const range = await reopened.readRange(S1, 1, 100);
    expect(range.ok && range.value.map((a) => a.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('quarantines a torn trailing append and keeps the verified prefix writable', async () => {
    const roots = await tempRoots();
    const layout = await layoutFor(roots);
    const archive = await openArchive(layout);
    await archive.append([entry(S1, 1), entry(S1, 2)]);
    await archive.close();
    const file = join(roots.history, 'sessions', `${S1}.jsonl`);
    // A crash in the middle of a write leaves an unterminated fragment.
    await appendFile(file, '{"entry":{"entryId":"s-1:turn-3:0","text":"half writ');

    const reopened = await openArchive(layout);
    expect(reopened.repairs).toHaveLength(1);
    expect(reopened.repairs[0]).toMatchObject({ sessionId: S1, keptEntries: 2 });
    const torn = (await readdir(join(roots.history, 'sessions'))).filter((name) => name.includes('.torn-'));
    expect(torn).toHaveLength(1);
    expect(await readFile(join(roots.history, 'sessions', torn[0] ?? ''), 'utf8')).toContain('half writ');
    expect((await reopened.append([entry(S1, 3)])).ok).toBe(true);
    const head = await reopened.head(S1);
    expect(head.ok && head.value.count).toBe(3);
  });

  it('refuses a session whose history was altered, without hiding the others', async () => {
    const roots = await tempRoots();
    const layout = await layoutFor(roots);
    const archive = await openArchive(layout);
    await archive.append([entry(S1, 1, 'I promised to call'), entry(S1, 2)]);
    await archive.append([entry(S2, 1)]);
    await archive.close();
    const file = join(roots.history, 'sessions', `${S1}.jsonl`);
    await writeFile(file, (await readFile(file, 'utf8')).replace('I promised to call', 'I never promised'));

    const reopened = await openArchive(layout);
    expect(reopened.damaged()).toEqual([{ sessionId: S1, detail: 'line 1: hash does not match content' }]);
    for (const result of [await reopened.head(S1), await reopened.readTail(S1, 5), await reopened.append([entry(S1, 3)])]) {
      expect(errorOf(result)).toMatchObject({ kind: 'unavailable', capability: 'session_archive' });
    }
    const other = await reopened.head(S2);
    expect(other.ok && other.value.count).toBe(1);
  });

  it('detects a dropped middle line as a chain break', async () => {
    const roots = await tempRoots();
    const layout = await layoutFor(roots);
    const archive = await openArchive(layout);
    await archive.append([entry(S1, 1), entry(S1, 2), entry(S1, 3)]);
    await archive.close();
    const file = join(roots.history, 'sessions', `${S1}.jsonl`);
    const lines = (await readFile(file, 'utf8')).split('\n');
    await writeFile(file, [lines[0], lines[2], ''].join('\n'));
    const reopened = await openArchive(layout);
    expect(reopened.damaged()[0]?.detail).toMatch(/^line 2: /);
  });

  it('holds an exclusive lock and takes over one left by a dead process', async () => {
    const roots = await tempRoots();
    const layout = await layoutFor(roots);
    const archive = await openArchive(layout);
    expect(errorOf(await openFileSessionArchive(layout))).toMatchObject({ kind: 'conflict' });
    await archive.close();
    expect(errorOf(await archive.head(S1))).toMatchObject({ kind: 'unavailable', detail: 'archive is closed' });

    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    expect(dead).toBeGreaterThan(0);
    await writeFile(join(roots.history, 'archive.lock'), `${String(dead)}\n`);
    expect((await openArchive(layout)).sessionIds()).toEqual([]);
  });

  it('takes over a stale lock carrying its own pid, as a restarted pid-1 container leaves it', async () => {
    const roots = await tempRoots();
    const layout = await layoutFor(roots);
    await writeFile(join(roots.history, 'archive.lock'), `${String(process.pid)}\n`);
    const archive = await openArchive(layout);
    expect(archive.sessionIds()).toEqual([]);
    // The lock this process does hold is still exclusive.
    expect(errorOf(await openFileSessionArchive(layout))).toMatchObject({ kind: 'conflict', reason: 'already_exists' });
    await archive.close();
    expect((await openArchive(layout)).sessionIds()).toEqual([]);
  });
});
