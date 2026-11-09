#!/usr/bin/env node
/**
 * Compares a Vitest JSON report of the extracted tree with the donor baseline.
 *
 *   npx vitest run --project companion --reporter=json --outputFile=/tmp/report.json
 *   node packages/companion/extraction/compare-baseline.mjs /tmp/report.json
 *
 * Every baseline test must appear in the report with the same status, except
 * the tests listed in extraction/deleted-tests.tsv (whole files with `*`).
 * Tests or files the baseline does not know are reported as additions, except
 * the Lite test files listed in extraction/added-tests.tsv, which are reported
 * separately and must run with no failure. Test names can repeat inside a file
 * (it.each), so names are compared as counts.
 * Exits 1 on any difference.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = process.argv[2];
if (reportPath === undefined) {
  console.error('usage: compare-baseline.mjs <vitest-json-report>');
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(join(here, '..', 'baseline.json'), 'utf8'));
const deleted = readFileSync(join(here, 'deleted-tests.tsv'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.startsWith('#'))
  .map((line) => line.split('\t'))
  .map(([file, test]) => ({ file, test }));
const deletedFile = new Set(deleted.filter((d) => d.test === '*').map((d) => d.file));
const deletedTest = new Set(deleted.filter((d) => d.test !== '*').map((d) => `${d.file}\u0000${d.test}`));
const added = new Set(readFileSync(join(here, 'added-tests.tsv'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.startsWith('#'))
  .map((line) => line.split('\t')[0]));

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const marker = '/packages/companion/';
const observed = new Map();
for (const result of report.testResults) {
  const at = result.name.indexOf(marker);
  if (at === -1) continue;
  const file = result.name.slice(at + marker.length);
  observed.set(file, result.assertionResults.map((a) => ({ name: a.fullName, status: a.status })));
}

const key = (name, status) => `${status}\u0000${name}`;
function counts(tests) {
  const out = new Map();
  for (const t of tests) out.set(key(t.name, t.status), (out.get(key(t.name, t.status)) ?? 0) + 1);
  return out;
}

const problems = [];
let compared = 0;
let skippedDeleted = 0;
for (const entry of baseline.files) {
  if (deletedFile.has(entry.file)) {
    skippedDeleted += entry.tests.length;
    if (observed.has(entry.file)) problems.push(`${entry.file}: listed as deleted but still runs`);
    continue;
  }
  const expected = entry.tests.filter((t) => {
    if (!deletedTest.has(`${entry.file}\u0000${t.name}`)) return true;
    skippedDeleted += 1;
    return false;
  });
  const got = observed.get(entry.file);
  if (got === undefined) {
    problems.push(`${entry.file}: missing from the report (${expected.length} baseline tests)`);
    continue;
  }
  const want = counts(expected);
  const have = counts(got.filter((t) => !deletedTest.has(`${entry.file}\u0000${t.name}`)));
  for (const [k, n] of want) {
    const m = have.get(k) ?? 0;
    const [status, name] = k.split('\u0000');
    if (m < n) problems.push(`${entry.file}: "${name}" expected ${status} x${n}, got x${m}${statusesOf(got, name)}`);
    compared += Math.min(m, n);
  }
  for (const [k, m] of have) {
    const n = want.get(k) ?? 0;
    const [status, name] = k.split('\u0000');
    if (m > n && !want.has(key(name, 'passed')) && !want.has(key(name, 'failed'))) problems.push(`${entry.file}: "${name}" ${status} is not in the baseline (addition)`);
  }
}
let addedTests = 0;
for (const [file, tests] of observed) {
  if (baseline.files.some((f) => f.file === file)) continue;
  if (!added.has(file)) {
    problems.push(`${file}: not in the baseline (addition)`);
    continue;
  }
  addedTests += tests.length;
  for (const t of tests) if (t.status !== 'passed') problems.push(`${file}: Lite test "${t.name}" ${t.status}`);
}
for (const file of added) {
  if (!observed.has(file)) problems.push(`${file}: listed in added-tests.tsv but missing from the report`);
}

function statusesOf(tests, name) {
  const s = tests.filter((t) => t.name === name).map((t) => t.status);
  return s.length === 0 ? ' (absent)' : ` (observed: ${s.join(', ')})`;
}

console.log(`baseline: ${baseline.totals.files} files / ${baseline.totals.tests} tests; deleted: ${deletedFile.size} files, ${skippedDeleted} tests; matched: ${compared}; Lite additions: ${added.size} files, ${addedTests} tests`);
if (problems.length > 0) {
  console.log(`${problems.length} difference(s):`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log('equivalent: every remaining baseline test has its baseline status');
