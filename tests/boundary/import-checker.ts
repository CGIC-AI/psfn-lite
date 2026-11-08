import { posix } from 'node:path';
import ts from 'typescript';

/** A core source file, with `path` relative to `packages/core/src` in POSIX form. */
export interface CoreSource {
  readonly path: string;
  readonly text: string;
}

export interface Violation {
  readonly file: string;
  readonly specifier: string;
  readonly rule: string;
}

type Layer =
  | { readonly kind: 'root' }
  | { readonly kind: 'shared' }
  | { readonly kind: 'application' }
  | { readonly kind: 'domain'; readonly name: string }
  | { readonly kind: 'unknown'; readonly name: string };

/** Every module specifier in a file, including type-only, re-export and dynamic forms. */
export function collectSpecifiers(path: string, text: string): { specifiers: string[]; nonLiteral: number } {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  let nonLiteral = 0;
  const literal = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) specifiers.push(node.text);
    else nonLiteral += 1;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) literal(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) literal(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      literal(ts.isLiteralTypeNode(arg) ? arg.literal : undefined);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isDynamicImport || isRequire) literal(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, nonLiteral };
}

/**
 * Enforces inward-only dependencies inside packages/core/src:
 * - nothing outside the package except `node:` builtins;
 * - shared imports only shared;
 * - a domain imports shared, its own files, and other domains only via `<domain>/index.ts`;
 * - application imports shared, application, and domains only via their index;
 * - the root entry re-exports only layer index files;
 * - the domain dependency graph is acyclic.
 */
export function checkCoreImports(files: readonly CoreSource[], domains: readonly string[]): Violation[] {
  const known = new Set(files.map((f) => f.path));
  const violations: Violation[] = [];
  const domainEdges = new Map<string, Set<string>>();

  for (const file of files) {
    const from = classify(file.path, domains);
    if (from.kind === 'unknown') {
      violations.push({ file: file.path, specifier: '', rule: `unknown module directory ${from.name}` });
    }
    const { specifiers, nonLiteral } = collectSpecifiers(file.path, file.text);
    if (nonLiteral > 0) violations.push({ file: file.path, specifier: '', rule: 'module specifier must be a string literal' });
    for (const specifier of specifiers) {
      const rule = checkSpecifier(file.path, from, specifier, known, domains, domainEdges);
      if (rule !== null) violations.push({ file: file.path, specifier, rule });
    }
  }
  for (const cycle of findCycles(domainEdges)) {
    violations.push({ file: `${cycle[0] ?? ''}/index.ts`, specifier: '', rule: `domain dependency cycle ${cycle.join(' -> ')}` });
  }
  return violations;
}

function checkSpecifier(
  path: string,
  from: Layer,
  specifier: string,
  known: ReadonlySet<string>,
  domains: readonly string[],
  domainEdges: Map<string, Set<string>>,
): string | null {
  if (specifier.startsWith('node:')) return null;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return 'imports outside packages/core (only node: builtins allowed)';
  if (!specifier.endsWith('.ts')) return 'relative import must name a .ts file';
  const resolved = posix.normalize(posix.join(posix.dirname(path), specifier));
  if (resolved.startsWith('../')) return 'import escapes packages/core/src';
  if (!known.has(resolved)) return `unresolved import ${resolved}`;
  const to = classify(resolved, domains);
  const isIndex = (layer: string): boolean => resolved === `${layer}/index.ts`;

  switch (from.kind) {
    case 'shared':
      return to.kind === 'shared' ? null : 'shared may import only shared';
    case 'domain':
      if (to.kind === 'shared') return null;
      if (to.kind === 'domain' && to.name === from.name) return null;
      if (to.kind === 'domain') {
        if (!isIndex(to.name)) return `domain ${from.name} must import ${to.name} through ${to.name}/index.ts`;
        addEdge(domainEdges, from.name, to.name);
        return null;
      }
      return `domain ${from.name} may not import ${to.kind}`;
    case 'application':
      if (to.kind === 'shared' || to.kind === 'application') return null;
      if (to.kind === 'domain') return isIndex(to.name) ? null : `application must import ${to.name} through ${to.name}/index.ts`;
      return `application may not import ${to.kind}`;
    case 'root':
      if (to.kind === 'shared' || to.kind === 'application') return isIndex(to.kind) ? null : 'root entry re-exports only layer index files';
      if (to.kind === 'domain') return isIndex(to.name) ? null : 'root entry re-exports only layer index files';
      return 'root entry re-exports only layer index files';
    case 'unknown':
      return null;
  }
}

function classify(path: string, domains: readonly string[]): Layer {
  if (path === 'index.ts') return { kind: 'root' };
  const top = path.split('/')[0] ?? '';
  if (top === 'shared') return { kind: 'shared' };
  if (top === 'application') return { kind: 'application' };
  if (domains.includes(top)) return { kind: 'domain', name: top };
  return { kind: 'unknown', name: top };
}

function addEdge(edges: Map<string, Set<string>>, from: string, to: string): void {
  const targets = edges.get(from) ?? new Set<string>();
  targets.add(to);
  edges.set(from, targets);
}

function findCycles(edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const seen = state.get(next);
      if (seen === 'visiting') cycles.push([...stack.slice(stack.indexOf(next)), next]);
      else if (seen === undefined) visit(next);
    }
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of edges.keys()) if (!state.has(node)) visit(node);
  return cycles;
}
