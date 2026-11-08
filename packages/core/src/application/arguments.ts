import { invalid, isOneOf, ok, parseId, type Id, type Result } from '../shared/index.ts';

type Args = Readonly<Record<string, unknown>>;

/**
 * Strict reader for model-supplied tool arguments. Unknown keys, wrong types
 * and out-of-range values are collected as issues; a handler runs only when
 * there are none. Nothing is defaulted silently except a documented `fallback`.
 */
export class ArgReader {
  readonly issues: string[] = [];

  constructor(private readonly args: Args) {}

  string(key: string): string {
    const value = this.args[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    this.issues.push(`${key} must be a non-empty string`);
    return '';
  }

  /** Accepts an empty string; for texts where emptiness is meaningful (a replacement). */
  text(key: string): string {
    const value = this.args[key];
    if (typeof value === 'string') return value;
    this.issues.push(`${key} must be a string`);
    return '';
  }

  optionalString(key: string): string | null {
    return this.args[key] === undefined ? null : this.string(key);
  }

  integer(key: string, range: { readonly min: number; readonly max: number; readonly fallback?: number }): number {
    const value = this.args[key];
    if (value === undefined && range.fallback !== undefined) return range.fallback;
    if (typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max) return value;
    this.issues.push(`${key} must be an integer from ${range.min} to ${range.max}`);
    return range.min;
  }

  optionalInteger(key: string, range: { readonly min: number; readonly max: number }): number | null {
    return this.args[key] === undefined ? null : this.integer(key, range);
  }

  boolean(key: string, fallback?: boolean): boolean {
    const value = this.args[key];
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value === 'boolean') return value;
    this.issues.push(`${key} must be a boolean`);
    return false;
  }

  optionalBoolean(key: string): boolean | undefined {
    return this.args[key] === undefined ? undefined : this.boolean(key);
  }

  oneOf<T extends string>(key: string, allowed: readonly T[], fallback?: T): T {
    const value = this.args[key];
    if (value === undefined && fallback !== undefined) return fallback;
    if (isOneOf(allowed, value)) return value;
    this.issues.push(`${key} must be one of ${allowed.join(', ')}`);
    return allowed[0] as T;
  }

  optionalOneOf<T extends string>(key: string, allowed: readonly T[]): T | null {
    return this.args[key] === undefined ? null : this.oneOf(key, allowed);
  }

  id<Kind extends string>(kind: Kind, key: string): Id<Kind> {
    const parsed = parseId(kind, this.args[key]);
    if (parsed.ok) return parsed.value;
    this.issues.push(`${key}: ${parsed.error.kind === 'invalid' ? parsed.error.issues.join('; ') : 'invalid id'}`);
    return '' as Id<Kind>;
  }

  optionalId<Kind extends string>(kind: Kind, key: string): Id<Kind> | null {
    return this.args[key] === undefined ? null : this.id(kind, key);
  }

  stringArray(key: string): readonly string[] {
    const value = this.args[key];
    if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)) return value;
    this.issues.push(`${key} must be an array of non-empty strings`);
    return [];
  }

  has(key: string): boolean {
    return this.args[key] !== undefined;
  }
}

/** Parses arguments against the keys an action accepts. */
export function parseArgs<T>(args: Args, allowed: readonly string[], build: (reader: ArgReader) => T): Result<T> {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) return invalid(`unknown arguments: ${unknown.join(', ')}`);
  const reader = new ArgReader(args);
  const value = build(reader);
  if (reader.issues.length > 0) return invalid(...reader.issues);
  return ok(value);
}

export const LIMIT = { min: 1, max: 200, fallback: 20 } as const;

/** Parses arguments, then runs the operation with the parsed input. */
export async function withArgs<T>(
  args: Args,
  allowed: readonly string[],
  build: (reader: ArgReader) => T,
  run: (input: T) => Promise<Result<unknown>>,
): Promise<Result<unknown>> {
  const parsed = parseArgs(args, allowed, build);
  return parsed.ok ? run(parsed.value) : parsed;
}
