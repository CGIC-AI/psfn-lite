/** Temporary storage roots and synthetic history for adapter tests. Every path is under os.tmpdir(). */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { openFileSessionArchive, resolveStorageLayout, type FileSessionArchive, type StorageLayout } from '../../packages/adapters/src/index.ts';
import type { SessionEntry, SessionId, TurnId } from '../../packages/core/src/index.ts';

const created: string[] = [];
const opened: FileSessionArchive[] = [];

afterEach(async () => {
  for (const archive of opened.splice(0)) await archive.close();
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

export interface TempRoots {
  readonly base: string;
  readonly history: string;
  readonly workspace: string;
  readonly backups: string;
}

/** A fresh temporary directory with separate history, workspace and backup roots. */
export async function tempRoots(): Promise<TempRoots> {
  const base = await mkdtemp(join(tmpdir(), 'lite-adapters-'));
  created.push(base);
  const roots = { base, history: join(base, 'history'), workspace: join(base, 'workspace'), backups: join(base, 'backups') };
  for (const dir of [roots.history, roots.workspace, roots.backups]) await mkdir(dir);
  return roots;
}

export async function layoutFor(roots: Pick<TempRoots, 'history' | 'workspace' | 'backups'>): Promise<StorageLayout> {
  const layout = await resolveStorageLayout({ historyRoot: roots.history, workspaceRoot: roots.workspace, backupRoot: roots.backups });
  if (!layout.ok) throw new Error(JSON.stringify(layout.error));
  return layout.value;
}

/** Opens an archive that is closed automatically after the test. */
export async function openArchive(layout: StorageLayout): Promise<FileSessionArchive> {
  const archive = await openFileSessionArchive(layout);
  if (!archive.ok) throw new Error(JSON.stringify(archive.error));
  opened.push(archive.value);
  return archive.value;
}

export function entry(sessionId: string, n: number, text = `entry ${String(n)}`): SessionEntry {
  return {
    entryId: `${sessionId}:turn-${String(n)}:0`,
    sessionId: sessionId as SessionId,
    turnId: `turn-${String(n)}` as TurnId,
    origin: { kind: 'companion_speech' },
    text,
    at: `2030-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
  };
}
