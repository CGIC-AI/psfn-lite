/**
 * Dependency and install footprint of an installed npm project: direct
 * dependencies by kind, lockfile entries, transitive packages (all, and
 * those a production install keeps), what is installed under node_modules
 * (packages, files, apparent bytes and allocated bytes) and the size of the
 * project's own TypeScript source.
 *
 * Run: tsx scripts/bench/footprint.ts [--project <dir>]... [--json]
 * With no --project it measures this repository. Each project must be
 * installed already (`npm ci`); nothing here installs, builds or runs it.
 * Measure the donor from a throwaway clone at its pinned revision (see
 * docs/footprint.md), never from a working tree.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Footprint {
  readonly project: string;
  readonly name: string;
  readonly direct: { readonly dependencies: number; readonly devDependencies: number; readonly optionalDependencies: number; readonly peerDependencies: number };
  readonly lockfile: { readonly entries: number; readonly packages: number; readonly production: number; readonly dev: number; readonly optional: number; readonly links: number };
  readonly installed: { readonly packages: number; readonly files: number; readonly apparentBytes: number; readonly allocatedBytes: number };
  /** The project's own TypeScript under its source roots, tests (`*.test.ts`, `*.spec.ts`, test-support and tests directories) apart. */
  readonly source: { readonly files: number; readonly lines: number; readonly testFiles: number; readonly testLines: number; readonly roots: readonly string[] };
}

interface LockEntry {
  readonly dev?: boolean;
  readonly optional?: boolean;
  readonly devOptional?: boolean;
  readonly link?: boolean;
}

/** Directories holding the project's own TypeScript: whichever of these exist. */
const SOURCE_ROOTS = ['src', 'packages', 'apps', 'integrations'];

function measure(project: string): Footprint {
  const root = resolve(project);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  const count = (key: string) => Object.keys((manifest[key] as Record<string, string> | undefined) ?? {}).length;
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { readonly packages: Readonly<Record<string, LockEntry>> };
  const entries = Object.entries(lock.packages).filter(([key]) => key !== '');
  const packages = entries.filter(([key, entry]) => key.includes('node_modules/') && entry.link !== true);
  const modules = walk(join(root, 'node_modules'), true);
  const roots = SOURCE_ROOTS.filter((dir) => isDirectory(join(root, dir)));
  const typescript = roots.flatMap((dir) => walk(join(root, dir), false).paths.filter((p) => /\.(ts|mts|cts)$/.test(p) && !p.endsWith('.d.ts')));
  const isTest = (p: string) => /\.(test|spec)\.(ts|mts|cts)$/.test(p) || /\/(tests?|test-support|__tests__)\//.test(p.slice(root.length));
  const lines = (paths: readonly string[]) => paths.reduce((n, p) => n + readFileSync(p, 'utf8').split('\n').length, 0);
  const source = typescript.filter((p) => !isTest(p));
  const tests = typescript.filter(isTest);
  return {
    project: root,
    name: String(manifest['name']),
    direct: { dependencies: count('dependencies'), devDependencies: count('devDependencies'), optionalDependencies: count('optionalDependencies'), peerDependencies: count('peerDependencies') },
    lockfile: {
      entries: entries.length,
      packages: packages.length,
      production: packages.filter(([, e]) => e.dev !== true && e.devOptional !== true).length,
      dev: packages.filter(([, e]) => e.dev === true || e.devOptional === true).length,
      optional: packages.filter(([, e]) => e.optional === true || e.devOptional === true).length,
      links: entries.filter(([, e]) => e.link === true).length,
    },
    installed: { packages: modules.packages, files: modules.files, apparentBytes: modules.apparentBytes, allocatedBytes: modules.allocatedBytes },
    source: { files: source.length, lines: lines(source), testFiles: tests.length, testLines: lines(tests), roots },
  };
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

const SKIPPED_SOURCE_DIRS = new Set(['node_modules', '.git', '.venv', 'dist', 'coverage', '__pycache__']);

/** Walks without following symlinks; counts a package wherever a package.json sits directly under a node_modules entry. */
function walk(dir: string, modules: boolean): { paths: string[]; files: number; apparentBytes: number; allocatedBytes: number; packages: number } {
  const out = { paths: [] as string[], files: 0, apparentBytes: 0, allocatedBytes: 0, packages: 0 };
  const visit = (path: string, parentIsModules: boolean) => {
    const stat = lstatSync(path, { bigint: false });
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const names = readdirSync(path);
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (!modules && SKIPPED_SOURCE_DIRS.has(name)) return;
      if (modules && parentIsModules && !name.startsWith('.') && names.includes('package.json')) out.packages += 1;
      for (const child of names) {
        // A scope directory (@scope) holds packages one level down.
        const childIsModules = name === 'node_modules' || (parentIsModules && name.startsWith('@'));
        visit(join(path, child), childIsModules);
      }
      return;
    }
    out.files += 1;
    out.apparentBytes += stat.size;
    out.allocatedBytes += stat.blocks * 512;
    if (!modules) out.paths.push(path);
  };
  if (isDirectory(dir)) {
    for (const child of readdirSync(dir)) visit(join(dir, child), modules);
  }
  return out;
}

const mib = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MiB`;

function table(rows: readonly Footprint[]): string {
  const line = (label: string, pick: (f: Footprint) => string | number) => `| ${label} | ${rows.map((r) => String(pick(r))).join(' | ')} |`;
  return [
    `| | ${rows.map((r) => r.name).join(' | ')} |`,
    `|---|${rows.map(() => '---:').join('|')}|`,
    line('direct dependencies (prod / dev / optional)', (f) => `${String(f.direct.dependencies)} / ${String(f.direct.devDependencies)} / ${String(f.direct.optionalDependencies)}`),
    line('lockfile entries', (f) => f.lockfile.entries),
    line('transitive packages in the lockfile', (f) => f.lockfile.packages),
    line('of which a production install keeps', (f) => f.lockfile.production),
    line('installed packages under node_modules', (f) => f.installed.packages),
    line('files under node_modules', (f) => f.installed.files),
    line('node_modules apparent size', (f) => mib(f.installed.apparentBytes)),
    line('node_modules allocated on disk', (f) => mib(f.installed.allocatedBytes)),
    line(`own non-test TypeScript files (${rows.map((r) => r.source.roots.join('+')).join(' vs ')})`, (f) => f.source.files),
    line('own non-test TypeScript lines', (f) => f.source.lines),
  ].join('\n');
}

function main(argv: readonly string[]): void {
  const projects: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--project needs a directory');
      projects.push(next);
      i += 1;
    } else if (argv[i] !== '--json') {
      throw new Error(`unknown argument ${String(argv[i])}`);
    }
  }
  const rows = (projects.length === 0 ? [join(import.meta.dirname, '..', '..')] : projects).map(measure);
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(rows, null, 2)}\n` : `${table(rows)}\n`);
}

main(process.argv.slice(2));
