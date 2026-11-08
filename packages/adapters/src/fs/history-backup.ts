/**
 * The canonical-history component of a continuity backup. Each session is
 * exported as its verified JSONL chain. The fingerprint commits to every
 * session's entry count and chain head, which in turn commit to every entry,
 * so a restore is proven equivalent in content, order and lineage. Import
 * verifies every backed-up chain and its fingerprint before installing the
 * first session, so a set that would not reproduce the backup installs nothing.
 */
import { createHash } from 'node:crypto';
import { invalid, ok, parseId, unavailable, type BackupComponentPort, type BackupFile, type Result, type SessionId } from '../core.ts';
import { parseChain, serializeChain } from './history-chain.ts';
import type { FileSessionArchive } from './session-archive.ts';

const FILE_PATTERN = /^sessions\/([^/]+)\.jsonl$/;

interface SessionSummary {
  readonly sessionId: SessionId;
  readonly count: number;
  readonly hash: string | null;
}

function fingerprintOf(sessions: readonly SessionSummary[]): string {
  const hash = createHash('sha256');
  for (const s of [...sessions].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))) {
    hash.update(`${s.sessionId}\t${String(s.count)}\t${s.hash ?? ''}\n`);
  }
  return hash.digest('hex');
}

export function createHistoryBackupComponent(archive: FileSessionArchive, name = 'history'): BackupComponentPort {
  const refuseDamage = (): Result<void> => {
    const damaged = archive.damaged();
    if (damaged.length === 0) return ok(undefined);
    return unavailable(`backup:${name}`, `history has damaged sessions (${damaged.map((d) => d.sessionId).join(', ')}); repair before backup`);
  };

  return {
    name,

    async fingerprint() {
      const healthy = refuseDamage();
      if (!healthy.ok) return healthy;
      const sessions: SessionSummary[] = [];
      for (const sessionId of archive.sessionIds()) {
        const head = await archive.head(sessionId);
        if (!head.ok) return head;
        sessions.push({ sessionId, count: head.value.count, hash: head.value.hash });
      }
      return ok(fingerprintOf(sessions));
    },

    isEmpty() {
      return Promise.resolve(ok(archive.sessionIds().length === 0));
    },

    async exportTo(store, prefix) {
      const healthy = refuseDamage();
      if (!healthy.ok) return healthy;
      const files: BackupFile[] = [];
      for (const sessionId of archive.sessionIds()) {
        const chain = archive.chain(sessionId);
        if (!chain.ok) return chain;
        const written = await store.write(`${prefix}sessions/${sessionId}.jsonl`, Buffer.from(serializeChain(chain.value)));
        if (!written.ok) return written;
        files.push(written.value);
      }
      return ok(files);
    },

    async importFrom(store, files, expectedFingerprint) {
      const prefix = `${name}/`;
      const staged: { sessionId: SessionId; bytes: Buffer }[] = [];
      const summaries: SessionSummary[] = [];
      for (const file of files) {
        const match = file.path.startsWith(prefix) ? FILE_PATTERN.exec(file.path.slice(prefix.length)) : null;
        const sessionId = parseId('session', match?.[1]);
        if (!sessionId.ok) return invalid(`unexpected history backup file ${file.path}`);
        if (staged.some((s) => s.sessionId === sessionId.value)) return invalid(`history backup lists session ${sessionId.value} twice`);
        const data = await store.read(file.path);
        if (!data.ok) return data;
        const bytes = Buffer.from(data.value);
        const parsed = parseChain(sessionId.value, bytes);
        if (parsed.kind !== 'intact') {
          return unavailable(`backup:${name}`, `backed-up history for ${sessionId.value} does not verify: ${parsed.kind === 'corrupt' ? parsed.detail : 'torn tail'}`);
        }
        const last = parsed.chain.at(-1);
        summaries.push({ sessionId: sessionId.value, count: last?.seq ?? 0, hash: last?.hash ?? null });
        staged.push({ sessionId: sessionId.value, bytes });
      }
      if (fingerprintOf(summaries) !== expectedFingerprint) {
        return unavailable(`backup:${name}`, 'backed-up history does not reproduce the backup fingerprint; nothing was installed');
      }
      for (const { sessionId, bytes } of staged) {
        const installed = await archive.install(sessionId, bytes);
        if (!installed.ok) return installed;
      }
      return ok(undefined);
    },
  };
}
