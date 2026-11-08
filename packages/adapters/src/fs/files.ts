/** Durable file primitives: fsync'd writes, exclusive creation, directory sync. */
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Flushes a directory entry so a created or renamed file survives a crash. */
export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeTemp(path: string, data: Uint8Array): Promise<string> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.tmp-${randomBytes(6).toString('hex')}`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}

/**
 * Writes a new file atomically and exclusively: readers see either nothing or
 * the complete content, and an existing file is never replaced. Throws an
 * `EEXIST` error when the path is taken.
 */
export async function writeNewFileAtomic(path: string, data: Uint8Array): Promise<void> {
  const temp = await writeTemp(path, data);
  try {
    await link(temp, path);
  } finally {
    await unlink(temp);
  }
  await syncDirectory(dirname(path));
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
