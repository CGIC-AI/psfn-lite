import { ok, type Result } from '../shared/index.ts';

/** Rows fetched per store page while collecting privacy-filtered results. */
export const SCAN_PAGE = 100;

/**
 * Collects up to `limit` rows that pass `keep`, paging the store until enough
 * are found or a short page shows it is exhausted. Privacy filtering happens
 * here, after the store's own predicates, so rows the viewer may not see are
 * skipped instead of cutting the result short. `limit` may be
 * `Number.POSITIVE_INFINITY` to collect every matching row.
 */
export async function collectPaged<T, C>(input: {
  readonly fetch: (after: C | null, pageSize: number) => Promise<Result<readonly T[]>>;
  readonly cursorOf: (row: T) => C;
  readonly keep: (row: T) => boolean;
  readonly limit: number;
}): Promise<Result<T[]>> {
  const kept: T[] = [];
  if (input.limit <= 0) return ok(kept);
  let after: C | null = null;
  for (;;) {
    const page = await input.fetch(after, SCAN_PAGE);
    if (!page.ok) return page;
    for (const row of page.value) {
      if (!input.keep(row)) continue;
      kept.push(row);
      if (kept.length >= input.limit) return ok(kept);
    }
    const last = page.value.at(-1);
    if (last === undefined || page.value.length < SCAN_PAGE) return ok(kept);
    after = input.cursorOf(last);
  }
}
