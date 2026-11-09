export const FILESYSTEM_READ_PAGE_CONTRACT = Object.freeze({
  minBytes: 1,
  defaultMaxBytes: 100_000,
  maxBytes: 200_000,
  maxOffsetBytes: Number.MAX_SAFE_INTEGER,
});

export function validateFilesystemReadMaxBytes(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < FILESYSTEM_READ_PAGE_CONTRACT.minBytes
    || value > FILESYSTEM_READ_PAGE_CONTRACT.maxBytes
  ) {
    throw new Error(
      `fsReadMaxBytes must be a safe integer between `
      + `${String(FILESYSTEM_READ_PAGE_CONTRACT.minBytes)} and `
      + `${String(FILESYSTEM_READ_PAGE_CONTRACT.maxBytes)}`,
    );
  }
  return value;
}

/**
 * Lite type copy (seam 3.11, extraction/cuts.tsv): verbatim from
 * boundary/integrations/filesystem/ops.ts:39-45 so the promoted text-file
 * paging helper (used by the journal integration) no longer names the cut
 * filesystem integration.
 */
export interface FilesystemReadResult {
  content: string;
  offsetBytes: number;
  nextOffsetBytes: number | null;
  eof: boolean;
  truncated: boolean;
}
