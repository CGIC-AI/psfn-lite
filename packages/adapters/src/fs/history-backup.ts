/**
 * The canonical-history component of a continuity backup. Each session is
 * exported as its verified JSONL chain. The fingerprint commits to every
 * session's entry count and chain head, which in turn commit to every entry,
 * so a restore is proven equivalent in content, order and lineage.
 */
import { createHash } from 'node:crypto';
import { invalid, ok, parseId, unavailable, type BackupComponentPort, type BackupFile, type Result } from '../core.ts';
import { serializeChain } from './history-chain.ts';
import type { FileSessionArchive } from './session-archive.ts';

const FILE_PATTERN = /^sessions\/([^/]+)\.jsonl$/;

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
      const hash = createHash('sha256');
      for (const sessionId of archive.sessionIds()) {
        const head = await archive.head(sessionId);
        if (!head.ok) return head;
        hash.update(`${sessionId}\t${String(head.value.count)}\t${head.value.hash ?? ''}\n`);
      }
      return ok(hash.digest('hex'));
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

    async importFrom(store, files) {
      const prefix = `${name}/`;
      for (const file of files) {
        const match = file.path.startsWith(prefix) ? FILE_PATTERN.exec(file.path.slice(prefix.length)) : null;
        const sessionId = parseId('session', match?.[1]);
        if (!sessionId.ok) return invalid(`unexpected history backup file ${file.path}`);
        const data = await store.read(file.path);
        if (!data.ok) return data;
        const installed = await archive.install(sessionId.value, Buffer.from(data.value));
        if (!installed.ok) return installed;
      }
      return ok(undefined);
    },
  };
}
