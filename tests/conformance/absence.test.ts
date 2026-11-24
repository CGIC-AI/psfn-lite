/**
 * The subsystems Lite leaves behind stay absent, mechanically: no excluded
 * package in package.json, in the lockfile's resolved tree or in the
 * installed node_modules; no import of one (or of the donor runtime) from any
 * TypeScript, JavaScript or Python source; no declared identifier, file or
 * directory in Lite's own code naming an excluded subsystem (wiki, findings
 * bus, shards, charge, fleet, Gateway, CogSec, channels, skills, Discord,
 * Redis); no governed tool for one; and none of the donor scaffolding cut from
 * the extracted companion, neither on disk nor referenced. Identifiers are
 * split into words, so `LoopUsage` is not "opus" and a comment that cites a
 * donor path for provenance is not an import.
 *
 * Operator rulings for the donor extraction (docs/extraction.md) amend this:
 * the companion's local classifier and logger packages
 * (`@huggingface/transformers`, the ONNX runtime it loads, `winston`) are core
 * and not excluded; the Automata Bus and the companion agent class are core,
 * so their names are not excluded; and the extracted donor tree
 * (packages/companion) keeps donor names verbatim, so the name rule covers
 * Lite's own code. For packages/companion the rule is the deletion record:
 * every deleted row of packages/companion/extraction/vendored-files.txt
 * (`scaffolding`, `cut`, `source-text`, and the `*-deleted` test-support,
 * assets and seeds; Step B7) is gone, and no file of the package imports,
 * mocks or reads one.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { COMPANION_CORE_TOOL_SURFACES } from '@cgic/psfn-core';
import { collectSpecifiers } from '../boundary/import-checker.ts';
import { excludedName } from './excluded-names.ts';

/** Donor tool surfaces whose factories were scaffolding; cut, not rebuilt (docs/tool-inventory.md). */
const CUT_TOOL_SURFACES: readonly string[] = [
  'fs', 'repo', 'shell', 'web', 'mcp', 'world', 'analysis_workbench', 'self_status',
  'system', 'skill', 'wiki', 'beads', 'notify', 'generate_image', 'selfie_create',
  'publication', 'vault',
];

const REPO = join(import.meta.dirname, '..', '..');
const SELF = relative(REPO, import.meta.filename).split(sep).join('/');

/** Packages of the donor's excluded subsystems (Discord voice and gateway, Redis, PDF, card import) and the donor itself. */
const EXCLUDED_PACKAGES: readonly RegExp[] = [
  /^discord\.js$/,
  /^@discordjs\//,
  /^discord-/,
  /^@snazzah\/davey$/,
  /^prism-media$/,
  /^opusscript$/,
  /^@redis\//,
  /^redis$/,
  /^ioredis$/,
  /^pdfjs-dist$/,
  /^@character-foundry\//,
  /^psfn-framework$/,
];

export function excludedPackage(specifier: string): boolean {
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] ?? specifier);
  return EXCLUDED_PACKAGES.some((p) => p.test(name) || p.test(specifier));
}

/** A specifier that reaches the donor runtime: its package name or a path into its checkout. */
export function donorSpecifier(specifier: string): boolean {
  return /(^|[/\\])psfn-framework([/\\]|$)/.test(specifier);
}

/** Every name a TypeScript file declares: functions, classes, interfaces, types, enums, variables, parameters, properties and members. */
export function declaredNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    const named = node as ts.Node & { readonly name?: ts.Node };
    if (named.name !== undefined && (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name))) {
      if (ts.isDeclarationStatement(node) || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyAssignment(node) || ts.isBindingElement(node) || ts.isEnumMember(node)) {
        names.push(named.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Top-level modules a Python file imports. */
export function pythonImports(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const from = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(line);
    if (from?.[1] !== undefined) out.push(from[1]);
    const plain = /^\s*import\s+([\w.,\s]+?)(?:\s+as\s+\w+)?\s*$/.exec(line);
    if (plain?.[1] !== undefined) out.push(...plain[1].split(',').map((m) => m.trim().split(/\s+/)[0] ?? ''));
  }
  return out.filter((m) => m !== '');
}

/** Python names a file declares: functions, classes and assigned module-level names. */
export function pythonNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const def = /^\s*(?:async\s+)?(?:def|class)\s+(\w+)/.exec(line);
    if (def?.[1] !== undefined) out.push(def[1]);
    const assigned = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(line);
    if (assigned?.[1] !== undefined) out.push(assigned[1]);
  }
  return out;
}

/**
 * The Hermes plugin is a thin host client: it needs none of the companion's
 * local classifier or logger, so the Python rule keeps them out (the operator
 * ruling that allows them covers the TypeScript companion only).
 */
const EXCLUDED_PYTHON_MODULES = /^(discord|redis|aioredis|transformers|onnxruntime|pdfjs|winston|psfn_framework)(\.|$)/;

const COMPANION = 'packages/companion/';
/** vendored-files.txt kinds deleted in Step B7 (`promoted`, `test-support` and `asset` rows stay). */
const DELETED_KINDS = new Set(['scaffolding', 'cut', 'source-text', 'test-support-deleted', 'asset-deleted', 'seed-deleted']);

/** The package-relative paths (`src/...`, `config/...`) of the deleted rows of a vendored-files.txt. */
export function deletedScaffolding(listing: string): string[] {
  return listing
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => line.split('\t'))
    .filter(([kind]) => kind !== undefined && DELETED_KINDS.has(kind))
    .map(([, path]) => path ?? '');
}

const VI_MODULE_CALLS = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock']);

/**
 * Every module or file a source names: the import checker's specifiers (static,
 * type-only, re-export, dynamic, require), the module of `vi.mock` and its
 * siblings, and the file of `new URL('<literal>', import.meta.url)`, which is
 * how donor source-scan tests read other files.
 */
export function moduleReferences(path: string, text: string): string[] {
  const out = [...collectSpecifiers(path, text).specifiers];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    const first = (ts.isCallExpression(node) || ts.isNewExpression(node)) ? node.arguments?.[0] : undefined;
    if (first !== undefined && ts.isStringLiteralLike(first)) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'vi'
        && VI_MODULE_CALLS.has(node.expression.name.text)) {
        out.push(first.text);
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
        && node.arguments?.[1] !== undefined && node.arguments[1].getText(source) === 'import.meta.url') {
        out.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** References from companion files (repo-relative paths) that resolve to a deleted path (package-relative, `.ts`). */
export function deletedReferences(files: readonly { path: string; text: string }[], deleted: ReadonlySet<string>): string[] {
  const hits: string[] = [];
  for (const file of files) {
    for (const reference of moduleReferences(file.path, file.text)) {
      if (!reference.startsWith('.')) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(file.path), reference)).replace(/\.js$/, '.ts');
      if (!resolved.startsWith(COMPANION)) continue;
      if (deleted.has(resolved.slice(COMPANION.length))) hits.push(`${file.path}: ${reference}`);
    }
  }
  return hits;
}

function walk(dir: string, skip: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = relative(REPO, path).split(sep).join('/');
    if (skip(rel)) continue;
    if (statSync(path).isDirectory()) out.push(...walk(path, skip));
    else out.push(rel);
  }
  return out;
}

const skipped = (rel: string) => /(^|\/)(node_modules|\.git|\.venv|__pycache__|\.pytest_cache|dist|coverage)(\/|$)/.test(rel);
const SOURCE_ROOTS = ['packages', 'apps', 'integrations', 'tests', 'scripts'];
const sources = SOURCE_ROOTS.flatMap((root) => walk(join(REPO, root), skipped));
const codeFiles = sources.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f));
const pythonFiles = sources.filter((f) => f.endsWith('.py'));
/**
 * Product code: what Lite ships. Tests are checked for imports, not for the words their fixtures and assertions use.
 * The extracted donor tree keeps donor names verbatim (the donor is the spec), so the name and path rule covers
 * Lite's own packages; packages/companion is held to its deletion record instead (the last describe).
 */
/**
 * Field names of donor contracts a host must fill, which happen to contain an
 * excluded word but name a kept concept. Each is a property key written into a
 * donor type, never a name Lite declares for itself.
 */
const DONOR_CONTRACT_KEYS: readonly (readonly [file: string, key: string, reason: string])[] = [
  ['apps/standalone/src/runtime.ts', 'channels', 'Contact.channels (packages/companion/src/core/contacts/types.ts:333): a contact\'s identity links, not the cut channel adapters'],
  ['integrations/hermes/desktop/src/api.ts', 'channels', 'AdminSessionListData.channels (packages/companion/src/operator/garden/services/types/sessions.ts:29): the donor Garden session list the Sessions screen reads, not the cut channel adapters'],
  ['packages/operator/src/garden.ts', 'fleetMemoryStore', 'AdminMemoryDataService and AdminContactsDataService deps (packages/companion/src/operator/garden/services/memory-service.ts:211, contacts-service.ts:181): the raw memory store beside the subject-authorized one, filled as the donor composition filled it (local-admin-contract.ts:783, 997)'],
];

const productFiles = sources.filter((f) => /^(packages|apps|integrations\/hermes\/(psfn_lite|desktop))\//.test(f) && !f.startsWith(COMPANION));

describe('the checker itself', () => {
  it('flags each kind of excluded reference and passes look-alikes', () => {
    expect(excludedPackage('discord.js')).toBe(true);
    expect(excludedPackage('@discordjs/voice')).toBe(true);
    expect(excludedPackage('@redis/client')).toBe(true);
    expect(excludedPackage('pdfjs-dist')).toBe(true);
    expect(excludedPackage('@character-foundry/character-foundry')).toBe(true);
    expect(excludedPackage('pg')).toBe(false);
    expect(excludedPackage('@huggingface/transformers')).toBe(false);
    expect(excludedPackage('@huggingface/transformers/dist/x.js')).toBe(false);
    expect(excludedPackage('onnxruntime-node')).toBe(false);
    expect(excludedPackage('winston')).toBe(false);
    expect(donorSpecifier('../../psfn-framework/src/core/agent.ts')).toBe(true);
    expect(donorSpecifier('psfn-framework')).toBe(true);
    expect(excludedName('GatewayServer')).toBe('gateway');
    expect(excludedName('findingsBus')).toBe('findings bus');
    expect(excludedName('wiki-pass.ts')).toBe('wiki');
    expect(excludedName('ChargeLedger')).toBe('charge');
    expect(excludedName('fleetAuth')).toBe('fleet');
    expect(excludedName('CogSecEvent')).toBe('cog sec');
    expect(excludedName('cogsec-mode.ts')).toBe('cogsec');
    expect(excludedName('channels')).toBe('channels');
    expect(excludedName('SkillReuseConfig')).toBe('skill');
    expect(excludedName('discordToken')).toBe('discord');
    expect(excludedName('RedisSessionTail')).toBe('redis');
    expect(excludedName('SubstrateAgent')).toBeNull();
    expect(excludedName('automata_bus')).toBeNull();
    expect(excludedName('channelId')).toBeNull();
    expect(excludedName('LoopUsage')).toBeNull();
    expect(excludedName('discharged')).toBeNull();
    expect(excludedName('automata')).toBeNull();
    expect(declaredNames('x.ts', 'class SubstrateAgent {}\nconst wikiIndex = 1;\nfunction f(fleet: number) { return fleet; }')).toEqual(['SubstrateAgent', 'wikiIndex', 'f', 'fleet']);
    expect(collectSpecifiers('x.ts', "import { Client } from 'discord.js';\nawait import('@redis/client');").specifiers.filter(excludedPackage)).toHaveLength(2);
    expect(pythonImports('import redis\nfrom discord.ext import commands\nimport json, os')).toEqual(['redis', 'discord.ext', 'json', 'os']);
    expect(pythonNames('class GatewayServer:\n    pass\nWIKI_ROOT = 1\n')).toEqual(['GatewayServer', 'WIKI_ROOT']);
  });

  it('flags a companion reference to a deleted path in every form and passes kept paths', () => {
    expect(deletedScaffolding('# kind\tfile\nscaffolding\tsrc/a.ts\ncut\tsrc/b.ts\nsource-text\tsrc/c.ts\npromoted\tsrc/d.ts\nasset\tsrc/e.json\ntest-support\tsrc/f.ts\nasset-deleted\tsrc/g.json\ntest-support-deleted\tsrc/h.ts\nseed-deleted\tconfig/i.seed.json\n'))
      .toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/g.json', 'src/h.ts', 'config/i.seed.json']);
    expect(moduleReferences('x.test.ts', [
      "import type { A } from './a.js';",
      "vi.mock('./b.js', () => ({}));",
      "await vi.importActual('./c.js');",
      "readFileSync(new URL('../d.ts', import.meta.url), 'utf8');",
      "new URL('https://example.invalid/e.ts');",
      "other.mock('./f.js');",
    ].join('\n'))).toEqual(['./a.js', './b.js', './c.js', '../d.ts']);
    const deleted = new Set(['src/boundary/gateway/server.ts', 'src/app/gateway/main.ts']);
    const file = (text: string) => ({ path: `${COMPANION}src/core/x.test.ts`, text });
    expect(deletedReferences([file("import { s } from '../boundary/gateway/server.js';")], deleted)).toHaveLength(1);
    expect(deletedReferences([file("vi.mock('../boundary/gateway/server.js');")], deleted)).toHaveLength(1);
    expect(deletedReferences([file("const m = await import('../boundary/gateway/server.js');")], deleted)).toHaveLength(1);
    expect(deletedReferences([file("readFileSync(new URL('../app/gateway/main.ts', import.meta.url), 'utf8');")], deleted)).toHaveLength(1);
    expect(deletedReferences([file("import { EventBus } from '../shared/event-bus.js';")], deleted)).toEqual([]);
    expect(deletedReferences([file("import { s } from '../../../src/boundary/gateway/server.js';")], deleted)).toEqual([]);
  });
});

describe('excluded subsystems are absent from Lite', () => {
  it('package.json declares none of their packages', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Record<string, unknown>;
    const declared = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']
      .flatMap((k) => Object.keys((manifest[k] as Record<string, string> | undefined) ?? {}));
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter(excludedPackage)).toEqual([]);
    const overrides = Object.keys((manifest.overrides as Record<string, unknown> | undefined) ?? {});
    expect(overrides.filter(excludedPackage)).toEqual([]);
  });

  it('the lockfile resolves none of them anywhere in the tree, and node_modules holds none', () => {
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
    const resolved = Object.keys(lock.packages)
      .filter((k) => k.includes('node_modules/'))
      .map((k) => k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length));
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.filter(excludedPackage)).toEqual([]);
    const top = readdirSync(join(REPO, 'node_modules')).flatMap((name) =>
      name.startsWith('@') ? readdirSync(join(REPO, 'node_modules', name)).map((n) => `${name}/${n}`) : [name],
    );
    expect(top.filter(excludedPackage)).toEqual([]);
  });

  it('the Hermes integration declares none of their Python packages', () => {
    const declared = ['integrations/hermes/pyproject.toml', 'integrations/hermes/requirements-test.txt'].map((f) => readFileSync(join(REPO, f), 'utf8')).join('\n');
    expect(declared).not.toMatch(/^\s*"?(discord|redis|aioredis|transformers|onnxruntime|winston)\b/im);
  });

  it('no source imports one of them or the donor runtime', () => {
    expect(codeFiles.length).toBeGreaterThan(50);
    const hits = codeFiles.flatMap((file) =>
      collectSpecifiers(file, readFileSync(join(REPO, file), 'utf8'))
        .specifiers.filter((s) => excludedPackage(s) || donorSpecifier(s))
        .map((s) => `${file}: ${s}`),
    );
    expect(hits).toEqual([]);
    const python = pythonFiles.flatMap((file) =>
      pythonImports(readFileSync(join(REPO, file), 'utf8'))
        .filter((m) => EXCLUDED_PYTHON_MODULES.test(m))
        .map((m) => `${file}: ${m}`),
    );
    expect(python).toEqual([]);
  });

  it('no product file, directory or declared name is one of the excluded subsystems', () => {
    // Step C: the host adapters, the standalone app and the Hermes plugin (46 files); a truncated listing must not pass.
    expect(productFiles.length).toBeGreaterThan(40);
    const paths = sources.filter((f) => f !== SELF && !f.startsWith(COMPANION)).flatMap((f) => f.split('/').map((segment) => [f, segment, excludedName(segment)] as const)).filter(([, , w]) => w !== null);
    expect(paths.map(([f, segment, w]) => `${f}: ${segment} (${String(w)})`)).toEqual([]);
    const names = productFiles.flatMap((file) => {
      const text = readFileSync(join(REPO, file), 'utf8');
      const declared = file.endsWith('.py') ? pythonNames(text) : /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) ? declaredNames(file, text) : [];
      return declared
        .filter((n) => !DONOR_CONTRACT_KEYS.some(([f, key]) => f === file && key === n))
        .map((n) => [file, n, excludedName(n)] as const)
        .filter(([, , w]) => w !== null);
    });
    expect(names.map(([f, n, w]) => `${f}: ${n} (${String(w)})`)).toEqual([]);
  });

  it('no companion tool Lite serves is one of them', () => {
    // The live catalog the MCP transport serves is checked the same way by the inventory test of conformance.integration.test.ts.
    const served = COMPANION_CORE_TOOL_SURFACES.map((t) => t.name);
    expect(served.length).toBeGreaterThanOrEqual(15);
    expect(served).toContain('execute');
    expect(served).toContain('orient');
    expect(served).toContain('concerns');
    expect(served.filter((n) => excludedName(n) !== null)).toEqual([]);
  });

  it('the companion core tool registry excludes host scaffolding tools', () => {
    const registry = new Set(COMPANION_CORE_TOOL_SURFACES.map((t) => t.name));
    expect(CUT_TOOL_SURFACES.filter((n) => registry.has(n))).toEqual([]);
  });
});

describe('vendored packages/companion is replaced by @cgic/psfn-core', () => {
  it('has no vendored packages/companion tree on disk', () => {
    expect(existsSync(join(REPO, COMPANION))).toBe(false);
  });

  it('declares zero excluded packages inside installed @cgic/psfn-core', () => {
    const coreManifest = JSON.parse(
      readFileSync(join(REPO, 'node_modules', '@cgic', 'psfn-core', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(coreManifest.dependencies ?? {});
    expect(deps.length).toBe(8);
    expect(deps.filter(excludedPackage)).toEqual([]);
  });
});
