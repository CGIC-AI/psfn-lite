/**
 * Where durable state lives on disk. Canonical history, the agent workspace,
 * credentials and backups are separate roots: none may equal or contain
 * another, so a workspace cleanup, a harness reset or a backup sweep can never
 * reach into lived history, and history never sits beside credentials.
 */
import { realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { invalid, ok, type Result } from '../core.ts';

export interface StorageRootsInput {
  /** Canonical JSONL history. Owned by the companion, never by a harness. */
  readonly historyRoot: string;
  /** Agent workspace files. Disposable relative to history. */
  readonly workspaceRoot: string;
  /** Host credentials, when kept on disk. */
  readonly credentialsRoot?: string;
  /** Backup sets. */
  readonly backupRoot?: string;
}

export interface StorageLayout {
  readonly historyRoot: string;
  readonly workspaceRoot: string;
  readonly credentialsRoot: string | null;
  readonly backupRoot: string | null;
}

const issued = new WeakSet<StorageLayout>();

/** True only for a layout produced by `resolveStorageLayout`. */
export function isResolvedLayout(layout: StorageLayout): boolean {
  return issued.has(layout);
}

/**
 * Resolves every root through symlinks and rejects a layout where two roots
 * coincide or nest. Every root must already exist as a directory.
 */
export async function resolveStorageLayout(input: StorageRootsInput): Promise<Result<StorageLayout>> {
  const named: [string, string][] = [
    ['historyRoot', input.historyRoot],
    ['workspaceRoot', input.workspaceRoot],
  ];
  if (input.credentialsRoot !== undefined) named.push(['credentialsRoot', input.credentialsRoot]);
  if (input.backupRoot !== undefined) named.push(['backupRoot', input.backupRoot]);

  const resolved = new Map<string, string>();
  for (const [name, path] of named) {
    if (path.trim() === '') return invalid(`${name} must be a non-empty path`);
    try {
      const real = await realpath(path);
      if (!(await stat(real)).isDirectory()) return invalid(`${name} must be a directory`);
      resolved.set(name, real);
    } catch {
      return invalid(`${name} does not exist or cannot be resolved`);
    }
  }
  const entries = [...resolved.entries()];
  const issues: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [nameA, a] = entries[i] as [string, string];
      const [nameB, b] = entries[j] as [string, string];
      if (a === b) issues.push(`${nameA} and ${nameB} are the same directory`);
      else if (contains(a, b)) issues.push(`${nameB} is inside ${nameA}`);
      else if (contains(b, a)) issues.push(`${nameA} is inside ${nameB}`);
    }
  }
  if (issues.length > 0) return invalid(...issues);
  const layout: StorageLayout = Object.freeze({
    historyRoot: resolved.get('historyRoot') as string,
    workspaceRoot: resolved.get('workspaceRoot') as string,
    credentialsRoot: resolved.get('credentialsRoot') ?? null,
    backupRoot: resolved.get('backupRoot') ?? null,
  });
  issued.add(layout);
  return ok(layout);
}

function contains(parent: string, child: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}
