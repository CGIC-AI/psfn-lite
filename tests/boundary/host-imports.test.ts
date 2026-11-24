/**
 * Host adapter import boundaries. The host packages (MCP transport,
 * lifecycle bridge, Pi adapters, operator Garden, standalone app) depend
 * inward: each reaches another host package only through that package's public
 * entry, re-exported by one shim module, and the `@cgic/psfn-core` package only
 * through its own `companion.ts` shim. Bare imports are `node:` builtins or
 * declared, exactly pinned dependencies.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSpecifiers } from './import-checker.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const CORE_PACKAGE = '@cgic/psfn-core';

interface Source {
  /** Relative to the repository root, POSIX form. */
  readonly path: string;
  readonly text: string;
}

interface HostRules {
  /** The package's own source directory, e.g. `packages/pi/src/`. */
  readonly own: string;
  /** Other host packages' public entries the package may reach, each through exactly one shim module. */
  readonly entries: Readonly<Record<string, string>>;
  /** The one module that may import `@cgic/psfn-core`; null when the package may not. */
  readonly companionShim: string | null;
  /** Declared bare-specifier dependencies (subpaths of a declared package are allowed). */
  readonly dependencies: readonly string[];
  /** The only module that may import the declared dependencies; null when any own module may. */
  readonly dependencySite: string | null;
}

function isCorePackageSpecifier(specifier: string): boolean {
  return specifier === CORE_PACKAGE || specifier.startsWith(`${CORE_PACKAGE}/`);
}

function checkHostImports(files: readonly Source[], rules: HostRules): string[] {
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
          violations.push(`${file.path}: ${specifier} reaches ${target}; host packages import only public entries`);
        } else if (!target.endsWith('.ts')) {
          violations.push(`${file.path}: ${specifier} must name a .ts file`);
        }
      } else if (specifier.startsWith('node:')) {
        continue;
      } else if (isCorePackageSpecifier(specifier)) {
        if (rules.companionShim === null) {
          violations.push(`${file.path}: ${specifier} reaches the companion core, which this package may not import`);
        } else if (file.path !== rules.companionShim) {
          violations.push(`${file.path}: ${specifier} must be reached through ${rules.companionShim}`);
        }
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

const ROOT_MANIFEST = manifest('.');
const MCP_MANIFEST = manifest('packages/mcp');
const LIFECYCLE_MANIFEST = manifest('packages/lifecycle');
const PI_MANIFEST = manifest('packages/pi');
const OPERATOR_MANIFEST = manifest('packages/operator');
const STANDALONE_MANIFEST = manifest('apps/standalone');

const RULES: Readonly<Record<string, HostRules>> = {
  mcp: {
    own: 'packages/mcp/src/',
    entries: {},
    companionShim: null,
    dependencies: Object.keys(MCP_MANIFEST.dependencies ?? {}),
    dependencySite: null,
  },
  lifecycle: {
    own: 'packages/lifecycle/src/',
    entries: { 'packages/mcp/src/index.ts': 'packages/lifecycle/src/mcp.ts' },
    companionShim: 'packages/lifecycle/src/companion.ts',
    dependencies: Object.keys(LIFECYCLE_MANIFEST.dependencies ?? {}),
    dependencySite: null,
  },
  pi: {
    own: 'packages/pi/src/',
    entries: {},
    companionShim: null,
    dependencies: Object.keys(PI_MANIFEST.dependencies ?? {}),
    dependencySite: 'packages/pi/src/pi.ts',
  },
  operator: {
    own: 'packages/operator/src/',
    entries: { 'packages/mcp/src/index.ts': 'packages/operator/src/mcp.ts' },
    companionShim: 'packages/operator/src/companion.ts',
    dependencies: Object.keys(OPERATOR_MANIFEST.dependencies ?? {}),
    dependencySite: null,
  },
  standalone: {
    own: 'apps/standalone/src/',
    entries: {
      'packages/pi/src/index.ts': 'apps/standalone/src/pi.ts',
      'packages/mcp/src/index.ts': 'apps/standalone/src/mcp.ts',
      'packages/lifecycle/src/index.ts': 'apps/standalone/src/lifecycle.ts',
      'packages/operator/src/index.ts': 'apps/standalone/src/operator.ts',
    },
    companionShim: 'apps/standalone/src/companion.ts',
    dependencies: Object.keys(STANDALONE_MANIFEST.dependencies ?? {}),
    dependencySite: null,
  },
};

const DIRS: Readonly<Record<string, string>> = {
  mcp: 'packages/mcp/src',
  lifecycle: 'packages/lifecycle/src',
  pi: 'packages/pi/src',
  operator: 'packages/operator/src',
  standalone: 'apps/standalone/src',
};

describe('host adapter import boundaries', () => {
  it.each(Object.keys(RULES))('scans the real %s package and finds no violations', (name) => {
    const files = sources(DIRS[name] ?? '');
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(checkHostImports(files, RULES[name]!)).toEqual([]);
  });

  it('pins every declared dependency exactly, at the root manifest version', () => {
    for (const pkg of [MCP_MANIFEST, LIFECYCLE_MANIFEST, PI_MANIFEST, OPERATOR_MANIFEST, STANDALONE_MANIFEST]) {
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        expect(version, `${pkg.name} ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
        expect(ROOT_MANIFEST.dependencies?.[name], `${pkg.name} ${name}`).toBe(version);
      }
    }
    expect(MCP_MANIFEST.dependencies).toEqual({ '@modelcontextprotocol/server': '2.3.0' });
    expect(PI_MANIFEST.dependencies).toEqual({ '@earendil-works/pi-ai': '0.84.1' });
    expect(LIFECYCLE_MANIFEST.dependencies).toBeUndefined();
    expect(OPERATOR_MANIFEST.dependencies).toBeUndefined();
    expect(STANDALONE_MANIFEST.dependencies).toBeUndefined();
    expect(ROOT_MANIFEST.dependencies?.[CORE_PACKAGE]).toBeDefined();
  });

  it.each([
    ['lifecycle', 'a companion module outside its shim', 'packages/lifecycle/src/x.ts', "import { createTurnId } from '@cgic/psfn-core/lifecycle';", 'must be reached through packages/lifecycle/src/companion.ts'],
    ['lifecycle', 'a deep MCP import', 'packages/lifecycle/src/x.ts', "import { bearerCredential } from '../../mcp/src/credentials.ts';", 'host packages import only public entries'],
    ['lifecycle', 'the MCP entry outside its shim', 'packages/lifecycle/src/x.ts', "import { publicError } from '../../mcp/src/index.ts';", 'must be reached through packages/lifecycle/src/mcp.ts'],
    ['lifecycle', 'the Pi adapters', 'packages/lifecycle/src/x.ts', "import '../../pi/src/index.ts';", 'host packages import only public entries'],
    ['lifecycle', 'an undeclared package', 'packages/lifecycle/src/x.ts', "import { createServer } from 'express';", 'not a declared dependency'],
    ['operator', 'a companion module outside its shim', 'packages/operator/src/x.ts', "import { AdminMemoryDataService } from '@cgic/psfn-core/operator';", 'must be reached through packages/operator/src/companion.ts'],
    ['operator', 'the lifecycle bridge', 'packages/operator/src/x.ts', "import '../../lifecycle/src/index.ts';", 'host packages import only public entries'],
    ['mcp', 'the companion core', 'packages/mcp/src/x.ts', "import { startCompanionRuntime } from '@cgic/psfn-core';", 'which this package may not import'],
    ['mcp', 'an undeclared look-alike', 'packages/mcp/src/x.ts', "import '@modelcontextprotocol/server-extra';", 'not a declared dependency'],
    ['pi', 'the companion core', 'packages/pi/src/x.ts', "import type { ProviderRuntime } from '@cgic/psfn-core/ports';", 'which this package may not import'],
    ['pi', 'Pi outside its one import site', 'packages/pi/src/model-runtime.ts', "import { createModels } from '@earendil-works/pi-ai';", 'may be imported only by packages/pi/src/pi.ts'],
    ['pi', 'a non-literal dynamic import', 'packages/pi/src/pi.ts', 'export const load = (name: string) => import(name);', 'string literal'],
    ['standalone', 'a companion module outside its shim', 'apps/standalone/src/x.ts', "import { startCompanionRuntime } from '@cgic/psfn-core';", 'must be reached through apps/standalone/src/companion.ts'],
    ['standalone', 'a deep Pi import', 'apps/standalone/src/x.ts', "import '../../../packages/pi/src/model-runtime.ts';", 'host packages import only public entries'],
    ['standalone', 'the Pi runtime directly', 'apps/standalone/src/x.ts', "import { createModels } from '@earendil-works/pi-ai';", 'not a declared dependency'],
  ])('rejects in %s: %s', (name, _label, path, text, expected) => {
    const violations = checkHostImports([{ path, text }], RULES[name]!);
    expect(violations.some((v) => v.includes(expected)), violations.join('\n')).toBe(true);
  });

  it('keeps the installed @cgic/psfn-core package free of any reference to Lite host packages', () => {
    const corePkg = manifest('node_modules/@cgic/psfn-core');
    expect(corePkg.name).toBe(CORE_PACKAGE);
    const deps = Object.keys(corePkg.dependencies ?? {});
    expect(deps).not.toContain('@modelcontextprotocol/server');
    expect(deps).not.toContain('psfn-lite');
  });
});
