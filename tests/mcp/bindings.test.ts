/**
 * Operator binding configuration and credential loading. Credentials come
 * only from the environment or owner-only files, are refused when weak or
 * reused, and never appear in an error.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildToolCatalog, bearerCredential, loadPrincipalBindings, startMcpHttpServer, ACTION_ARGUMENTS, type McpSurface } from '../../packages/mcp/src/index.ts';
import { TOOL_INVENTORY } from '../../packages/core/src/index.ts';
import { BINDINGS } from './mcp-world.ts';

const STRONG = 'k'.repeat(24) + 'Q7-x_9.Z';
const OTHER = 'm'.repeat(24) + 'Q7-x_9.Z';
const attestation = BINDINGS.primary;
const binding = (principal: string, credential: unknown, extra: Record<string, unknown> = {}) => ({ principal, credential, attestation, ...extra });

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
  it('loads credentials from the environment and from owner-only files and authenticates them', async () => {
    const path = secretFile(`${OTHER}\n`, 0o600);
    const loaded = loadPrincipalBindings({ bindings: [binding('robin', { env: 'ROBIN_TOKEN' }), binding('robin-file', { file: path })] }, { ROBIN_TOKEN: STRONG });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    expect(loaded.value.principals).toEqual(['robin', 'robin-file']);
    expect(loaded.value.identify(STRONG)).toBe('robin');
    expect(loaded.value.identify(OTHER)).toBe('robin-file');
    expect(loaded.value.identify(`${STRONG}x`)).toBeNull();
    expect(await loaded.value.authenticator.authenticate({ kind: 'mcp_credential', credential: STRONG })).toEqual({ ok: true, value: attestation });
    for (const evidence of [{ kind: 'mcp_credential', credential: OTHER.slice(1) }, { kind: 'bearer', credential: STRONG }, STRONG, null, { kind: 'mcp_credential' }]) {
      expect(await loaded.value.authenticator.authenticate(evidence)).toMatchObject({ ok: false, error: { kind: 'denied', reason: 'unknown_authority' } });
    }
  });

  it.each([
    ['an inline credential value', { bindings: [binding('robin', STRONG)] }, 'never configured inline'],
    ['an inline value under another key', { bindings: [binding('robin', { value: STRONG })] }, 'never configured inline'],
    ['a relative credential file', { bindings: [binding('robin', { file: 'secrets/robin' })] }, 'never configured inline'],
    ['an unset variable', { bindings: [binding('robin', { env: 'MISSING_TOKEN' })] }, 'MISSING_TOKEN is not set'],
    ['a weak credential', { bindings: [binding('robin', { env: 'SHORT_TOKEN' })] }, 'printable characters'],
    ['a credential with whitespace', { bindings: [binding('robin', { env: 'SPACED_TOKEN' })] }, 'printable characters'],
    ['a principal bound twice', { bindings: [binding('robin', { env: 'ROBIN_TOKEN' }), binding('robin', { env: 'OTHER_TOKEN' })] }, 'bound twice'],
    ['a credential bound twice', { bindings: [binding('robin', { env: 'ROBIN_TOKEN' }), binding('sam', { env: 'COPY_TOKEN' })] }, 'already bound'],
    ['an unknown binding key', { bindings: [binding('robin', { env: 'ROBIN_TOKEN' }, { trust: 'primary' })] }, 'must have only'],
    ['a malformed attestation', { bindings: [{ principal: 'robin', credential: { env: 'ROBIN_TOKEN' }, attestation: { surface: 'mcp', principal: { kind: 'root' } } }] }, 'principal.kind'],
    ['a missing turn kind', { bindings: [binding('robin', { env: 'ROBIN_TOKEN' }, { attestation: { ...attestation, turnKind: undefined } })] }, 'turnKind'],
    ['no bindings', { bindings: [] }, 'at least one binding'],
    ['another top-level key', { bindings: [], tokens: [] }, 'must be { "bindings"'],
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
    const result = loadPrincipalBindings({ bindings: [binding('robin', { file: shared })] }, {});
    expect(issues(result).join()).toContain('must not be readable by group or others');
    expect(issues(result).join()).not.toContain(STRONG);
    const dir = mkdtempSync(join(tmpdir(), 'lite-mcp-'));
    dirs.push(dir);
    expect(issues(loadPrincipalBindings({ bindings: [binding('robin', { file: dir })] }, {})).join()).toContain('not a regular file');
    expect(issues(loadPrincipalBindings({ bindings: [binding('robin', { file: join(dir, 'missing') })] }, {})).join()).toContain('could not be read (ENOENT)');
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

  it('refuses a catalog whose argument descriptions do not match the inventory', () => {
    const { memory: _memory, ...withoutMemory } = ACTION_ARGUMENTS;
    expect(issues(buildToolCatalog(TOOL_INVENTORY, withoutMemory)).join()).toContain('no argument description for memory.search');
    const extra = { ...ACTION_ARGUMENTS, memory: { ...ACTION_ARGUMENTS['memory'], redact: {} } };
    expect(issues(buildToolCatalog(TOOL_INVENTORY, extra)).join()).toContain('unknown action memory.redact');
    expect(issues(buildToolCatalog(TOOL_INVENTORY, { ...ACTION_ARGUMENTS, wiki: {} })).join()).toContain('unknown tool wiki');
  });
});
