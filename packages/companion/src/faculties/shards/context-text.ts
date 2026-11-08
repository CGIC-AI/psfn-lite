// ── Shard context text bound ──
//
// Lite extraction (seam 3.17, shards cut). Subagent memory governance keeps the
// shard output review (output-review.ts, promoted), which bounds previews with
// this function. Its donor home, context-pack.ts, builds shard context packs
// from the gateway policy and stays outside the core.
//
// Copied verbatim from the donor at e6a9546:
// src/faculties/shards/context-pack.ts:382-388.

export function truncateShardContextText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}
