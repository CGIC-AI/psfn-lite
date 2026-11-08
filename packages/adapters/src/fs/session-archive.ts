/**
 * Canonical lived history as append-only JSONL, one file per session under
 * `<historyRoot>/sessions/`. Implements the core `SessionArchivePort`.
 *
 * - Append-only: entries are only ever added; each line hash-chains to the
 *   previous one, so any edit, reorder or truncation is detected on open.
 * - Durable: a batch is one write followed by fsync before success returns.
 * - Idempotent: re-appending an existing entry id with identical content is
 *   a no-op; with different content it is an `entry_mismatch` conflict.
 * - Crash repair: an unterminated trailing fragment (a torn append) is moved
 *   to a `.torn-*` file and the verified prefix kept. Anything else that fails
 *   to verify marks the session damaged, and every operation on it returns
 *   `unavailable` rather than serving partial history.
 * - Single writer: the root holds an exclusive lock file for the life of the
 *   archive; a lock left by a dead process is taken over.
 */
import { mkdir, open, readFile, readdir, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import {
  conflict,
  invalid,
  ok,
  parseId,
  unavailable,
  type ArchiveHead,
  type ArchivedEntry,
  type Result,
  type SessionArchivePort,
  type SessionEntry,
  type SessionId,
} from '../core.ts';
import { canonicalJson } from '../canonical-json.ts';
import { errorCode, errorMessage, syncDirectory, writeNewFileAtomic } from './files.ts';
import { chainHash, parseChain, serializeChain, serializeLine } from './history-chain.ts';
import { isResolvedLayout, type StorageLayout } from './layout.ts';

const SESSIONS_DIR = 'sessions';
const LOCK_FILE = 'archive.lock';
const SUFFIX = '.jsonl';

export interface ArchiveRepair {
  readonly sessionId: SessionId;
  readonly quarantinedTo: string;
  readonly keptEntries: number;
}

export interface ArchiveDamage {
  readonly sessionId: string;
  readonly detail: string;
}

export interface FileSessionArchive extends SessionArchivePort {
  /** Torn tails quarantined while opening. */
  readonly repairs: readonly ArchiveRepair[];
  /** Sessions that failed verification and are refused until an operator repairs them. */
  damaged(): readonly ArchiveDamage[];
  sessionIds(): readonly SessionId[];
  /** The complete verified chain of one session. */
  chain(sessionId: SessionId): Result<readonly ArchivedEntry[]>;
  /**
   * Installs a complete, already verified chain for a session that has no
   * history yet. Used by restore; refuses to touch an existing session.
   */
  install(sessionId: SessionId, bytes: Buffer): Promise<Result<void>>;
  close(): Promise<void>;
}

type SessionState =
  | { readonly kind: 'ready'; readonly chain: ArchivedEntry[]; readonly byId: Map<string, ArchivedEntry> }
  | { readonly kind: 'damaged'; readonly detail: string };

const CAPABILITY = 'session_archive';

export async function openFileSessionArchive(layout: StorageLayout): Promise<Result<FileSessionArchive>> {
  if (!isResolvedLayout(layout)) return invalid('the archive needs a layout from resolveStorageLayout');
  const root = layout.historyRoot;
  const dir = join(root, SESSIONS_DIR);
  const lockPath = join(root, LOCK_FILE);
  const locked = await acquireLock(lockPath);
  if (!locked.ok) return locked;

  const sessions = new Map<SessionId, SessionState>();
  const strays: ArchiveDamage[] = [];
  const repairs: ArchiveRepair[] = [];
  try {
    await mkdirDurable(root, dir);
    for (const name of await readdir(dir)) {
      if (!name.endsWith(SUFFIX)) continue;
      const parsedId = parseId('session', name.slice(0, -SUFFIX.length));
      if (!parsedId.ok) {
        strays.push({ sessionId: name, detail: 'file name is not a session id' });
        continue;
      }
      const sessionId = parsedId.value;
      const path = join(dir, name);
      const bytes = await readFile(path);
      const parsed = parseChain(sessionId, bytes);
      if (parsed.kind === 'corrupt') {
        sessions.set(sessionId, { kind: 'damaged', detail: parsed.detail });
        continue;
      }
      if (parsed.kind === 'torn') {
        const quarantinedTo = `${path}.torn-${Date.now()}`;
        await writeNewFileAtomic(quarantinedTo, bytes.subarray(parsed.validBytes));
        await truncate(path, parsed.validBytes);
        await syncFile(path);
        repairs.push({ sessionId, quarantinedTo, keptEntries: parsed.chain.length });
      }
      sessions.set(sessionId, ready(parsed.chain));
    }
  } catch (error) {
    await releaseLock(lockPath);
    return unavailable(CAPABILITY, `could not open history: ${errorMessage(error)}`);
  }

  const locks = new Map<SessionId, Promise<unknown>>();
  let closed = false;
  const serialize = <T>(sessionId: SessionId, run: () => Promise<T>): Promise<T> => {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(run, run);
    locks.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  };

  const stateOf = (sessionId: SessionId): Result<Extract<SessionState, { kind: 'ready' }> | null> => {
    if (closed) return unavailable(CAPABILITY, 'archive is closed');
    const state = sessions.get(sessionId);
    if (state === undefined) return ok(null);
    if (state.kind === 'damaged') return unavailable(CAPABILITY, `session ${sessionId} history failed verification: ${state.detail}`);
    return ok(state);
  };

  const pathOf = (sessionId: SessionId) => join(dir, `${sessionId}${SUFFIX}`);

  const appendBatch = async (sessionId: SessionId, entries: readonly SessionEntry[]): Promise<Result<void>> => {
    const current = stateOf(sessionId);
    if (!current.ok) return current;
    const chain = current.value?.chain ?? [];
    const byId = current.value?.byId ?? new Map<string, ArchivedEntry>();
    const fresh: ArchivedEntry[] = [];
    const pending = new Map<string, ArchivedEntry>();
    let prev = chain.at(-1)?.hash ?? '';
    for (const entry of entries) {
      const existing = byId.get(entry.entryId) ?? pending.get(entry.entryId);
      if (existing !== undefined) {
        if (canonicalJson(existing.entry) !== canonicalJson(entry)) {
          return conflict('entry_mismatch', `entry ${entry.entryId} already exists with different content`);
        }
        continue;
      }
      const archived: ArchivedEntry = { seq: chain.length + fresh.length + 1, hash: chainHash(prev, entry), entry };
      fresh.push(archived);
      pending.set(entry.entryId, archived);
      prev = archived.hash;
    }
    if (fresh.length === 0) return ok(undefined);

    let text = '';
    let linePrev = chain.at(-1)?.hash ?? '';
    for (const archived of fresh) {
      text += serializeLine(archived, linePrev);
      linePrev = archived.hash;
    }
    const path = pathOf(sessionId);
    const isNew = current.value === null;
    try {
      const handle = await open(path, 'a', 0o600);
      try {
        await handle.write(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (isNew) await syncDirectory(dir);
    } catch (error) {
      // The file may now end in a partial line; refuse the session until reopened and repaired.
      sessions.set(sessionId, { kind: 'damaged', detail: `append failed: ${errorMessage(error)}` });
      return unavailable(CAPABILITY, `could not append to session ${sessionId}: ${errorMessage(error)}`);
    }
    for (const archived of fresh) {
      chain.push(archived);
      byId.set(archived.entry.entryId, archived);
    }
    if (isNew) sessions.set(sessionId, { kind: 'ready', chain, byId });
    return ok(undefined);
  };

  const archive: FileSessionArchive = {
    repairs,

    damaged: () => [
      ...strays,
      ...[...sessions.entries()].flatMap(([sessionId, state]) => (state.kind === 'damaged' ? [{ sessionId, detail: state.detail }] : [])),
    ],

    sessionIds: () => [...sessions.keys()].sort(),

    chain(sessionId) {
      const state = stateOf(sessionId);
      if (!state.ok) return state;
      return ok(state.value?.chain.slice() ?? []);
    },

    append(entries) {
      if (entries.length === 0) return Promise.resolve(ok(undefined));
      const sessionId = (entries[0] as SessionEntry).sessionId;
      if (entries.some((e) => e.sessionId !== sessionId)) return Promise.resolve(invalid('one append covers exactly one session'));
      const parsedId = parseId('session', sessionId);
      if (!parsedId.ok) return Promise.resolve(parsedId);
      return serialize(sessionId, () => appendBatch(sessionId, entries));
    },

    readTail(sessionId, limit) {
      const state = stateOf(sessionId);
      if (!state.ok) return Promise.resolve(state);
      if (!Number.isInteger(limit) || limit < 0) return Promise.resolve(invalid('limit must be a non-negative integer'));
      const chain = state.value?.chain ?? [];
      return Promise.resolve(ok(limit === 0 ? [] : chain.slice(-limit).map((a) => a.entry)));
    },

    readRange(sessionId, fromSeq, limit) {
      const state = stateOf(sessionId);
      if (!state.ok) return Promise.resolve(state);
      if (!Number.isInteger(fromSeq) || fromSeq < 1 || !Number.isInteger(limit) || limit < 0) {
        return Promise.resolve(invalid('fromSeq must be >= 1 and limit a non-negative integer'));
      }
      return Promise.resolve(ok((state.value?.chain ?? []).slice(fromSeq - 1, fromSeq - 1 + limit)));
    },

    head(sessionId) {
      const state = stateOf(sessionId);
      if (!state.ok) return Promise.resolve(state);
      const last = state.value?.chain.at(-1);
      const head: ArchiveHead = { sessionId, count: last?.seq ?? 0, hash: last?.hash ?? null };
      return Promise.resolve(ok(head));
    },

    install(sessionId, bytes) {
      const parsedId = parseId('session', sessionId);
      if (!parsedId.ok) return Promise.resolve(parsedId);
      return serialize(sessionId, async () => {
        const current = stateOf(sessionId);
        if (!current.ok) return current;
        if (current.value !== null) return conflict('already_exists', `session ${sessionId} already has history`);
        const parsed = parseChain(sessionId, bytes);
        if (parsed.kind !== 'intact') {
          return unavailable(CAPABILITY, `history for ${sessionId} does not verify: ${parsed.kind === 'corrupt' ? parsed.detail : 'torn tail'}`);
        }
        try {
          await writeNewFileAtomic(pathOf(sessionId), Buffer.from(serializeChain(parsed.chain)));
        } catch (error) {
          if (errorCode(error) === 'EEXIST') return conflict('already_exists', `session ${sessionId} already has a history file`);
          return unavailable(CAPABILITY, `could not install session ${sessionId}: ${errorMessage(error)}`);
        }
        sessions.set(sessionId, ready(parsed.chain));
        return ok(undefined);
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...locks.values()]);
      await releaseLock(lockPath);
    },
  };
  return ok(archive);
}

function ready(chain: ArchivedEntry[]): SessionState {
  return { kind: 'ready', chain, byId: new Map(chain.map((a) => [a.entry.entryId, a])) };
}

async function mkdirDurable(root: string, dir: string): Promise<void> {
  try {
    await mkdir(dir, { mode: 0o700 });
    await syncDirectory(root);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Takes the root's exclusive lock, replacing one left by a process that no longer exists. */
async function acquireLock(lockPath: string): Promise<Result<void>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${String(process.pid)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return ok(undefined);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') return unavailable(CAPABILITY, `could not lock history: ${errorMessage(error)}`);
    }
    const holder = Number.parseInt((await readFile(lockPath, 'utf8').catch(() => '')).trim(), 10);
    if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) {
      return conflict('already_exists', `history is locked by running process ${String(holder)}`);
    }
    await rm(lockPath, { force: true });
  }
  return unavailable(CAPABILITY, 'could not take the history lock');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

