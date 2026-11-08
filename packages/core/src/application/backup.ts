import {
  conflict,
  invalid,
  isNonEmptyString,
  isRecord,
  ok,
  unavailable,
  type Clock,
  type Result,
} from '../shared/index.ts';

/** A file inside a backup set, with its content digest. */
export interface BackupFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Where a backup set lives. Writing an existing path is a conflict; sets are immutable. */
export interface BackupStorePort {
  write(path: string, data: Uint8Array): Promise<Result<BackupFile>>;
  read(path: string): Promise<Result<Uint8Array>>;
  digest(path: string): Promise<Result<BackupFile>>;
}

/**
 * One durable store taking part in the continuity backup (canonical history,
 * structured state). The fingerprint is a digest of its logical content, so
 * a restore can prove it reproduced exactly what was backed up.
 */
export interface BackupComponentPort {
  readonly name: string;
  fingerprint(): Promise<Result<string>>;
  isEmpty(): Promise<Result<boolean>>;
  exportTo(store: BackupStorePort, prefix: string): Promise<Result<readonly BackupFile[]>>;
  importFrom(store: BackupStorePort, files: readonly BackupFile[]): Promise<Result<void>>;
}

export const BACKUP_FORMAT = 'psfn-lite-continuity-backup';
export const BACKUP_FORMAT_VERSION = 1;
const MANIFEST = 'manifest.json';
const MANIFEST_DIGEST = 'manifest.sha256';

export interface BackupManifest {
  readonly format: typeof BACKUP_FORMAT;
  readonly formatVersion: typeof BACKUP_FORMAT_VERSION;
  readonly createdAt: string;
  readonly components: readonly { readonly name: string; readonly fingerprint: string; readonly files: readonly BackupFile[] }[];
}

export interface ContinuityBackup {
  /** Writes a complete set. Fails if any component changed while it was exported. */
  backup(store: BackupStorePort): Promise<Result<BackupManifest>>;
  /** Checks the manifest digest, the manifest and every file digest without writing anything. */
  verify(store: BackupStorePort): Promise<Result<BackupManifest>>;
  /**
   * Restores a verified set into empty targets only, then proves every
   * component's fingerprint matches the manifest. Nothing is written when the
   * set fails verification or any target already holds state.
   */
  restore(store: BackupStorePort): Promise<Result<BackupManifest>>;
}

/**
 * Complete continuity backup across every configured component. The charter
 * requires the full backup set, so the component list is fixed at creation
 * and a set naming different components is refused on restore.
 */
export function createContinuityBackup(deps: {
  readonly components: readonly BackupComponentPort[];
  readonly clock: Clock;
}): Result<ContinuityBackup> {
  const names = deps.components.map((c) => c.name);
  if (names.length === 0) return invalid('a continuity backup needs at least one component');
  if (new Set(names).size !== names.length || !names.every((n) => /^[a-z][a-z0-9_-]*$/.test(n))) {
    return invalid('backup component names must be unique lowercase identifiers');
  }

  const verify = async (store: BackupStorePort): Promise<Result<BackupManifest>> => {
    const recorded = await store.read(MANIFEST_DIGEST);
    if (!recorded.ok) return recorded;
    const digest = await store.digest(MANIFEST);
    if (!digest.ok) return digest;
    if (new TextDecoder().decode(recorded.value).trim() !== digest.value.sha256) return corrupt('manifest digest does not match');
    const raw = await store.read(MANIFEST);
    if (!raw.ok) return raw;
    const manifest = parseManifest(new TextDecoder().decode(raw.value));
    if (!manifest.ok) return manifest;
    const expected = [...names].sort();
    const actual = manifest.value.components.map((c) => c.name).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      return invalid(`backup set components ${actual.join(', ')} do not match the configured ${expected.join(', ')}`);
    }
    for (const component of manifest.value.components) {
      for (const file of component.files) {
        const found = await store.digest(file.path);
        if (!found.ok) return found;
        if (found.value.sha256 !== file.sha256 || found.value.bytes !== file.bytes) return corrupt(`file ${file.path} does not match its digest`);
      }
    }
    return manifest;
  };

  return ok({
    async backup(store) {
      const components: BackupManifest['components'][number][] = [];
      for (const component of deps.components) {
        const before = await component.fingerprint();
        if (!before.ok) return before;
        const files = await component.exportTo(store, `${component.name}/`);
        if (!files.ok) return files;
        const after = await component.fingerprint();
        if (!after.ok) return after;
        if (after.value !== before.value) return conflict('stale_revision', `${component.name} changed during backup; quiesce writers and retry`);
        components.push({ name: component.name, fingerprint: before.value, files: files.value });
      }
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: deps.clock.now().toISOString(),
        components,
      };
      const written = await store.write(MANIFEST, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
      if (!written.ok) return written;
      const sealed = await store.write(MANIFEST_DIGEST, new TextEncoder().encode(`${written.value.sha256}\n`));
      if (!sealed.ok) return sealed;
      return verify(store);
    },

    verify,

    async restore(store) {
      const manifest = await verify(store);
      if (!manifest.ok) return manifest;
      for (const component of deps.components) {
        const empty = await component.isEmpty();
        if (!empty.ok) return empty;
        if (!empty.value) return conflict('already_exists', `${component.name} already holds state; restore only into empty targets`);
      }
      for (const component of deps.components) {
        const entry = manifest.value.components.find((c) => c.name === component.name);
        if (entry === undefined) return corrupt(`manifest lost component ${component.name}`);
        const imported = await component.importFrom(store, entry.files);
        if (!imported.ok) return imported;
        const fingerprint = await component.fingerprint();
        if (!fingerprint.ok) return fingerprint;
        if (fingerprint.value !== entry.fingerprint) return unavailable(`backup:${component.name}`, 'restored content does not match the backup fingerprint');
      }
      return manifest;
    },
  });
}

function parseManifest(text: string): Result<BackupManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return corrupt('manifest is not JSON');
  }
  if (!isRecord(raw) || raw['format'] !== BACKUP_FORMAT) return invalid('not a PSFN Lite continuity backup');
  if (raw['formatVersion'] !== BACKUP_FORMAT_VERSION) return invalid(`unsupported backup format version ${String(raw['formatVersion'])}`);
  const createdAt = raw['createdAt'];
  const components = raw['components'];
  if (!isNonEmptyString(createdAt) || !Array.isArray(components)) return corrupt('manifest is incomplete');
  const parsed: BackupManifest['components'][number][] = [];
  for (const component of components) {
    if (!isRecord(component) || !isNonEmptyString(component['name']) || !isNonEmptyString(component['fingerprint'])) {
      return corrupt('manifest component is incomplete');
    }
    const files = component['files'];
    if (!Array.isArray(files)) return corrupt('manifest component has no file list');
    const parsedFiles: BackupFile[] = [];
    for (const file of files) {
      if (!isRecord(file) || !isNonEmptyString(file['path']) || !isNonEmptyString(file['sha256']) || typeof file['bytes'] !== 'number') {
        return corrupt('manifest file entry is incomplete');
      }
      if (!file['path'].startsWith(`${component['name']}/`) || file['path'].includes('..')) return corrupt(`file ${file['path']} is outside its component`);
      parsedFiles.push({ path: file['path'], sha256: file['sha256'], bytes: file['bytes'] });
    }
    parsed.push({ name: component['name'], fingerprint: component['fingerprint'], files: parsedFiles });
  }
  return ok({ format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, createdAt, components: parsed });
}

function corrupt(detail: string) {
  return unavailable('backup_set', detail);
}
