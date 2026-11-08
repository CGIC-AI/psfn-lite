import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOMAINS } from '../../packages/core/src/index.ts';
import { checkCoreImports, type CoreSource } from './import-checker.ts';

const CORE_ROOT = join(import.meta.dirname, '..', '..', 'packages', 'core');
const CORE_SRC = join(CORE_ROOT, 'src');

function productionSources(): CoreSource[] {
  return readdirSync(CORE_SRC, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .map((entry) => ({
      path: relative(CORE_SRC, join(CORE_SRC, entry)).split(sep).join('/'),
      text: readFileSync(join(CORE_SRC, entry), 'utf8'),
    }));
}

/** Minimal well-formed file set the synthetic cases modify. */
function baseline(): CoreSource[] {
  return [
    { path: 'index.ts', text: "export * from './memory/index.ts';" },
    { path: 'shared/index.ts', text: "export * from './result.ts';" },
    { path: 'shared/result.ts', text: 'export type R = 1;' },
    { path: 'memory/index.ts', text: "export type { M } from './types.ts';" },
    { path: 'memory/types.ts', text: "import type { R } from '../shared/index.ts'; export type M = R;" },
    { path: 'contacts/index.ts', text: "export type { C } from './types.ts';" },
    { path: 'contacts/types.ts', text: 'export type C = 2;' },
    { path: 'application/index.ts', text: "export { run } from './run.ts';" },
    { path: 'application/run.ts', text: "import type { M } from '../memory/index.ts'; export const run = (m: M) => m;" },
  ];
}

const SYNTHETIC_DOMAINS = ['memory', 'contacts', 'episodes'];

function check(overrides: readonly CoreSource[]): string[] {
  const files = new Map(baseline().map((f) => [f.path, f]));
  for (const file of overrides) files.set(file.path, file);
  return checkCoreImports([...files.values()], SYNTHETIC_DOMAINS).map((v) => `${v.file}: ${v.rule}`);
}

describe('core import boundary', () => {
  it('scans the real package and finds no violations', () => {
    const files = productionSources();
    const paths = new Set(files.map((f) => f.path));
    expect(files.length).toBeGreaterThan(30);
    for (const layer of [...DOMAINS, 'shared', 'application']) {
      expect(paths.has(`${layer}/index.ts`), `${layer}/index.ts exists`).toBe(true);
    }
    expect(paths.has('index.ts')).toBe(true);
    expect(checkCoreImports(files, DOMAINS)).toEqual([]);
  });

  it('declares no package dependencies', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8'));
    expect(manifest).not.toHaveProperty('dependencies');
    expect(manifest).not.toHaveProperty('peerDependencies');
    expect(manifest).toMatchObject({ exports: { '.': './src/index.ts' } });
  });

  it('accepts the synthetic baseline, cross-domain index imports and node: builtins', () => {
    expect(check([])).toEqual([]);
    expect(
      check([
        {
          path: 'memory/types.ts',
          text: "import { createHash } from 'node:crypto'; import type { C } from '../contacts/index.ts'; export type M = C; void createHash;",
        },
      ]),
    ).toEqual([]);
  });

  it.each([
    ['deep cross-domain import', 'memory/types.ts', "import type { C } from '../contacts/types.ts'; export type M = C;", 'through contacts/index.ts'],
    ['type-only deep import', 'memory/types.ts', "import type { C } from '../contacts/types.ts';", 'through contacts/index.ts'],
    ['deep re-export from a domain index', 'memory/index.ts', "export * from '../contacts/types.ts';", 'through contacts/index.ts'],
    ['bare third-party package', 'memory/types.ts', "import { z } from 'zod';", 'outside packages/core'],
    ['unprefixed builtin', 'memory/types.ts', "import { readFileSync } from 'fs';", 'outside packages/core'],
    ['harness package', 'application/run.ts', "import { Agent } from '@mariozechner/pi-agent';", 'outside packages/core'],
    ['dynamic import', 'memory/types.ts', "export const load = () => import('pg');", 'outside packages/core'],
    ['import type node', 'memory/types.ts', "export type X = import('../contacts/types.ts').C;", 'through contacts/index.ts'],
    ['require call', 'memory/types.ts', "export const pg = require('pg');", 'outside packages/core'],
    ['escape from the package', 'memory/types.ts', "import '../../adapters/src/pg.ts';", 'escapes packages/core/src'],
    ['extensionless relative import', 'memory/types.ts', "import type { R } from '../shared/index';", 'must name a .ts file'],
    ['domain importing application', 'memory/types.ts', "import { run } from '../application/index.ts';", 'may not import application'],
    ['shared importing a domain', 'shared/result.ts', "import type { M } from '../memory/index.ts';", 'shared may import only shared'],
    ['application deep into a domain', 'application/run.ts', "import type { M } from '../memory/types.ts';", 'through memory/index.ts'],
    ['root deep re-export', 'index.ts', "export * from './memory/types.ts';", 'only layer index files'],
    ['non-literal specifier', 'memory/types.ts', 'const name = "pg"; export const load = () => import(name);', 'string literal'],
  ])('rejects %s', (_label, path, text, expected) => {
    const violations = check([{ path, text }]);
    expect(violations.some((v) => v.startsWith(`${path}: `) && v.includes(expected)), violations.join('\n')).toBe(true);
  });

  it('rejects files outside the known layers', () => {
    expect(check([{ path: 'adapters/pg.ts', text: 'export const x = 1;' }])).toContain('adapters/pg.ts: unknown module directory adapters');
  });

  it('rejects a domain dependency cycle even through index files', () => {
    const violations = check([
      { path: 'memory/index.ts', text: "export type { E } from '../episodes/index.ts';" },
      { path: 'episodes/index.ts', text: "export type { M } from '../memory/index.ts';" },
    ]);
    expect(violations.some((v) => v.includes('domain dependency cycle'))).toBe(true);
  });
});
