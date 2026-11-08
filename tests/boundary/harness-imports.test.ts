import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSpecifiers } from './import-checker.ts';

const ROOT = join(import.meta.dirname, '..', '..');

interface Source {
  /** Relative to the repository root, POSIX form. */
  readonly path: string;
  readonly text: string;
}

interface OuterRules {
  /** The package's own source directory, e.g. `packages/pi/src/`. */
  readonly own: string;
  /** Other packages' public entries the package may reach, each through exactly one shim module. */
  readonly entries: Readonly<Record<string, string>>;
  /** Declared bare-specifier dependencies (subpaths of a declared package are allowed). */
  readonly dependencies: readonly string[];
  /** The only module that may import the declared dependencies; null when any own module may. */
  readonly dependencySite: string | null;
}

/**
 * Outer packages depend inward: they reach core, adapters and the Pi harness
 * only through those packages' public entries, each re-exported by one shim
 * module, and import nothing else but their own modules, `node:` builtins and
 * declared, exactly pinned dependencies.
 */
function checkOuterImports(files: readonly Source[], rules: OuterRules): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const { specifiers, nonLiteral } = collectSpecifiers(file.path, file.text);
    if (nonLiteral > 0) violations.push(`${file.path}: module specifier must be a string literal`);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(file.path), specifier));
        const shim = rules.entries[target];
        if (shim !== undefined) {
          if (file.path !== shim) violations.push(`${file.path}: ${specifier} must be reached through ${shim}`);
        } else if (!target.startsWith(rules.own)) {
          violations.push(`${file.path}: ${specifier} reaches ${target}; outer packages import only public entries`);
        } else if (!target.endsWith('.ts')) {
          violations.push(`${file.path}: ${specifier} must name a .ts file`);
        }
      } else if (specifier.startsWith('node:')) {
        continue;
      } else {
        const declared = rules.dependencies.some((dependency) => specifier === dependency || specifier.startsWith(`${dependency}/`));
        if (!declared) violations.push(`${file.path}: ${specifier} is not a declared dependency`);
        else if (rules.dependencySite !== null && file.path !== rules.dependencySite) {
          violations.push(`${file.path}: ${specifier} may be imported only by ${rules.dependencySite}`);
        }
      }
    }
  }
  return violations;
}

function sources(dir: string): Source[] {
  const src = join(ROOT, dir);
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .map((entry) => ({ path: relative(ROOT, join(src, entry)).split(sep).join('/'), text: readFileSync(join(src, entry), 'utf8') }));
}

function manifest(dir: string) {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as { name: string; dependencies?: Record<string, string> };
}

const PI_MANIFEST = manifest('packages/pi');
const PI_RULES: OuterRules = {
  own: 'packages/pi/src/',
  entries: { 'packages/core/src/index.ts': 'packages/pi/src/core.ts' },
  dependencies: Object.keys(PI_MANIFEST.dependencies ?? {}),
  dependencySite: 'packages/pi/src/pi.ts',
};
const STANDALONE_MANIFEST = manifest('apps/standalone');
const STANDALONE_RULES: OuterRules = {
  own: 'apps/standalone/src/',
  entries: {
    'packages/core/src/index.ts': 'apps/standalone/src/core.ts',
    'packages/adapters/src/index.ts': 'apps/standalone/src/adapters.ts',
    'packages/pi/src/index.ts': 'apps/standalone/src/harness.ts',
    'packages/mcp/src/index.ts': 'apps/standalone/src/mcp.ts',
    'packages/lifecycle/src/index.ts': 'apps/standalone/src/lifecycle.ts',
  },
  dependencies: Object.keys(STANDALONE_MANIFEST.dependencies ?? {}),
  dependencySite: null,
};

const LIFECYCLE_MANIFEST = manifest('packages/lifecycle');
const LIFECYCLE_RULES: OuterRules = {
  own: 'packages/lifecycle/src/',
  entries: { 'packages/core/src/index.ts': 'packages/lifecycle/src/core.ts', 'packages/mcp/src/index.ts': 'packages/lifecycle/src/mcp.ts' },
  dependencies: Object.keys(LIFECYCLE_MANIFEST.dependencies ?? {}),
  dependencySite: null,
};

describe('lifecycle bridge import boundary', () => {
  it('scans the real bridge package and finds no violations', () => {
    const files = sources('packages/lifecycle/src');
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(checkOuterImports(files, LIFECYCLE_RULES)).toEqual([]);
  });

  it('gives the bridge no third-party dependency', () => {
    expect(LIFECYCLE_MANIFEST).toMatchObject({ name: 'lite-lifecycle', private: true, type: 'module', exports: { '.': './src/index.ts' } });
    expect(LIFECYCLE_MANIFEST.dependencies).toBeUndefined();
  });

  it.each([
    ['a deep core import', "import { ok } from '../../core/src/shared/result.ts';", 'outer packages import only public entries'],
    ['a deep MCP import', "import { bearerCredential } from '../../mcp/src/credentials.ts';", 'outer packages import only public entries'],
    ['the MCP entry outside its shim', "import { publicError } from '../../mcp/src/index.ts';", 'must be reached through packages/lifecycle/src/mcp.ts'],
    ['the Pi harness', "import '../../pi/src/index.ts';", 'outer packages import only public entries'],
    ['an undeclared package', "import { createServer } from 'express';", 'not a declared dependency'],
  ])('rejects %s in the bridge', (_label, text, expected) => {
    const violations = checkOuterImports([{ path: 'packages/lifecycle/src/x.ts', text }], LIFECYCLE_RULES);
    expect(violations.some((v) => v.includes(expected)), violations.join('\n')).toBe(true);
  });

  it('keeps core free of any reference to the bridge or the MCP transport', () => {
    for (const file of sources('packages/core/src')) {
      const { specifiers } = collectSpecifiers(file.path, file.text);
      expect(specifiers.filter((s) => s.includes('/lifecycle/') || s.includes('/mcp/')), file.path).toEqual([]);
    }
  });
});

describe('Pi harness and standalone import boundaries', () => {
  it('scans the real Pi package and finds no violations', () => {
    const files = sources('packages/pi/src');
    expect(files.length).toBeGreaterThan(8);
    expect(checkOuterImports(files, PI_RULES)).toEqual([]);
  });

  it('scans the real standalone app and finds no violations', () => {
    const files = sources('apps/standalone/src');
    expect(files.length).toBeGreaterThan(8);
    expect(checkOuterImports(files, STANDALONE_RULES)).toEqual([]);
  });

  it('pins the Pi runtime exactly and gives the standalone app no third-party dependency', () => {
    expect(PI_MANIFEST).toMatchObject({ name: 'lite-pi', private: true, type: 'module', exports: { '.': './src/index.ts' } });
    expect(PI_MANIFEST.dependencies).toEqual({ '@earendil-works/pi-agent-core': '0.84.1', '@earendil-works/pi-ai': '0.84.1' });
    const root = manifest('.') as { dependencies?: Record<string, string> };
    for (const [name, version] of Object.entries(PI_MANIFEST.dependencies ?? {})) expect(root.dependencies?.[name]).toBe(version);
    expect(STANDALONE_MANIFEST).toMatchObject({ name: 'lite-standalone', private: true, type: 'module', exports: { '.': './src/index.ts' } });
    expect(STANDALONE_MANIFEST.dependencies).toBeUndefined();
  });

  it.each([
    ['a deep core import', 'packages/pi/src/x.ts', "import { ok } from '../../core/src/shared/result.ts';", 'outer packages import only public entries'],
    ['the core entry outside the shim', 'packages/pi/src/x.ts', "import { ok } from '../../core/src/index.ts';", 'must be reached through packages/pi/src/core.ts'],
    ['the adapters package', 'packages/pi/src/x.ts', "import '../../adapters/src/index.ts';", 'outer packages import only public entries'],
    ['Pi outside its one import site', 'packages/pi/src/loop.ts', "import { runAgentLoop } from '@earendil-works/pi-agent-core';", 'may be imported only by packages/pi/src/pi.ts'],
    ['an undeclared package', 'packages/pi/src/pi.ts', "import { Agent } from 'psfn-framework';", 'not a declared dependency'],
    ['a lookalike of a declared package', 'packages/pi/src/pi.ts', "import '@earendil-works/pi-ai-extra';", 'not a declared dependency'],
    ['a non-literal dynamic import', 'packages/pi/src/pi.ts', 'export const load = (name: string) => import(name);', 'string literal'],
  ])('rejects %s in the Pi package', (_label, path, text, expected) => {
    const violations = checkOuterImports([{ path, text }], PI_RULES);
    expect(violations.some((v) => v.includes(expected)), violations.join('\n')).toBe(true);
  });

  it.each([
    ['a deep Pi import', "import { runModelLoop } from '../../../packages/pi/src/loop.ts';", 'outer packages import only public entries'],
    ['a deep adapter import', "import '../../../packages/adapters/src/postgres/pool.ts';", 'outer packages import only public entries'],
    ['the Pi runtime directly', "import { runAgentLoop } from '@earendil-works/pi-agent-core';", 'not a declared dependency'],
    ['core outside its shim', "import { ok } from '../../../packages/core/src/index.ts';", 'must be reached through apps/standalone/src/core.ts'],
  ])('rejects %s in the standalone app', (_label, text, expected) => {
    const violations = checkOuterImports([{ path: 'apps/standalone/src/x.ts', text }], STANDALONE_RULES);
    expect(violations.some((v) => v.includes(expected)), violations.join('\n')).toBe(true);
  });

  it('keeps core and adapters free of any reference to the Pi harness, the Pi runtime or the app', () => {
    for (const file of [...sources('packages/core/src'), ...sources('packages/adapters/src')]) {
      const { specifiers } = collectSpecifiers(file.path, file.text);
      expect(specifiers.filter((s) => s.includes('earendil-works') || s.includes('/pi/') || s.includes('standalone')), file.path).toEqual([]);
    }
  });
});
