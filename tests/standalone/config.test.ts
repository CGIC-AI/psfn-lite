/**
 * Standalone configuration is explicit: every setting is required (the
 * embedding block alone has the donor's default), unknown
 * keys are refused, and secrets come from named environment variables whose
 * values are never echoed.
 */
import { describe, expect, it } from 'vitest';
import { parseLiteConfig, readSecrets } from '../../apps/standalone/src/index.ts';
import { DATABASE_URL_ENV, HERMES_TEST_INSTALL_ID as INSTALL_ID, liteConfigDocument } from '../support/lite-world.ts';
import { UNREACHABLE_EMBEDDINGS } from '../support/lite-install.ts';

const COMPANION_ID = '5e1f0c3a-7b2d-4c8e-9a10-2b3c4d5e6f70';
const document = () => liteConfigDocument('/srv/lite/data', COMPANION_ID);
const issuesOf = (raw: unknown) => {
  const parsed = parseLiteConfig(raw);
  return parsed.ok ? [] : parsed.error.kind === 'invalid' ? parsed.error.issues : [parsed.error.kind];
};

describe('standalone configuration', () => {
  it('accepts a complete document', () => {
    const parsed = parseLiteConfig(document());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(parsed.value).toMatchObject({
      companionId: COMPANION_ID,
      workspaceDir: '/srv/lite/data-workspace',
      operator: { userId: 'robin', displayName: 'Robin' },
      contacts: [{ key: 'sam', displayName: 'Sam', trust: 'regular' }],
      embedding: { model: 'test-embedding', dimensions: 16, provider: { kind: 'api', url: UNREACHABLE_EMBEDDINGS, apiKeyEnv: null } },
      sessionIntegrity: { kind: 'keyring' },
      mcp: null,
      lifecycle: null,
    });
  });

  it('refuses unknown keys and missing settings instead of falling back', () => {
    const { sessionIntegrity, ...without } = document();
    expect(issuesOf({ ...without, sessionIntegrety: sessionIntegrity })).toEqual(['sessionIntegrety is not a known setting', 'sessionIntegrity is required']);
    expect(issuesOf({ ...document(), operator: { userId: 'robin' } })).toEqual(['operator.displayName is required']);
  });

  it('refuses out-of-range and malformed values with their paths', () => {
    const issues = issuesOf({
      ...document(),
      companionId: 'companion-test',
      contacts: [{ key: 'operator', displayName: 'Again', trust: 'primary' }, { key: 'sam', displayName: 'Sam', trust: 'regular' }, { key: 'sam', displayName: 'Sam', trust: 'regular' }],
      model: { ...document().model, maxOutputTokens: 0 },
      postgres: { urlEnv: 'postgres://user:pw@host/db' },
      embedding: { model: 'm', dimensions: 3, provider: { kind: 'api', url: 'ftp://x', apiKeyEnv: 'EMBED_KEY' } },
      sessionIntegrity: { kind: 'hmac' },
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        'companionId must be a UUID',
        'contacts[0].key "operator" is the configured operator',
        'contacts[0].trust must be one of trusted, regular, public',
        'contacts[2].key sam is named twice',
        'model.maxOutputTokens must be an integer from 1 to 1000000',
        'postgres.urlEnv must be an environment variable name',
        'embedding.provider.url must be an http(s) URL',
        'sessionIntegrity.kind must be one of keyring, unsigned',
      ]),
    );
  });

  it('keeps the companion workspace out of the data directory, as the donor keeps it out of its state roots', () => {
    const overlap = 'workspaceDir must not be dataDir or inside it, nor contain it';
    expect(issuesOf({ ...document(), workspaceDir: '/srv/lite/data' })).toEqual([overlap]);
    expect(issuesOf({ ...document(), workspaceDir: '/srv/lite/data/workspace' })).toEqual([overlap]);
    expect(issuesOf({ ...document(), workspaceDir: '/srv/lite' })).toEqual([overlap]);
    expect(issuesOf({ ...document(), workspaceDir: '/srv/lite/data-workspace' })).toEqual([]);
  });

  it('mounts the MCP transport and the lifecycle bridge only together', () => {
    const listen = { host: '127.0.0.1', port: 0, allowedHosts: null };
    expect(issuesOf({ ...document(), mcp: { ...listen, bindings: [{ principal: 'p', credential: { env: 'P' }, contact: 'operator' }] } })).toEqual([
      'mcp needs lifecycle: companion tools run only inside host-driven turns',
    ]);
    expect(issuesOf({ ...document(), lifecycle: { ...listen, hermesInstallId: INSTALL_ID, hostTurnTimeoutMs: 60_000, automata: null } })).toEqual(['lifecycle needs mcp: the bridge shares its principal bindings']);
    expect(issuesOf({ ...document(), mcp: { ...listen, bindings: [] }, lifecycle: { ...listen, hermesInstallId: INSTALL_ID, hostTurnTimeoutMs: 10, automata: null } })).toEqual([
      'mcp.bindings must be a non-empty list of principal bindings',
      'lifecycle.hostTurnTimeoutMs must be an integer from 1000 to 86400000',
    ]);
  });

  it('reads the hosted automata policy strictly: every field, in range, or null', () => {
    const listen = { host: '127.0.0.1', port: 0, allowedHosts: null };
    const mcp = { ...listen, bindings: [{ principal: 'p', credential: { env: 'P' }, contact: 'operator' }] };
    const policy = { maxAttempts: 3, leaseMs: 60_000, maxIterations: 250 };
    const parsed = parseLiteConfig({ ...document(), mcp, lifecycle: { ...listen, hermesInstallId: INSTALL_ID, hostTurnTimeoutMs: 60_000, automata: policy } });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(parsed.value.lifecycle?.automata).toEqual(policy);
    expect(issuesOf({ ...document(), mcp, lifecycle: { ...listen, hermesInstallId: INSTALL_ID, hostTurnTimeoutMs: 60_000 } })).toEqual(['lifecycle.automata is required']);
    expect(issuesOf({ ...document(), mcp, lifecycle: { ...listen, hermesInstallId: INSTALL_ID, hostTurnTimeoutMs: 60_000, automata: { maxAttempts: 0, leaseMs: 60_000 } } })).toEqual([
      'lifecycle.automata.maxIterations is required',
      'lifecycle.automata.maxAttempts must be an integer from 1 to 100',
    ]);
  });

  it('reads the light Garden block strictly, and leaves it off without one', () => {
    expect(parseLiteConfig(document())).toMatchObject({ ok: true, value: { garden: null } });
    const garden = {
      host: '127.0.0.1',
      port: 0,
      allowedHosts: null,
      maxBodyBytes: 65_536,
      recentTurnLimit: 12,
      bindings: [{ principal: 'garden', credential: { env: 'GARDEN_TOKEN' }, contact: 'operator' }],
    };
    const parsed = parseLiteConfig({ ...document(), garden });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(parsed.value.garden).toEqual(garden);
    expect(parseLiteConfig({ ...document(), garden: null })).toMatchObject({ ok: true, value: { garden: null } });
    const { recentTurnLimit: _left, ...partial } = garden;
    expect(issuesOf({ ...document(), garden: { ...partial, maxBodyBytes: 10, bindings: [], extra: 1 } })).toEqual([
      'garden.extra is not a known setting',
      'garden.recentTurnLimit is required',
      'garden.bindings must be a non-empty list of principal bindings',
      'garden.maxBodyBytes must be an integer from 1024 to 16777216',
    ]);
  });

  it('reads secrets from the named environment variables and names a missing one without its value', () => {
    const parsed = parseLiteConfig({ ...document(), model: { ...document().model, apiKeyEnv: 'LITE_MODEL_KEY' } });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(readSecrets(parsed.value, { [DATABASE_URL_ENV]: 'postgres://x', LITE_MODEL_KEY: 'k' })).toEqual({
      ok: true,
      value: { databaseUrl: 'postgres://x', modelApiKey: 'k' },
    });
    const missing = readSecrets(parsed.value, { [DATABASE_URL_ENV]: 'postgres://user:hunter2@db/lite' });
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ kind: 'invalid', issues: ['environment variable LITE_MODEL_KEY is not set'] }) as unknown });
    expect(JSON.stringify(missing)).not.toContain('hunter2');
  });
});
