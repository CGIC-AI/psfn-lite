/**
 * Standalone configuration is explicit: every setting is required, unknown
 * keys are refused, policies are the core baseline only when named so, and
 * secrets come from named environment variables whose values are never
 * echoed.
 */
import { describe, expect, it } from 'vitest';
import { BASELINE_FREE_TIME_POLICY } from '../../packages/core/src/index.ts';
import { parseLiteConfig, readSecrets } from '../../apps/standalone/src/index.ts';
import { DATABASE_URL_ENV, liteConfigDocument } from './lite-config.ts';

const document = () => liteConfigDocument({ history: '/srv/lite/history', workspace: '/srv/lite/workspace', backups: null });
const issuesOf = (raw: unknown) => {
  const parsed = parseLiteConfig(raw);
  return parsed.ok ? [] : parsed.error.kind === 'invalid' ? parsed.error.issues : [parsed.error.kind];
};

describe('standalone configuration', () => {
  it('accepts a complete document and names the baseline policies explicitly', () => {
    const parsed = parseLiteConfig(document());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(parsed.value.policies.freeTime).toBe(BASELINE_FREE_TIME_POLICY);
    expect(parsed.value.storage.backupRoot).toBeNull();
    expect(parsed.value.embedding.provider).toEqual({ kind: 'disabled' });
  });

  it('refuses unknown keys and missing settings instead of falling back', () => {
    const raw = document() as Record<string, unknown>;
    const { harness, ...withoutHarness } = raw;
    expect(issuesOf({ ...withoutHarness, harnes: harness })).toEqual(['harnes is not a known setting', 'harness is required']);
    const noLease = { ...document(), workers: { maxAttempts: 2, resumeGraceMs: 60_000 } };
    expect(issuesOf(noLease)).toEqual(['workers.leaseMs is required']);
    const noPolicy = { ...document(), policies: { disclosure: 'baseline', emotion: 'baseline' } };
    expect(issuesOf(noPolicy)).toEqual(['policies.freeTime is required']);
  });

  it('refuses out-of-range and malformed values with their paths', () => {
    const raw = {
      ...document(),
      operator: { ...document().operator, trust: 'owner' },
      harness: { ...document().harness, maxModelCalls: 0 },
      postgres: { urlEnv: 'postgres://user:pw@host/db' },
      embedding: { space: { name: 's', dimensions: 3 }, provider: { kind: 'openai_compatible', baseUrl: 'ftp://x', model: 'm', apiKeyEnv: 'EMBED_KEY', timeoutMs: 1_000 } },
      policies: { ...document().policies, freeTime: { version: 1 } },
    };
    const issues = issuesOf(raw);
    expect(issues).toEqual(
      expect.arrayContaining([
        'operator.trust must be one of public, regular, trusted, primary',
        'harness.maxModelCalls must be an integer from 1 to 100',
        'postgres.urlEnv must name an environment variable',
        'embedding.provider.baseUrl must be an http(s) URL',
      ]),
    );
    expect(issues.some((issue) => issue.startsWith('policies.freeTime: '))).toBe(true);
  });

  it('reads secrets from the named environment variables and names a missing one without its value', () => {
    const parsed = parseLiteConfig({ ...document(), model: { ...document().model, apiKeyEnv: 'LITE_MODEL_KEY' } });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(readSecrets(parsed.value, { [DATABASE_URL_ENV]: 'postgres://x', LITE_MODEL_KEY: 'k' })).toEqual({
      ok: true,
      value: { databaseUrl: 'postgres://x', modelApiKey: 'k', embeddingApiKey: null },
    });
    const missing = readSecrets(parsed.value, { [DATABASE_URL_ENV]: 'postgres://user:hunter2@db/lite' });
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ kind: 'invalid', issues: ['environment variable LITE_MODEL_KEY is not set'] }) as unknown });
    expect(JSON.stringify(missing)).not.toContain('hunter2');
  });
});
