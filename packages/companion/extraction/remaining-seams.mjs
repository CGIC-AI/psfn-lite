#!/usr/bin/env node
/**
 * Lists the core tree's remaining imports of scaffolding (the seams Step B has
 * not cut yet).
 *
 *   node packages/companion/extraction/remaining-seams.mjs [--summary]
 *
 * Core = the Step A0 closure (closure-files.txt) minus the closure files a cut
 * moved out of the core (kind `cut` in vendored-files.txt, B5), plus donor
 * files promoted to core (kind `promoted`), plus Lite files added by seam cuts
 * (any non-test .ts under src/ that is in neither list). Scaffolding = kind
 * `scaffolding` or `cut` in vendored-files.txt. Only non-test .ts core files are
 * scanned; every relative import kind counts (value, type, re-export,
 * dynamic). Step B7 ends with this list empty.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = (f) => readFileSync(join(pkg, 'extraction', f), 'utf8').split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'));
const closure = new Set(lines('closure-files.txt'));
const vendored = new Map(lines('vendored-files.txt').map((l) => l.split('\t')).map(([k, f]) => [f, k]));
const scaffolding = new Set([...vendored].filter(([, k]) => k === 'scaffolding' || k === 'cut').map(([f]) => f));

function walk(dir) {
  return readdirSync(join(pkg, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}
const isTestish = (f) => /\.test\.ts$|\.test-fixtures\.ts$|\.test-support\.ts$|(^|\/)test-support\//.test(f);
const core = walk('src').filter((f) => f.endsWith('.ts') && !isTestish(f))
  .filter((f) => (closure.has(f) && vendored.get(f) !== 'cut') || vendored.get(f) === 'promoted' || !vendored.has(f));

const rx = /(?:import|export)\s+(type\s+)?(?:[\s\S]*?)\s+from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g;
const rows = [];
for (const f of core) {
  const src = readFileSync(join(pkg, f), 'utf8');
  for (const m of src.matchAll(rx)) {
    const spec = m[2] ?? m[3];
    if (!spec.startsWith('.')) continue;
    const target = normalize(join(dirname(f), spec)).replace(/\.js$/, '.ts');
    if (!scaffolding.has(target)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    rows.push([target, `${f}:${line}`, m[1] ? 'type' : (m[3] ? 'dynamic' : 'import')]);
  }
}
rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
if (process.argv.includes('--summary')) {
  const byArea = new Map();
  for (const [t] of rows) {
    const area = t.split('/').slice(1, 3).join('/');
    byArea.set(area, (byArea.get(area) ?? 0) + 1);
  }
  console.log(`${rows.length} statements into ${new Set(rows.map((r) => r[0])).size} scaffolding files`);
  for (const [a, n] of [...byArea].sort((x, y) => y[1] - x[1])) console.log(`${n}\t${a}`);
} else {
  console.log('# scaffolding target\tcore import site (file:line)\tkind');
  for (const r of rows) console.log(r.join('\t'));
}
