/**
 * Plain JSON Schema fragments for describing tool arguments to MCP clients.
 * They describe; they do not authorize or validate. Core's argument readers
 * stay the single authority on what a call accepts.
 */

export type JsonSchema = Readonly<Record<string, unknown>>;

/** One argument of one inventory action. */
export interface ArgumentSpec {
  readonly schema: JsonSchema;
  readonly required: boolean;
}

/** The arguments an action accepts, keyed by name. */
export type ActionArguments = Readonly<Record<string, ArgumentSpec>>;

/** Per-tool, per-action argument descriptions. */
export type ToolArguments = Readonly<Record<string, ActionArguments>>;

/** Mirrors the `withArgs` list limit core applies. */
export const LIMIT_RANGE = { min: 1, max: 200 } as const;

const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$';

export const schema = {
  text: (description: string): JsonSchema => ({ type: 'string', description }),
  nonEmpty: (description: string): JsonSchema => ({ type: 'string', minLength: 1, description }),
  id: (description: string): JsonSchema => ({ type: 'string', pattern: ID_PATTERN, description }),
  integer: (description: string, range: { readonly min: number; readonly max: number }): JsonSchema => ({
    type: 'integer',
    minimum: range.min,
    maximum: range.max,
    description,
  }),
  boolean: (description: string): JsonSchema => ({ type: 'boolean', description }),
  oneOf: (description: string, values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values], description }),
  strings: (description: string): JsonSchema => ({ type: 'array', items: { type: 'string', minLength: 1 }, description }),
  array: (description: string, items: JsonSchema): JsonSchema => ({ type: 'array', items, description }),
  object: (description: string, properties: Readonly<Record<string, JsonSchema>>, required: readonly string[] = []): JsonSchema => ({
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: false,
    description,
  }),
  instant: (description: string): JsonSchema => ({ type: 'string', description: `${description} (ISO 8601 instant with zone, or YYYY-MM-DD)` }),
  anyOf: (description: string, options: readonly JsonSchema[]): JsonSchema => ({ anyOf: [...options], description }),
} as const;

export const required = (s: JsonSchema): ArgumentSpec => ({ schema: s, required: true });
export const optional = (s: JsonSchema): ArgumentSpec => ({ schema: s, required: false });

/** The optional `limit` most list actions take. */
export const limit = (): ArgumentSpec => optional(schema.integer('Maximum number of items to return (default 20).', LIMIT_RANGE));

export const NO_ARGUMENTS: ActionArguments = {};
