/**
 * The subsystems Lite leaves behind stay absent, mechanically: no excluded
 * package in package.json, in the lockfile's resolved tree or in the
 * installed node_modules; no import of one (or of the donor runtime) from any
 * TypeScript, JavaScript or Python source; no declared identifier, file or
 * directory naming an excluded subsystem (wiki, findings bus, shards, charge,
 * fleet, Gateway, SubstrateAgent, Discord, Redis); and no governed tool for
 * one. Identifiers are split into words, so `LoopUsage` is not "opus" and a
 * comment that cites a donor path for provenance is not an import.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TOOL_INVENTORY } from '../../packages/core/src/index.ts';
import { collectSpecifiers } from '../boundary/import-checker.ts';

const REPO = join(import.meta.dirname, '..', '..');
const SELF = relative(REPO, import.meta.filename).split(sep).join('/');

/** Packages of the donor's excluded subsystems (Discord voice and gateway, Redis, local transformers, PDF, logging) and the donor itself. */
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
  /^@huggingface\//,
  /^onnxruntime-/,
  /^pdfjs-dist$/,
  /^winston$/,
  /^@character-foundry\//,
  /^psfn-framework$/,
];

/** Words that name an excluded subsystem; matched against the words of an identifier or a path segment. */
const EXCLUDED_WORDS = new Set(['wiki', 'wikis', 'shard', 'shards', 'fleet', 'fleets', 'charge', 'charges', 'gateway', 'gateways', 'substrate', 'discord', 'redis']);
/** Excluded subsystems whose name is two words. */
const EXCLUDED_PAIRS: readonly (readonly [string, string])[] = [
  ['findings', 'bus'],
  ['finding', 'bus'],
  ['automata', 'bus'],
  ['substrate', 'agent'],
  ['gateway', 'server'],
];

/** The words of an identifier or file name: camelCase, PascalCase, snake_case, kebab-case and dots split apart. */
export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

export function excludedName(name: string): string | null {
  const words = wordsOf(name);
  const single = words.find((w) => EXCLUDED_WORDS.has(w));
  if (single !== undefined) return single;
  for (let i = 0; i + 1 < words.length; i += 1) {
    const pair = EXCLUDED_PAIRS.find(([a, b]) => words[i] === a && words[i + 1] === b);
    if (pair !== undefined) return pair.join(' ');
  }
  return null;
}

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
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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

const EXCLUDED_PYTHON_MODULES = /^(discord|redis|aioredis|transformers|onnxruntime|pdfjs|winston|psfn_framework)(\.|$)/;

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
const codeFiles = sources.filter((f) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(f));
const pythonFiles = sources.filter((f) => f.endsWith('.py'));
/** Product code: what Lite ships. Tests are checked for imports, not for the words their fixtures and assertions use. */
const productFiles = sources.filter((f) => /^(packages|apps|integrations\/hermes\/psfn_lite)\//.test(f));

describe('the checker itself', () => {
  it('flags each kind of excluded reference and passes look-alikes', () => {
    expect(excludedPackage('discord.js')).toBe(true);
    expect(excludedPackage('@discordjs/voice')).toBe(true);
    expect(excludedPackage('@redis/client')).toBe(true);
    expect(excludedPackage('@huggingface/transformers/dist/x.js')).toBe(true);
    expect(excludedPackage('pg')).toBe(false);
    expect(donorSpecifier('../../psfn-framework/src/core/agent.ts')).toBe(true);
    expect(donorSpecifier('psfn-framework')).toBe(true);
    expect(excludedName('SubstrateAgent')).toBe('substrate');
    expect(excludedName('GatewayServer')).toBe('gateway');
    expect(excludedName('findingsBus')).toBe('findings bus');
    expect(excludedName('automata_bus')).toBe('automata bus');
    expect(excludedName('wiki-pass.ts')).toBe('wiki');
    expect(excludedName('ChargeLedger')).toBe('charge');
    expect(excludedName('LoopUsage')).toBeNull();
    expect(excludedName('discharged')).toBeNull();
    expect(excludedName('automata')).toBeNull();
    expect(declaredNames('x.ts', 'class SubstrateAgent {}\nconst wikiIndex = 1;\nfunction f(fleet: number) { return fleet; }')).toEqual(['SubstrateAgent', 'wikiIndex', 'f', 'fleet']);
    expect(collectSpecifiers('x.ts', "import { Client } from 'discord.js';\nawait import('@redis/client');").specifiers.filter(excludedPackage)).toHaveLength(2);
    expect(pythonImports('import redis\nfrom discord.ext import commands\nimport json, os')).toEqual(['redis', 'discord.ext', 'json', 'os']);
    expect(pythonNames('class GatewayServer:\n    pass\nWIKI_ROOT = 1\n')).toEqual(['GatewayServer', 'WIKI_ROOT']);
  });
});

describe('excluded subsystems are absent from Lite', () => {
  it('package.json declares none of their packages', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Record<string, unknown>;
    const declared = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']
      .flatMap((k) => Object.keys((manifest[k] as Record<string, string> | undefined) ?? {}));
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter(excludedPackage)).toEqual([]);
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
    expect(productFiles.length).toBeGreaterThan(50);
    const paths = sources.filter((f) => f !== SELF).flatMap((f) => f.split('/').map((segment) => [f, segment, excludedName(segment)] as const)).filter(([, , w]) => w !== null);
    expect(paths.map(([f, segment, w]) => `${f}: ${segment} (${String(w)})`)).toEqual([]);
    const names = productFiles.flatMap((file) => {
      const text = readFileSync(join(REPO, file), 'utf8');
      const declared = file.endsWith('.py') ? pythonNames(text) : /\.(ts|mts|cts|js|mjs|cjs)$/.test(file) ? declaredNames(file, text) : [];
      return declared.map((n) => [file, n, excludedName(n)] as const).filter(([, , w]) => w !== null);
    });
    expect(names.map(([f, n, w]) => `${f}: ${n} (${String(w)})`)).toEqual([]);
  });

  it('no governed tool or action is one of them', () => {
    const names = TOOL_INVENTORY.flatMap((t) => [t.name, ...t.actions.map((a) => `${t.name}.${a.name}`)]);
    expect(names.filter((n) => excludedName(n) !== null)).toEqual([]);
  });
});
