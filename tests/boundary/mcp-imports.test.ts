import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSpecifiers } from './import-checker.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const PACKAGES = join(ROOT, 'packages');
const MCP = join(PACKAGES, 'mcp');
/** The only modules of other packages the transport may reach: their public entries. */
const ENTRIES = ['core/src/index.ts', 'adapters/src/index.ts'];

interface Source {
  /** Relative to `packages/`, POSIX form. */
  readonly path: string;
  readonly text: string;
}

/**
 * The MCP transport is an outer package. It may import its own modules,
 * `node:` builtins, its declared dependencies (and their subpath exports),
 * and core and adapters only through their public entries.
 */
function checkMcpImports(files: readonly Source[], dependencies: readonly string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const { specifiers, nonLiteral } = collectSpecifiers(file.path, file.text);
    if (nonLiteral > 0) violations.push(`${file.path}: module specifier must be a string literal`);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(file.path), specifier));
        if (ENTRIES.includes(target)) continue;
        if (!target.startsWith('mcp/src/')) violations.push(`${file.path}: ${specifier} reaches ${target}; import other packages only via ${ENTRIES.join(' or ')}`);
        else if (!target.endsWith('.ts')) violations.push(`${file.path}: ${specifier} must name a .ts file`);
      } else if (!specifier.startsWith('node:') && !dependencies.some((d) => specifier === d || specifier.startsWith(`${d}/`))) {
        violations.push(`${file.path}: ${specifier} is not a declared mcp dependency`);
      }
    }
  }
  return violations;
}

function sources(pkg: string): Source[] {
  const src = join(PACKAGES, pkg, 'src');
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .map((entry) => ({ path: relative(PACKAGES, join(src, entry)).split(sep).join('/'), text: readFileSync(join(src, entry), 'utf8') }));
}

const manifest = JSON.parse(readFileSync(join(MCP, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
const dependencies = Object.keys(manifest.dependencies ?? {});

describe('mcp import boundary', () => {
  it('scans the real package and finds no violations', () => {
    const files = sources('mcp');
    expect(files.length).toBeGreaterThan(8);
    expect(checkMcpImports(files, dependencies)).toEqual([]);
  });

  it('pins every declared dependency exactly, at the root lockfile version', () => {
    expect(manifest).toMatchObject({ name: 'lite-mcp', private: true, type: 'module', exports: { '.': './src/index.ts' } });
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(root.dependencies?.[name], name).toBe(version);
    }
  });

  it.each([
    ['a deep core import', "import { ok } from '../../core/src/shared/result.ts';", 'import other packages only via'],
    ['a deep core type import', "import type { TrustedTurnScope } from '../../core/src/application/trusted-scope.ts';", 'import other packages only via'],
    ['a deep adapter import', "import { migrate } from '../../adapters/src/postgres/migrations.ts';", 'import other packages only via'],
    ['a dynamic deep import', "export const load = () => import('../../core/src/application/dispatch.ts');", 'import other packages only via'],
    ['a sibling app', "import '../../../apps/standalone/src/index.ts';", 'import other packages only via'],
    ['an undeclared package', "import { z } from 'zod';", 'not a declared mcp dependency'],
    ['an undeclared look-alike', "import '@modelcontextprotocol/server-extra';", 'not a declared mcp dependency'],
    ['core by package name', "import { ok } from 'lite-core';", 'not a declared mcp dependency'],
  ])('rejects %s', (_label, text, expected) => {
    const violations = checkMcpImports([{ path: 'mcp/src/x.ts', text }], dependencies);
    expect(violations.some((v) => v.includes(expected)), violations.join('\n')).toBe(true);
  });

  it('accepts the public entries, builtins, the SDK and its subpaths', () => {
    const text =
      "import { ok } from '../../core/src/index.ts'; import '../../adapters/src/index.ts'; import { Server } from '@modelcontextprotocol/server'; import { serveStdio } from '@modelcontextprotocol/server/stdio'; import { join } from 'node:path'; import './y.ts';";
    expect(checkMcpImports([{ path: 'mcp/src/x.ts', text }], dependencies)).toEqual([]);
  });

  it('keeps core and the adapters free of any reference to the transport or the SDK', () => {
    for (const file of [...sources('core'), ...sources('adapters')]) {
      const { specifiers } = collectSpecifiers(file.path, file.text);
      expect(specifiers.filter((s) => s.includes('mcp') || s.includes('modelcontextprotocol')), file.path).toEqual([]);
    }
  });
});
