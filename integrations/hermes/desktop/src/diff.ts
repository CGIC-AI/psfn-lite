/** A line diff for the persona-layer diff: the longest common subsequence of lines. */

export interface DiffLine {
  readonly kind: 'same' | 'added' | 'removed';
  readonly text: string;
}

/** Above this many lines on either side the diff is shown as a whole replacement (the table is lines x lines). */
export const DIFF_LINE_LIMIT = 2_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length > DIFF_LINE_LIMIT || b.length > DIFF_LINE_LIMIT) {
    return [...a.map((text) => ({ kind: 'removed' as const, text })), ...b.map((text) => ({ kind: 'added' as const, text }))];
  }
  // lengths[i][j]: the common subsequence length of a[i..] and b[j..].
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = lengths[i] as number[];
    const below = lengths[i + 1] as number[];
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] as string });
      i += 1;
      j += 1;
    } else if ((lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0)) {
      out.push({ kind: 'removed', text: a[i] as string });
      i += 1;
    } else {
      out.push({ kind: 'added', text: b[j] as string });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) out.push({ kind: 'removed', text: a[i] as string });
  for (; j < b.length; j += 1) out.push({ kind: 'added', text: b[j] as string });
  return out;
}
