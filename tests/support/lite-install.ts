/**
 * The pieces of a standalone install a test builds, with no vitest import so
 * a child process (the conformance host) can use them too: the config
 * document, the character card, the database the core's PostgreSQL stores
 * expect, and random transport credentials.
 */
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { EMBEDDING_DIMS } from './embeddings.ts';

export const DATABASE_URL_ENV = 'LITE_TEST_DATABASE_URL';
export const COMPANION_NAME = 'Lumen';
/** The donor session keyring variable (persistence/journals/hmac-boundary.ts); every test install signs its journals. */
export const SESSION_KEYS_ENV = 'GATEWAY_SESSION_HMAC_KEYS';
/** The Hermes install the test bridges serve. An install id names a binding and is not a secret. */
export const HERMES_TEST_INSTALL_ID = '5e1f0c2d9a8b47e6b3c4d5e6f7a8b9c0';
/** An embeddings endpoint nothing listens on (the discard port). */
export const UNREACHABLE_EMBEDDINGS = 'http://127.0.0.1:9/v1/embeddings';

/** A data directory and, beside it, the companion's workspace. */
export function liteConfigDocument(dataDir: string, companionId: string) {
  return {
    companionId,
    dataDir,
    workspaceDir: `${dataDir}-workspace`,
    characterCardPath: join(dataDir, 'character-card.json'),
    operator: { userId: 'robin', displayName: 'Robin' },
    contacts: [{ key: 'sam', displayName: 'Sam', trust: 'regular' }],
    postgres: { urlEnv: DATABASE_URL_ENV },
    model: { provider: 'faux', modelId: 'faux-1', apiKeyEnv: null, maxOutputTokens: 1024 },
    // The tests hand the core their own port for this model (deterministicEmbeddings); the donor api provider the block names
    // points at a port nothing listens on, so a start without that port fails at the donor's startup warmup, never embeds.
    // Left out (undefined), the donor's default transformers provider applies.
    embedding: { model: 'test-embedding', dimensions: EMBEDDING_DIMS, provider: { kind: 'api', url: UNREACHABLE_EMBEDDINGS, apiKeyEnv: null } } as Record<string, unknown> | undefined,
    sessionIntegrity: { kind: 'keyring' as 'keyring' | 'unsigned' },
    mcp: null as Record<string, unknown> | null,
    lifecycle: null as Record<string, unknown> | null,
    // Left out (undefined), no light Garden is mounted.
    garden: undefined as Record<string, unknown> | undefined,
  };
}

export type LiteConfigDocument = ReturnType<typeof liteConfigDocument>;

export async function writeCharacterCard(path: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: COMPANION_NAME, description: 'Test identity.', personality: 'Calm.', scenario: 'Test.', first_mes: 'Hello.', mes_example: '', creator: 'lite-test', tags: [] },
  }));
}

/** Provisions the donor's extension schema in a fresh database, as the donor's test harness did. */
export async function provisionDatabase(url: string): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS extensions');
  } finally {
    await client.end();
  }
  return url;
}

/** A fresh random session keyring, as the keyring variable holds it (`<version>:<key>`). */
export function newSessionKeys(): string {
  return `v1:${randomBytes(32).toString('hex')}`;
}

/** A fresh random transport credential (never a fixed test secret). */
export function newCredential(): string {
  return randomBytes(32).toString('base64url');
}
