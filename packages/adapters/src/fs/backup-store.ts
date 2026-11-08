/**
 * A backup set as a directory of immutable files. Every write is atomic and
 * exclusive, so a set is never partially overwritten and a second backup into
 * the same directory is refused instead of mixing two sets.
 *
 * A set lives only directly under the layout's backup root, which
 * `resolveStorageLayout` has already proven disjoint from history, workspace
 * and credentials, so a full copy of private state can never land inside the
 * agent workspace or beside canonical history.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { conflict, invalid, notFound, ok, unavailable, type BackupFile, type BackupStorePort, type Result } from '../core.ts';
import { errorCode, errorMessage, writeNewFileAtomic } from './files.ts';
import { isResolvedLayout, type StorageLayout } from './layout.ts';

const CAPABILITY = 'backup_store';
const SET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function openFileBackupStore(layout: StorageLayout, setName: string): Promise<Result<BackupStorePort>> {
  if (!isResolvedLayout(layout)) return invalid('the backup store needs a layout from resolveStorageLayout');
  if (layout.backupRoot === null) return invalid('the storage layout has no backupRoot');
  if (!SET_NAME.test(setName) || setName.includes('..')) {
    return invalid('backup set name must be one path segment of letters, digits, ".", "_" or "-"');
  }
  const root = layout.backupRoot;
  const candidate = join(root, setName);
  let dir: string;
  try {
    await mkdir(candidate, { mode: 0o700 }).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    dir = await realpath(candidate);
  } catch (error) {
    return unavailable(CAPABILITY, `could not create backup set directory: ${errorMessage(error)}`);
  }
  // A pre-existing symlink must not redirect the set out of the backup root.
  if (dirname(dir) !== root) return invalid(`backup set ${setName} does not resolve directly under the backup root`);

  const resolve = (path: string): Result<string> => {
    const normal = normalize(path);
    if (path === '' || isAbsolute(path) || normal.split(sep).includes('..')) {
      return invalid(`backup path ${path} must stay inside the set`);
    }
    return ok(join(dir, normal));
  };

  const describe = (path: string, data: Uint8Array): BackupFile => ({
    path,
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.byteLength,
  });

  const read = async (path: string): Promise<Result<Uint8Array>> => {
    const target = resolve(path);
    if (!target.ok) return target;
    try {
      return ok(await readFile(target.value));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return notFound(`backup file ${path}`);
      return unavailable(CAPABILITY, `could not read ${path}: ${errorMessage(error)}`);
    }
  };

  return ok({
    async write(path, data) {
      const target = resolve(path);
      if (!target.ok) return target;
      try {
        await writeNewFileAtomic(target.value, data);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') return conflict('already_exists', `backup file ${path} already exists; backup sets are immutable`);
        return unavailable(CAPABILITY, `could not write ${path}: ${errorMessage(error)}`);
      }
      return ok(describe(path, data));
    },
    read,
    async digest(path) {
      const data = await read(path);
      if (!data.ok) return data;
      return ok(describe(path, data.value));
    },
  });
}
