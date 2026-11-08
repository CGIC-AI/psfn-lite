import type { ArchiveHead, SessionArchivePort, TranscriptProjectionPort } from '../sessions/index.ts';
import { ok, type Result, type SessionId } from '../shared/index.ts';

const PROJECTION_PAGE = 500;

/**
 * Brings a session's keyword projection level with the canonical JSONL
 * history before anything is served from it (the donor's projection drift
 * contract, `src/persistence/sessions/transcript-projection-port.ts`). The
 * projection records the archive chain hash it reflects; a projection that is
 * ahead of the canon or whose hash disagrees with the canon at its position is
 * dropped and rebuilt. Any failure is returned, so search fails closed.
 */
export async function syncTranscriptProjection(
  archive: SessionArchivePort,
  projection: TranscriptProjectionPort,
  sessionId: SessionId,
): Promise<Result<ArchiveHead>> {
  const head = await archive.head(sessionId);
  if (!head.ok) return head;
  const mark = await projection.watermark(sessionId);
  if (!mark.ok) return mark;
  let watermark = mark.value;
  if (watermark.count === head.value.count && watermark.hash === head.value.hash) return ok(watermark);

  const consistent = await isPrefixOfCanon(archive, sessionId, watermark, head.value);
  if (!consistent.ok) return consistent;
  if (!consistent.value) {
    const reset = await projection.reset(sessionId);
    if (!reset.ok) return reset;
    watermark = { sessionId, count: 0, hash: null };
  }
  for (;;) {
    const page = await archive.readRange(sessionId, watermark.count + 1, PROJECTION_PAGE);
    if (!page.ok) return page;
    if (page.value.length === 0) return ok(watermark);
    const projected = await projection.project(sessionId, page.value, watermark);
    if (!projected.ok) return projected;
    watermark = projected.value;
  }
}

async function isPrefixOfCanon(
  archive: SessionArchivePort,
  sessionId: SessionId,
  watermark: ArchiveHead,
  head: ArchiveHead,
): Promise<Result<boolean>> {
  if (watermark.count === 0) return ok(true);
  if (watermark.count > head.count) return ok(false);
  const at = await archive.readRange(sessionId, watermark.count, 1);
  if (!at.ok) return at;
  return ok(at.value[0]?.hash === watermark.hash);
}
