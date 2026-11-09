/**
 * Standalone configuration: one explicit, validated document naming this
 * host's choices for the extracted companion core. The companion's own
 * behaviour lives in its owner files in `dataDir` (scheduler.json,
 * settings.json, trust-policy.json, ... as the donor loaded them, seeded by
 * `init`); the substrate config the core runs with is the donor's load-config
 * defaults with these host choices (substrate-config.ts). Secrets are never in
 * the file: it names the environment variables that hold the database URL,
 * the provider keys and the transport credentials, and those are read once at
 * start. Unknown keys are rejected so a typo cannot silently fall back.
 */
import { resolve, sep } from 'node:path';
import { invalid, isRecord, ok, type Result } from './mcp.ts';
import { DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG, resolveProjectTransformersCacheDir, type TrustLevel } from './companion.ts';

/** A person the companion knows, provisioned in its contact store at start. */
export interface LiteContact {
  /** The host's key for the contact: what a principal binding names. */
  readonly key: string;
  readonly displayName: string;
  readonly trust: TrustLevel;
}

export interface LiteConfig {
  /** The donor's companion id (a UUID; it scopes the companion's rows). */
  readonly companionId: string;
  /** The companion data directory: owner files and the donor's file stores. */
  readonly dataDir: string;
  /**
   * The companion's personal workspace (journal, knowledge and its other
   * personal files): the donor's WORKSPACE_PATH. It must not overlap dataDir
   * (the donor refuses a workspace inside its runtime state roots).
   */
  readonly workspaceDir: string;
  readonly characterCardPath: string;
  /** The primary operator, who talks to the companion through this CLI; contact key `operator`, trust primary. */
  readonly operator: { readonly userId: string; readonly displayName: string };
  /** Further contacts a principal binding may name. */
  readonly contacts: readonly LiteContact[];
  readonly postgres: { readonly urlEnv: string };
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
    /** The variable holding the provider key; null sends none (keyless providers only). */
    readonly apiKeyEnv: string | null;
    readonly maxOutputTokens: number;
  };
  /**
   * The embedding provider: one of the donor's kinds
   * (faculties/memory/embedding.ts `EmbeddingProviderKind`), built by the
   * donor's own provider classes (`createEmbeddingProviderFromConfig`).
   * Without an `embedding` block the donor's seeded default applies: the
   * local, keyless `transformers` provider with `Xenova/all-MiniLM-L6-v2`
   * (384 dimensions), its model cached under the data directory.
   */
  readonly embedding: {
    readonly model: string;
    readonly dimensions: number;
    readonly provider:
      /** In-process @huggingface/transformers; `cacheDir` is absolute (a relative value resolves under dataDir). */
      | { readonly kind: 'transformers'; readonly cacheDir: string }
      /** An Ollama server: the donor posts to `<url>/api/embed`. */
      | { readonly kind: 'ollama'; readonly url: string }
      /**
       * An OpenAI-style embeddings endpoint: the donor posts to `url` as
       * given (the full endpoint, for example `https://api.openai.com/v1/embeddings`).
       * `apiKeyEnv` names the key's variable; null uses the donor's
       * `EMBEDDING_API_KEY`, then `OPENAI_API_KEY`, and sends none if both are unset.
       */
      | { readonly kind: 'api'; readonly url: string; readonly apiKeyEnv: string | null };
  };
  /**
   * Session journal integrity: `keyring` signs every journal entry with the
   * donor's HMAC keyring, read from the donor's keyring environment variables
   * (docs/extraction.md, seam 3.8); `unsigned` keeps journals unsigned.
   */
  readonly sessionIntegrity: { readonly kind: 'keyring' } | { readonly kind: 'unsigned' };
  /** The donor tool catalog over MCP streamable HTTP, or null for none. It needs `lifecycle`: the tools run only inside host-driven turns. */
  readonly mcp: {
    readonly host: string;
    readonly port: number;
    /** Null binds loopback only; a list opts in to a wider address and names the Host values served. */
    readonly allowedHosts: readonly string[] | null;
    /** The principal binding list (packages/mcp): each names where its credential lives, never the credential. */
    readonly bindings: readonly unknown[];
  } | null;
  /** The lifecycle bridge an external companion host drives host-driven turns through, or null. It needs `mcp`. */
  readonly lifecycle: {
    readonly host: string;
    readonly port: number;
    readonly allowedHosts: readonly string[] | null;
    /** A host-driven turn the host neither continues nor settles within this time is failed. */
    readonly hostTurnTimeoutMs: number;
    /**
     * The Hermes install the bridge serves: its install id (the file
     * `install_id` in the Hermes root, docs/extraction.md, Step E2). Prepares
     * from another install are refused, and with the `keyring` session
     * integrity the install's conversations are signed with a keyring scoped
     * to it. The id names the binding; it is not a secret.
     */
    readonly hermesInstallId: string;
    /**
     * Hosted automata (docs/extraction.md, operator automata rules), or null
     * to run every spawned automaton in core as the donor does. When set, the
     * host claims each spawned automaton's attempts over the bridge and runs
     * them as its own subagents: a task gets at most `maxAttempts` attempts,
     * an attempt the host does not renew within `leaseMs` is lost, and the
     * host's per-attempt iteration budget may not exceed `maxIterations`.
     */
    readonly automata: {
      readonly maxAttempts: number;
      readonly leaseMs: number;
      readonly maxIterations: number;
    } | null;
  } | null;
  /**
   * The light Garden (docs/extraction.md, seam S8), or null for none: the
   * operator API the Hermes plugin's Garden proxies to. It listens on its
   * own port, loopback unless `allowedHosts` opts in to a wider address.
   * Its bindings use the MCP binding format; every one must name the
   * primary contact (`operator`), and none may reuse an MCP credential or
   * principal. A route reads a body of at most `maxBodyBytes` (the donor's
   * standalone Garden read 64 KiB); the Overview shows the latest
   * session's last `recentTurnLimit` turns.
   */
  readonly garden: {
    readonly host: string;
    readonly port: number;
    readonly allowedHosts: readonly string[] | null;
    readonly maxBodyBytes: number;
    readonly recentTurnLimit: number;
    readonly bindings: readonly unknown[];
  } | null;
}

export const TRUST_LEVELS: readonly TrustLevel[] = ['primary', 'trusted', 'regular', 'public'];
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
/** A Hermes install id as Hermes mints it (hermes_cli/install_identity.py `_INSTALL_ID_RE` at 2bd378e; hermes_cli/web_server.py at f0187332). */
const HERMES_INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;

class Reader {
  readonly issues: string[];
  private readonly raw: Readonly<Record<string, unknown>>;
  private readonly path: string;
  constructor(raw: Readonly<Record<string, unknown>>, path: string, allowed: readonly string[], issues: string[], optional: readonly string[] = []) {
    this.raw = raw;
    this.path = path;
    this.issues = issues;
    for (const key of Object.keys(raw)) if (!allowed.includes(key) && !optional.includes(key)) issues.push(`${this.at(key)} is not a known setting`);
    for (const key of allowed) if (!Object.hasOwn(raw, key)) issues.push(`${this.at(key)} is required`);
  }
  at(key: string): string {
    return this.path === '' ? key : `${this.path}.${key}`;
  }
  child(key: string, allowed: readonly string[], optional: readonly string[] = []): Reader {
    const value = this.raw[key];
    if (!isRecord(value)) {
      if (Object.hasOwn(this.raw, key)) this.issues.push(`${this.at(key)} must be an object`);
      return new Reader({}, this.at(key), [], this.issues);
    }
    return new Reader(value, this.at(key), allowed, this.issues, optional);
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
  matching(key: string, pattern: RegExp, description: string): string {
    const value = this.string(key);
    if (value !== '' && !pattern.test(value)) this.issues.push(`${this.at(key)} must be ${description}`);
    return value;
  }
  envName(key: string): string {
    return this.matching(key, /^[A-Z_][A-Z0-9_]*$/, 'an environment variable name');
  }
  integer(key: string, min: number, max: number): number {
    const value = this.raw[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
    if (Object.hasOwn(this.raw, key)) this.issues.push(`${this.at(key)} must be an integer from ${min} to ${max}`);
    return min;
  }
  oneOf<T extends string>(key: string, options: readonly T[]): T {
    const value = this.raw[key];
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T;
    if (Object.hasOwn(this.raw, key)) this.issues.push(`${this.at(key)} must be one of ${options.join(', ')}`);
    return options[0] as T;
  }
}

const ROOT_KEYS = ['companionId', 'dataDir', 'workspaceDir', 'characterCardPath', 'operator', 'contacts', 'postgres', 'model', 'sessionIntegrity', 'mcp', 'lifecycle'];
/** Settings with a donor default when left out. */
const OPTIONAL_ROOT_KEYS = ['embedding', 'garden'];
/** The donor's embedding provider kinds (faculties/memory/embedding.ts `EmbeddingProviderKind`). */
export const EMBEDDING_PROVIDER_KINDS = ['transformers', 'ollama', 'api'] as const;

export function parseLiteConfig(raw: unknown): Result<LiteConfig> {
  if (!isRecord(raw)) return invalid('config must be a JSON object');
  const issues: string[] = [];
  const root = new Reader(raw, '', ROOT_KEYS, issues, OPTIONAL_ROOT_KEYS);
  const companionId = root.matching('companionId', UUID_PATTERN, 'a UUID');
  const dataDir = root.string('dataDir');
  const workspaceDir = root.string('workspaceDir');
  if (dataDir !== '' && workspaceDir !== '' && overlaps(dataDir, workspaceDir)) issues.push('workspaceDir must not be dataDir or inside it, nor contain it');
  const characterCardPath = root.string('characterCardPath');

  const op = root.child('operator', ['userId', 'displayName']);
  const operator = { userId: op.matching('userId', KEY_PATTERN, '1-64 characters of [a-z0-9._-]'), displayName: op.string('displayName') };

  const contacts: LiteContact[] = [];
  const rawContacts = root.value('contacts');
  if (!Array.isArray(rawContacts)) {
    if (rawContacts !== undefined) issues.push('contacts must be a list');
  } else {
    rawContacts.forEach((item: unknown, index) => {
      const at = `contacts[${index}]`;
      if (!isRecord(item)) {
        issues.push(`${at} must be an object`);
        return;
      }
      const r = new Reader(item, at, ['key', 'displayName', 'trust'], issues);
      const key = r.matching('key', KEY_PATTERN, '1-64 characters of [a-z0-9._-]');
      if (key === 'operator') issues.push(`${at}.key "operator" is the configured operator`);
      if (contacts.some((c) => c.key === key)) issues.push(`${at}.key ${key} is named twice`);
      contacts.push({ key, displayName: r.string('displayName'), trust: r.oneOf('trust', TRUST_LEVELS.filter((t) => t !== 'primary')) });
    });
  }

  const postgres = { urlEnv: root.child('postgres', ['urlEnv']).envName('urlEnv') };
  const md = root.child('model', ['provider', 'modelId', 'apiKeyEnv', 'maxOutputTokens']);
  const model = {
    provider: md.string('provider'),
    modelId: md.string('modelId'),
    apiKeyEnv: md.value('apiKeyEnv') === null ? null : md.envName('apiKeyEnv'),
    maxOutputTokens: md.integer('maxOutputTokens', 1, 1_000_000),
  };

  const embedding = parseEmbedding(root, dataDir);

  const si = root.child('sessionIntegrity', ['kind']);
  const sessionIntegrity = { kind: si.oneOf('kind', ['keyring', 'unsigned'] as const) };

  const mcp = parseMcp(root, issues);
  const lifecycle = parseLifecycle(root, issues);
  if (lifecycle !== null && mcp === null) issues.push('lifecycle needs mcp: the bridge shares its principal bindings');
  if (mcp !== null && lifecycle === null) issues.push('mcp needs lifecycle: companion tools run only inside host-driven turns');
  const garden = parseGarden(root, issues);

  if (issues.length > 0) return invalid(...issues);
  return ok({ companionId, dataDir, workspaceDir, characterCardPath, operator, contacts, postgres, model, embedding, sessionIntegrity, mcp, lifecycle, garden });
}

/**
 * The embedding block, or the donor's seeded default without one
 * (config/settings.seed.json `embeddingProvider: "transformers"`,
 * `transformersModel: "Xenova/all-MiniLM-L6-v2"`, `embeddingDims: 384`: the
 * values of embedding.ts DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG). The donor
 * cached the transformers model in `<project root>/models/transformers`
 * (embedding.ts resolveProjectTransformersCacheDir over the working
 * directory); a Lite host's root for it is the data directory.
 */
function parseEmbedding(root: Reader, dataDir: string): LiteConfig['embedding'] {
  const defaultCacheDir = resolveProjectTransformersCacheDir(resolve(dataDir));
  if (root.value('embedding') === undefined) {
    return {
      model: DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG.model,
      dimensions: DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG.dims,
      provider: { kind: 'transformers', cacheDir: defaultCacheDir },
    };
  }
  const em = root.child('embedding', ['model', 'dimensions', 'provider']);
  const model = em.string('model');
  const dimensions = em.integer('dimensions', 1, 16_000);
  const raw = em.value('provider');
  const kind = isRecord(raw) ? raw['kind'] : undefined;
  if (kind === 'ollama') {
    const pr = em.child('provider', ['kind', 'url']);
    return { model, dimensions, provider: { kind, url: pr.matching('url', /^https?:\/\//, 'an http(s) URL') } };
  }
  if (kind === 'api') {
    const pr = em.child('provider', ['kind', 'url', 'apiKeyEnv']);
    const url = pr.matching('url', /^https?:\/\//, 'an http(s) URL');
    return { model, dimensions, provider: { kind, url, apiKeyEnv: pr.value('apiKeyEnv') === null ? null : pr.envName('apiKeyEnv') } };
  }
  if (kind === 'transformers') {
    const pr = em.child('provider', ['kind'], ['cacheDir']);
    const cacheDir = pr.value('cacheDir') === undefined ? defaultCacheDir : resolve(dataDir, pr.string('cacheDir'));
    return { model, dimensions, provider: { kind, cacheDir } };
  }
  if (raw !== undefined) root.issues.push(`embedding.provider.kind must be one of ${EMBEDDING_PROVIDER_KINDS.join(', ')}`);
  return { model, dimensions, provider: { kind: 'transformers', cacheDir: defaultCacheDir } };
}

function listen(reader: Reader, issues: string[], at: string): { host: string; port: number; allowedHosts: readonly string[] | null } {
  const host = reader.string('host');
  const port = reader.integer('port', 0, 65_535);
  const raw = reader.value('allowedHosts');
  let allowedHosts: string[] | null = null;
  if (Array.isArray(raw) && raw.length > 0 && raw.every((h) => typeof h === 'string' && h.trim().length > 0)) allowedHosts = raw as string[];
  else if (raw !== null && raw !== undefined) issues.push(`${at}.allowedHosts must be null or a non-empty list of Host names`);
  return { host, port, allowedHosts };
}

function parseMcp(root: Reader, issues: string[]): LiteConfig['mcp'] {
  if (root.value('mcp') === null) return null;
  const r = root.child('mcp', ['host', 'port', 'allowedHosts', 'bindings']);
  const bindings = r.value('bindings');
  if ((!Array.isArray(bindings) || bindings.length === 0) && bindings !== undefined) issues.push('mcp.bindings must be a non-empty list of principal bindings');
  return { ...listen(r, issues, 'mcp'), bindings: Array.isArray(bindings) ? bindings : [] };
}

function parseLifecycle(root: Reader, issues: string[]): LiteConfig['lifecycle'] {
  if (root.value('lifecycle') === null) return null;
  const r = root.child('lifecycle', ['host', 'port', 'allowedHosts', 'hostTurnTimeoutMs', 'hermesInstallId', 'automata']);
  return {
    ...listen(r, issues, 'lifecycle'),
    hostTurnTimeoutMs: r.integer('hostTurnTimeoutMs', 1_000, DAY_MS),
    hermesInstallId: r.matching('hermesInstallId', HERMES_INSTALL_ID_PATTERN, 'a Hermes install id (32 lowercase hex characters)'),
    automata: parseHostedAutomata(r),
  };
}

function parseGarden(root: Reader, issues: string[]): LiteConfig['garden'] {
  const value = root.value('garden');
  if (value === undefined || value === null) return null;
  const r = root.child('garden', ['host', 'port', 'allowedHosts', 'maxBodyBytes', 'recentTurnLimit', 'bindings']);
  const bindings = r.value('bindings');
  if ((!Array.isArray(bindings) || bindings.length === 0) && bindings !== undefined) issues.push('garden.bindings must be a non-empty list of principal bindings');
  return {
    ...listen(r, issues, 'garden'),
    maxBodyBytes: r.integer('maxBodyBytes', 1_024, 16 * 1_024 * 1_024),
    recentTurnLimit: r.integer('recentTurnLimit', 1, 500),
    bindings: Array.isArray(bindings) ? bindings : [],
  };
}

function parseHostedAutomata(lifecycle: Reader): NonNullable<LiteConfig['lifecycle']>['automata'] {
  if (lifecycle.value('automata') === null) return null;
  const r = lifecycle.child('automata', ['maxAttempts', 'leaseMs', 'maxIterations']);
  return {
    maxAttempts: r.integer('maxAttempts', 1, 100),
    leaseMs: r.integer('leaseMs', 1_000, DAY_MS),
    maxIterations: r.integer('maxIterations', 1, 100_000),
  };
}

/** The secrets the config names, read from the environment. A missing one is named, its value never shown. */
export interface LiteSecrets {
  readonly databaseUrl: string;
  readonly modelApiKey: string | null;
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
  // The donor's api provider reads its key itself, from the environment the runtime starts with (substrate-config.ts); a named one must be set.
  if (config.embedding.provider.kind === 'api' && config.embedding.provider.apiKeyEnv !== null) read(config.embedding.provider.apiKeyEnv);
  return issues.length > 0 ? invalid(...issues) : ok({ databaseUrl, modelApiKey });
}

function overlaps(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}
