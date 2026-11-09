/**
 * Operator principal bindings and credential loading. Credentials come only
 * from the environment or owner-only files, are refused when weak or reused,
 * and never appear in an error. Each principal names one host contact key.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bearerCredential, loadPrincipalBindings, startMcpHttpServer, type McpSurface } from '../../packages/mcp/src/index.ts';

const STRONG = 'k'.repeat(24) + 'Q7-x_9.Z';
const OTHER = 'm'.repeat(24) + 'Q7-x_9.Z';
const binding = (principal: string, credential: unknown, extra: Record<string, unknown> = {}) => ({ principal, credential, contact: 'operator', ...extra });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function secretFile(content: string, mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'lite-mcp-'));
  dirs.push(dir);
  const path = join(dir, 'credential');
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

const issues = (result: { ok: boolean; error?: { kind: string; issues?: readonly string[] } }) => (result.ok ? [] : (result.error?.issues ?? [result.error?.kind ?? '']));

describe('principal bindings', () => {
  it('loads credentials from the environment and from owner-only files and identifies them', () => {
    const path = secretFile(`${OTHER}\n`, 0o600);
    const loaded = loadPrincipalBindings([binding('robin', { env: 'ROBIN_TOKEN' }), binding('robin-file', { file: path }, { contact: 'sam' })], { ROBIN_TOKEN: STRONG });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    expect(loaded.value.bindings).toEqual([{ principal: 'robin', contact: 'operator' }, { principal: 'robin-file', contact: 'sam' }]);
    expect(loaded.value.identify(STRONG)).toBe('robin');
    expect(loaded.value.identify(OTHER)).toBe('robin-file');
    expect(loaded.value.identify(`${STRONG}x`)).toBeNull();
    expect(loaded.value.identify(OTHER.slice(1))).toBeNull();
    expect(loaded.value.contactOf('robin-file')).toBe('sam');
    expect(loaded.value.contactOf('nobody')).toBeNull();
  });

  it.each([
    ['an inline credential value', [binding('robin', STRONG)], 'never configured inline'],
    ['an inline value under another key', [binding('robin', { value: STRONG })], 'never configured inline'],
    ['a relative credential file', [binding('robin', { file: 'secrets/robin' })], 'never configured inline'],
    ['an unset variable', [binding('robin', { env: 'MISSING_TOKEN' })], 'MISSING_TOKEN is not set'],
    ['a weak credential', [binding('robin', { env: 'SHORT_TOKEN' })], 'printable characters'],
    ['a credential with whitespace', [binding('robin', { env: 'SPACED_TOKEN' })], 'printable characters'],
    ['a principal bound twice', [binding('robin', { env: 'ROBIN_TOKEN' }), binding('robin', { env: 'OTHER_TOKEN' })], 'bound twice'],
    ['a credential bound twice', [binding('robin', { env: 'ROBIN_TOKEN' }), binding('sam', { env: 'COPY_TOKEN' })], 'already bound'],
    ['an unknown binding key', [binding('robin', { env: 'ROBIN_TOKEN' }, { trust: 'primary' })], 'must have only'],
    ['a malformed contact key', [binding('robin', { env: 'ROBIN_TOKEN' }, { contact: 'Operator!' })], 'must name a configured contact key'],
    ['no bindings', [], 'at least one binding'],
    ['a document instead of a list', { bindings: [] }, 'bindings must be a list'],
  ])('refuses %s', (_label, config, expected) => {
    const env = { ROBIN_TOKEN: STRONG, OTHER_TOKEN: OTHER, COPY_TOKEN: STRONG, SHORT_TOKEN: 'abc', SPACED_TOKEN: `${STRONG} ${STRONG}` };
    const result = loadPrincipalBindings(config, env);
    expect(result.ok).toBe(false);
    const text = issues(result).join('\n');
    expect(text).toContain(expected);
    expect(text).not.toContain(STRONG);
    expect(text).not.toContain('abc');
  });

  it('refuses a credential file others can read, or one that is not a file', () => {
    const shared = secretFile(STRONG, 0o644);
    const result = loadPrincipalBindings([binding('robin', { file: shared })], {});
    expect(issues(result).join()).toContain('must not be readable by group or others');
    expect(issues(result).join()).not.toContain(STRONG);
    const dir = mkdtempSync(join(tmpdir(), 'lite-mcp-'));
    dirs.push(dir);
    expect(issues(loadPrincipalBindings([binding('robin', { file: dir })], {})).join()).toContain('not a regular file');
    expect(issues(loadPrincipalBindings([binding('robin', { file: join(dir, 'missing') })], {})).join()).toContain('could not be read (ENOENT)');
  });

  it('parses only well-formed bearer headers', () => {
    expect(bearerCredential(`Bearer ${STRONG}`)).toBe(STRONG);
    expect(bearerCredential(`bearer ${STRONG}`)).toBe(STRONG);
    for (const header of [undefined, '', `Basic ${STRONG}`, `Bearer ${STRONG} extra`, 'Bearer', ['Bearer a', 'Bearer b']]) expect(bearerCredential(header)).toBeNull();
  });
});

describe('transport configuration', () => {
  it('binds loopback unless the operator opts out explicitly', async () => {
    const surface = {} as McpSurface;
    const bindings = { identify: () => null };
    const onError = () => undefined;
    expect(await startMcpHttpServer({ surface, bindings, port: 0, host: '0.0.0.0', onError })).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(await startMcpHttpServer({ surface, bindings, port: 0, host: '0.0.0.0', exposeBeyondLoopback: { allowedHosts: [] }, onError })).toMatchObject({ ok: false });
    expect(await startMcpHttpServer({ surface, bindings, port: 0, path: 'mcp', onError })).toMatchObject({ ok: false });
  });
});
