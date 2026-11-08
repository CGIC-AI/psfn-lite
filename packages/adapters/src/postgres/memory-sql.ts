/**
 * SQL shared by the memory, episode and journal stores: the core access
 * predicates (`memoryReadable`, `episodeReadable`, `journalReadable`)
 * rendered as WHERE fragments, so withheld rows never reach ranking, limits
 * or counts; lexical queries; and per-space pgvector handling.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { invalid, lexicalTokens, ok, type EmbeddingSpace, type Result, type SourceAccess } from '../core.ts';
import { guarded, type Queryable } from './database.ts';

/** Positional parameters collected while a query is built. */
export class SqlParams {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${String(this.values.length)}`;
  }
}

/** `sourceReadable` over a row's source conversation and disclosure class columns. */
export function sourceSql(access: SourceAccess, params: SqlParams, conversation: string, sourceClass: string): string {
  const self = params.add(access.selfSource);
  const own = params.add(access.ownConversations);
  const classes = params.add(access.sourceClasses);
  return `((${conversation} = 'self' AND ${self}::boolean) OR (${conversation} <> 'self' AND (${conversation} = ANY(${own}::text[]) OR ${sourceClass} = ANY(${classes}::text[]))))`;
}

/** `memoryReadable` for the `memories` row aliased `m`. */
export function memoryAccessSql(access: SourceAccess, params: SqlParams, m = 'm'): string {
  const sensitivities = params.add(access.sensitivities);
  const parts = [`${m}.state = 'current'`, `${m}.sensitivity = ANY(${sensitivities}::text[])`, sourceSql(access, params, `${m}.source_conversation`, `${m}.source_class`)];
  if (access.subjects.kind === 'bound') {
    const contacts = params.add(access.subjects.contactIds);
    const rooms = params.add(access.subjects.roomChannelIds);
    parts.push(
      `((${m}.subject_kind = 'contacts' AND ${m}.subject_contacts && ${contacts}::text[]) OR (${m}.subject_kind = 'room' AND ${m}.subject_channel = ANY(${rooms}::text[])))`,
    );
  }
  return parts.join(' AND ');
}

/** `episodeReadable` for the `episodes` row aliased `e`. */
export function episodeAccessSql(access: SourceAccess, params: SqlParams, e = 'e'): string {
  const parts = [`${e}.lifecycle <> 'merged'`, sourceSql(access, params, `${e}.source_conversation`, `${e}.source_class`)];
  if (access.subjects.kind === 'bound') {
    const rooms = params.add(access.subjects.roomChannelIds);
    const contacts = params.add(access.subjects.contactIds);
    parts.push(`((${e}.source_channel IS NOT NULL AND ${e}.source_channel = ANY(${rooms}::text[])) OR ${e}.participants && ${contacts}::text[])`);
  }
  return parts.join(' AND ');
}

/** `journalReadable` for the `journal_notes` row aliased `j`. */
export function journalAccessSql(access: SourceAccess, params: SqlParams, j = 'j'): string {
  const confidential = params.add(access.sensitivities.includes('confidential'));
  return `((${j}.scope = 'restricted' AND ${confidential}::boolean) OR (${j}.scope = 'conversation' AND ${sourceSql(access, params, `${j}.source_conversation`, `${j}.source_class`)}))`;
}

/**
 * A full-text query matching any content token of `query` (the same tokens
 * evolution compares), or null when the query has none.
 */
export function anyTokenQuery(query: string): string | null {
  const tokens = lexicalTokens(query).map((t) => t.replaceAll("'", ''));
  const usable = tokens.filter((t) => t.length > 0);
  return usable.length === 0 ? null : usable.join(' or ');
}

/** The pgvector text form of a vector of the space's dimensions; anything else fails closed. */
export function vectorLiteral(space: EmbeddingSpace, values: readonly number[]): Result<string> {
  if (values.length !== space.dimensions) return invalid(`embedding has ${String(values.length)} dimensions; space ${space.name} has ${String(space.dimensions)}`);
  if (!values.every((v) => Number.isFinite(v))) return invalid('embedding values must be finite numbers');
  return ok(`[${values.join(',')}]`);
}

export function parseVector(text: string | null): number[] | null {
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) && parsed.every((v) => typeof v === 'number') ? parsed : null;
}

const SPACE_NAME = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const EMBEDDING_TABLES = ['memory_embeddings', 'episode_embeddings'] as const;
export type EmbeddingTable = (typeof EMBEDDING_TABLES)[number];

/**
 * The space as SQL text. The name and size are interpolated into index
 * definitions and queries (an expression index must match the query text),
 * so both are validated against the core space rule here as well.
 */
export function spaceSql(space: EmbeddingSpace): Result<{ readonly literal: string; readonly cast: string }> {
  if (!SPACE_NAME.test(space.name)) return invalid('embedding space name must be 1-64 characters of [a-z0-9:._-]');
  if (!Number.isInteger(space.dimensions) || space.dimensions < 1 || space.dimensions > 4000) return invalid('embedding space dimensions must be 1-4000');
  return ok({ literal: `'${space.name}'`, cast: `vector(${String(space.dimensions)})` });
}

export function embeddingIndexName(table: EmbeddingTable, space: EmbeddingSpace): string {
  const tag = createHash('sha256').update(`${space.name}:${String(space.dimensions)}`).digest('hex').slice(0, 16);
  return `${table}_hnsw_${tag}`;
}

/**
 * Creates the partial HNSW cosine index of one space on both embedding
 * tables. Rows of that space with other dimensions make this fail, which
 * stops startup instead of searching a mixed space.
 */
export async function ensureEmbeddingIndexes(pool: pg.Pool, space: EmbeddingSpace): Promise<Result<void>> {
  const sql = spaceSql(space);
  if (!sql.ok) return sql;
  return guarded(async () => {
    for (const table of EMBEDDING_TABLES) {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${embeddingIndexName(table, space)} ON ${table} USING hnsw ((embedding::${sql.value.cast}) vector_cosine_ops) WHERE space = ${sql.value.literal}`,
      );
    }
    return ok(undefined);
  });
}

/** Upserts one vector of a space for a memory or an episode. */
export async function putVector(db: Queryable, table: 'memory_embeddings' | 'episode_embeddings', key: string, id: string, space: EmbeddingSpace, values: readonly number[]): Promise<Result<void>> {
  const literal = vectorLiteral(space, values);
  if (!literal.ok) return literal;
  await db.query(
    `INSERT INTO ${table} (${key}, space, dimensions, embedding) VALUES ($1, $2, $3, $4::vector)
     ON CONFLICT (${key}, space) DO UPDATE SET dimensions = EXCLUDED.dimensions, embedding = EXCLUDED.embedding`,
    [id, space.name, space.dimensions, literal.value],
  );
  return ok(undefined);
}

/**
 * Lets a filtered HNSW scan keep walking the graph until enough rows pass
 * the access filter, instead of returning fewer than `limit` neighbours.
 */
export async function iterativeScan(db: Queryable): Promise<void> {
  await db.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
}
