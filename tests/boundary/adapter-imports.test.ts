import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSpecifiers } from './import-checker.ts';

const PACKAGES = join(import.meta.dirname, '..', '..', 'packages');
const ADAPTERS = join(PACKAGES, 'adapters');
/** The only core module an adapter may reach: its public entry. */
const CORE_ENTRY = 'core/src/index.ts';

interface Source {
  /** Relative to `packages/`, POSIX form. */
  readonly path: string;
  readonly text: string;
}

/**
 * Adapters implement core-owned ports. They may import their own modules,
 * `node:` builtins, declared dependencies, and core only through its public
 * entry, never a core module directly.
 */
function checkAdapterImports(files: readonly Source[], dependencies: readonly string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const { specifiers, nonLiteral } = collectSpecifiers(file.path, file.text);
    if (nonLiteral > 0) violations.push(`${file.path}: module specifier must be a string literal`);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(file.path), specifier));
        if (target === CORE_ENTRY) continue;
        if (!target.startsWith('adapters/src/')) violations.push(`${file.path}: ${specifier} reaches ${target}; import core only via ${CORE_ENTRY}`);
        else if (!target.endsWith('.ts')) violations.push(`${file.path}: ${specifier} must name a .ts file`);
      } else if (!specifier.startsWith('node:') && !dependencies.includes(specifier)) {
        violations.push(`${file.path}: ${specifier} is not a declared adapter dependency`);
      }
    }
  }
  return violations;
}

function adapterSources(): Source[] {
  const src = join(ADAPTERS, 'src');
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .map((entry) => ({
      path: relative(PACKAGES, join(src, entry)).split(sep).join('/'),
      text: readFileSync(join(src, entry), 'utf8'),
    }));
}

const manifest = JSON.parse(readFileSync(join(ADAPTERS, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
const dependencies = Object.keys(manifest.dependencies ?? {});

describe('adapter import boundary', () => {
  it('scans the real package and finds no violations', () => {
    const files = adapterSources();
    expect(files.length).toBeGreaterThan(8);
    expect(checkAdapterImports(files, dependencies)).toEqual([]);
  });

  it('pins every declared dependency exactly', () => {
    expect(manifest).toMatchObject({ name: 'lite-adapters', private: true, type: 'module', exports: { '.': './src/index.ts' } });
    for (const version of Object.values(manifest.dependencies ?? {})) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each([
    ['a deep core import', "import { ok } from '../../core/src/shared/result.ts';", 'import core only via'],
    ['a deep core type import', "import type { SessionEntry } from '../../core/src/sessions/types.ts';", 'import core only via'],
    ['a dynamic deep core import', "export const load = () => import('../../core/src/application/backup.ts');", 'import core only via'],
    ['a sibling package', "import '../../harness/src/index.ts';", 'import core only via'],
    ['an undeclared package', "import { z } from 'zod';", 'not a declared adapter dependency'],
    ['core by package name', "import { ok } from 'lite-core';", 'not a declared adapter dependency'],
  ])('rejects %s', (_label, text, expected) => {
    const violations = checkAdapterImports([{ path: 'adapters/src/postgres/x.ts', text }], dependencies);
    expect(violations.some((v) => v.includes(expected)), violations.join('\n')).toBe(true);
  });

  it('accepts the core entry, builtins and pg', () => {
    const text = "import { ok } from '../../core/src/index.ts'; import pg from 'pg'; import { join } from 'node:path'; import './z.ts';";
    expect(checkAdapterImports([{ path: 'adapters/src/y.ts', text }], dependencies)).toEqual([]);
    expect(checkAdapterImports([{ path: 'adapters/src/x/y.ts', text: text.replace('../../core', '../../../core') }], dependencies)).toEqual([]);
  });

  it('keeps core free of any reference to the adapters package', () => {
    const coreSrc = join(PACKAGES, 'core', 'src');
    for (const entry of readdirSync(coreSrc, { recursive: true, encoding: 'utf8' }).filter((e) => e.endsWith('.ts'))) {
      const { specifiers } = collectSpecifiers(entry, readFileSync(join(coreSrc, entry), 'utf8'));
      expect(specifiers.filter((s) => s.includes('adapters') || s === 'pg'), entry).toEqual([]);
    }
  });
});
