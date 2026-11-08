/**
 * Standalone configuration: one explicit, validated document. Every setting
 * is required; there are no hidden defaults. Policies are either the core
 * baseline, named explicitly as "baseline", or a full owner document that
 * core validates. Secrets are never in the file: it names the environment
 * variables that hold the database URL and the provider keys, and those are
 * read once at start. Unknown keys are rejected so a typo cannot silently
 * fall back to anything.
 */
import {
  BASELINE_DISCLOSURE_POLICY,
  BASELINE_EMOTION_POLICY,
  BASELINE_FREE_TIME_POLICY,
  HUMAN_RELATIONSHIPS,
  SENSITIVITIES,
  TRUST_LEVELS,
  invalid,
  isOneOf,
  isRecord,
  ok,
  parseDisclosurePolicy,
  parseEmotionPolicy,
  parseFreeTimePolicy,
  parseId,
  type CompanionId,
  type DisclosurePolicy,
  type EmotionPolicy,
  type FreeTimePolicy,
  type HumanRelationship,
  type Result,
  type Sensitivity,
  type SurfaceId,
  type TrustLevel,
} from './core.ts';

export interface LiteConfig {
  readonly companionId: CompanionId;
  readonly surface: SurfaceId;
  /** The primary operator, who talks to the companion through this CLI. */
  readonly operator: {
    readonly displayName: string;
    readonly channelKind: string;
    readonly externalId: string;
    /** The direct conversation's channel id. */
    readonly channelId: string;
    readonly trust: TrustLevel;
    readonly relationship: HumanRelationship;
    /** How protected the operator's own contact record is. */
    readonly sensitivity: Sensitivity;
  };
  readonly storage: { readonly historyRoot: string; readonly workspaceRoot: string; readonly backupRoot: string | null };
  readonly postgres: { readonly urlEnv: string };
  readonly model: { readonly provider: string; readonly modelId: string; readonly apiKeyEnv: string | null; readonly maxOutputTokens: number };
  readonly embedding: {
    readonly space: { readonly name: string; readonly dimensions: number };
    readonly provider:
      | { readonly kind: 'disabled' }
      | { readonly kind: 'openai_compatible'; readonly baseUrl: string; readonly model: string; readonly apiKeyEnv: string; readonly timeoutMs: number };
  };
  readonly policies: { readonly disclosure: DisclosurePolicy; readonly emotion: EmotionPolicy; readonly freeTime: FreeTimePolicy };
  /** Protected changes become proposals; standalone has no approval queue yet, so they are refused. */
  readonly approvals: { readonly kind: 'refuse' };
  readonly harness: {
    readonly turnLeaseMs: number;
    readonly maxModelCalls: number;
    readonly maxToolResultChars: number;
    readonly historyEntries: number;
    readonly selfStateItems: number;
  };
  readonly workers: { readonly leaseMs: number; readonly maxAttempts: number; readonly resumeGraceMs: number };
  readonly scheduler: {
    readonly tickIntervalMs: number;
    readonly inFlightMs: number;
    /** Memory maintenance runs on every Nth tick. */
    readonly maintenanceEveryTicks: number;
    readonly maintenanceSessionLimit: number;
    readonly maintenanceMaxEntries: number;
  };
  readonly memory: { readonly endedAfterMs: number };
}

class Reader {
  readonly issues: string[];
  private readonly raw: Record<string, unknown>;
  private readonly path: string;
  constructor(raw: Record<string, unknown>, path: string, allowed: readonly string[], issues: string[]) {
    this.raw = raw;
    this.path = path;
    this.issues = issues;
    for (const key of Object.keys(raw)) if (!allowed.includes(key)) issues.push(`${this.at(key)} is not a known setting`);
    for (const key of allowed) if (!Object.hasOwn(raw, key)) issues.push(`${this.at(key)} is required`);
  }
  private at(key: string): string {
    return this.path === '' ? key : `${this.path}.${key}`;
  }
  child(key: string, allowed: readonly string[]): Reader {
    const value = this.raw[key];
    if (!isRecord(value)) {
      if (Object.hasOwn(this.raw, key)) this.issues.push(`${this.at(key)} must be an object`);
      return new Reader({}, this.at(key), [], this.issues);
    }
    return new Reader(value, this.at(key), allowed, this.issues);
  }
  value(key: string): unknown {
    return this.raw[key];
  }
  string(key: string): string {
    const value = this.raw[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (Object.hasOwn(this.raw, key)) this.issues.push(`${this.at(key)} must be a non-empty string`);
    return '';
  }
  nullableString(key: string): string | null {
    return this.raw[key] === null ? null : this.string(key);
  }
  envName(key: string): string {
    const value = this.string(key);
    if (value !== '' && !/^[A-Z_][A-Z0-9_]*$/.test(value)) this.issues.push(`${this.at(key)} must name an environment variable`);
    return value;
  }
  integer(key: string, min: number, max: number): number {
    const value = this.raw[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
    if (Object.hasOwn(this.raw, key)) this.issues.push(`${this.at(key)} must be an integer from ${min} to ${max}`);
    return min;
  }
  oneOf<T extends string>(key: string, options: readonly T[]): T {
    const value = this.raw[key];
    if (isOneOf(options, value)) return value;
    if (Object.hasOwn(this.raw, key)) this.issues.push(`${this.at(key)} must be one of ${options.join(', ')}`);
    return options[0] as T;
  }
  policy<T>(key: string, baseline: T, parse: (raw: unknown) => Result<T>): T {
    const value = this.raw[key];
    if (!Object.hasOwn(this.raw, key)) return baseline;
    if (value === 'baseline') return baseline;
    const parsed = parse(value);
    if (parsed.ok) return parsed.value;
    this.issues.push(`${this.at(key)}: ${parsed.error.kind === 'invalid' ? parsed.error.issues.join('; ') : parsed.error.kind} (or "baseline")`);
    return baseline;
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function parseLiteConfig(raw: unknown): Result<LiteConfig> {
  if (!isRecord(raw)) return invalid('config must be a JSON object');
  const issues: string[] = [];
  const root = new Reader(raw, '', ['companionId', 'surface', 'operator', 'storage', 'postgres', 'model', 'embedding', 'policies', 'approvals', 'harness', 'workers', 'scheduler', 'memory'], issues);

  const companionId = parseId('companion', root.value('companionId'));
  if (!companionId.ok && Object.hasOwn(raw, 'companionId')) issues.push('companionId must be an id of [A-Za-z0-9:._-]');
  const surface = parseId('surface', root.value('surface'));
  if (!surface.ok && Object.hasOwn(raw, 'surface')) issues.push('surface must be an id of [A-Za-z0-9:._-]');

  const op = root.child('operator', ['displayName', 'channelKind', 'externalId', 'channelId', 'trust', 'relationship', 'sensitivity']);
  const channelId = op.string('channelId');
  if (channelId !== '' && !parseId('channel', channelId).ok) issues.push('operator.channelId must be an id of [A-Za-z0-9:._-]');
  const operator = {
    displayName: op.string('displayName'),
    channelKind: op.string('channelKind'),
    externalId: op.string('externalId'),
    channelId,
    trust: op.oneOf('trust', TRUST_LEVELS),
    relationship: op.oneOf('relationship', HUMAN_RELATIONSHIPS),
    sensitivity: op.oneOf('sensitivity', SENSITIVITIES),
  };

  const st = root.child('storage', ['historyRoot', 'workspaceRoot', 'backupRoot']);
  const storage = { historyRoot: st.string('historyRoot'), workspaceRoot: st.string('workspaceRoot'), backupRoot: st.nullableString('backupRoot') };
  const postgres = { urlEnv: root.child('postgres', ['urlEnv']).envName('urlEnv') };

  const md = root.child('model', ['provider', 'modelId', 'apiKeyEnv', 'maxOutputTokens']);
  const model = {
    provider: md.string('provider'),
    modelId: md.string('modelId'),
    apiKeyEnv: md.value('apiKeyEnv') === null ? null : md.envName('apiKeyEnv'),
    maxOutputTokens: md.integer('maxOutputTokens', 1, 200_000),
  };

  const em = root.child('embedding', ['space', 'provider']);
  const sp = em.child('space', ['name', 'dimensions']);
  const space = { name: sp.string('name'), dimensions: sp.integer('dimensions', 1, 4000) };
  const providerRaw = em.value('provider');
  let embeddingProvider: LiteConfig['embedding']['provider'] = { kind: 'disabled' };
  if (isRecord(providerRaw) && providerRaw['kind'] === 'disabled') {
    em.child('provider', ['kind']);
  } else if (isRecord(providerRaw) && providerRaw['kind'] === 'openai_compatible') {
    const pr = em.child('provider', ['kind', 'baseUrl', 'model', 'apiKeyEnv', 'timeoutMs']);
    const baseUrl = pr.string('baseUrl');
    if (baseUrl !== '' && !/^https?:\/\//.test(baseUrl)) issues.push('embedding.provider.baseUrl must be an http(s) URL');
    embeddingProvider = { kind: 'openai_compatible', baseUrl, model: pr.string('model'), apiKeyEnv: pr.envName('apiKeyEnv'), timeoutMs: pr.integer('timeoutMs', 1, 600_000) };
  } else if (providerRaw !== undefined) {
    issues.push('embedding.provider.kind must be "disabled" or "openai_compatible"');
  }

  const po = root.child('policies', ['disclosure', 'emotion', 'freeTime']);
  const policies = {
    disclosure: po.policy('disclosure', BASELINE_DISCLOSURE_POLICY, parseDisclosurePolicy),
    emotion: po.policy('emotion', BASELINE_EMOTION_POLICY, parseEmotionPolicy),
    freeTime: po.policy('freeTime', BASELINE_FREE_TIME_POLICY, parseFreeTimePolicy),
  };
  const ap = root.child('approvals', ['kind']);
  ap.oneOf('kind', ['refuse'] as const);

  const hn = root.child('harness', ['turnLeaseMs', 'maxModelCalls', 'maxToolResultChars', 'historyEntries', 'selfStateItems']);
  const harness = {
    turnLeaseMs: hn.integer('turnLeaseMs', 1_000, DAY_MS),
    maxModelCalls: hn.integer('maxModelCalls', 1, 100),
    maxToolResultChars: hn.integer('maxToolResultChars', 100, 1_000_000),
    historyEntries: hn.integer('historyEntries', 1, 1_000),
    selfStateItems: hn.integer('selfStateItems', 1, 100),
  };
  const wk = root.child('workers', ['leaseMs', 'maxAttempts', 'resumeGraceMs']);
  const workers = { leaseMs: wk.integer('leaseMs', 1_000, DAY_MS), maxAttempts: wk.integer('maxAttempts', 1, 10), resumeGraceMs: wk.integer('resumeGraceMs', 1_000, 7 * DAY_MS) };
  const sc = root.child('scheduler', ['tickIntervalMs', 'inFlightMs', 'maintenanceEveryTicks', 'maintenanceSessionLimit', 'maintenanceMaxEntries']);
  const scheduler = {
    tickIntervalMs: sc.integer('tickIntervalMs', 1_000, DAY_MS),
    inFlightMs: sc.integer('inFlightMs', 1_000, DAY_MS),
    maintenanceEveryTicks: sc.integer('maintenanceEveryTicks', 1, 10_000),
    maintenanceSessionLimit: sc.integer('maintenanceSessionLimit', 1, 1_000),
    maintenanceMaxEntries: sc.integer('maintenanceMaxEntries', 1, 100_000),
  };
  const memory = { endedAfterMs: root.child('memory', ['endedAfterMs']).integer('endedAfterMs', 60_000, 7 * DAY_MS) };

  if (issues.length > 0 || !companionId.ok || !surface.ok) return invalid(...issues);
  return ok({
    companionId: companionId.value,
    surface: surface.value,
    operator,
    storage,
    postgres,
    model,
    embedding: { space, provider: embeddingProvider },
    policies,
    approvals: { kind: 'refuse' },
    harness,
    workers,
    scheduler,
    memory,
  });
}

/** The secrets the config names, read from the environment. A missing one is named, its value never shown. */
export interface LiteSecrets {
  readonly databaseUrl: string;
  readonly modelApiKey: string | null;
  readonly embeddingApiKey: string | null;
}

export function readSecrets(config: LiteConfig, env: Readonly<Record<string, string | undefined>>): Result<LiteSecrets> {
  const issues: string[] = [];
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === '') issues.push(`environment variable ${name} is not set`);
    return value ?? '';
  };
  const databaseUrl = read(config.postgres.urlEnv);
  const modelApiKey = config.model.apiKeyEnv === null ? null : read(config.model.apiKeyEnv);
  const embeddingApiKey = config.embedding.provider.kind === 'openai_compatible' ? read(config.embedding.provider.apiKeyEnv) : null;
  return issues.length > 0 ? invalid(...issues) : ok({ databaseUrl, modelApiKey, embeddingApiKey });
}
