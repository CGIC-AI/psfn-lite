/**
 * The shared model service: one process that holds the embedding model and
 * the text-emotion classifier, for several companions that would otherwise
 * each load their own copy.
 *
 *   GET  /health            liveness, no detail
 *   POST /v1/embeddings     {model, input: string[]} -> {object: 'list', model, data: [{object: 'embedding', index, embedding}]}
 *   POST /v1/text-emotion   {model, input: string}   -> {model, data: [{label, score}]}
 *
 * The embeddings route is the OpenAI-style shape the companion's `api`
 * embedding provider posts (`embedding.provider.kind: "api"`); the
 * text-emotion route is what `remoteTextEmotionPipeline` calls
 * (`textEmotion.provider.kind: "api"`). Both need the service's bearer token.
 * A request naming another model than the served one is refused, so vectors
 * or labels of different models are never mixed without anyone noticing.
 *
 * The service runs the companion core's own provider classes, so a companion
 * that moves from its in-process models to this service gets the same
 * vectors and labels as before.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { TextEmotionClassification, TextEmotionPipelineFactory } from './companion.ts';
import { invalid, isRecord, ok, type Result } from './mcp.ts';

export interface ModelServiceConfig {
  readonly host: string;
  readonly port: number;
  /** The transformers model cache, absolute. */
  readonly cacheDir: string;
  /** The variable holding the bearer token clients must present. */
  readonly tokenEnv: string;
  readonly maxBodyBytes: number;
  readonly embedding: { readonly model: string; readonly dimensions: number };
  readonly textEmotion: { readonly model: string; readonly dtype: string };
}

/** The models behind the routes; the CLI supplies the companion core's providers, tests supply fakes. */
export interface ModelServicePorts {
  readonly embed: (texts: string[]) => Promise<Float32Array[]>;
  readonly classify: (text: string) => Promise<TextEmotionClassification[]>;
}

export interface ModelService {
  readonly url: string;
  close(): Promise<void>;
}

const CONFIG_KEYS = ['host', 'port', 'cacheDir', 'tokenEnv', 'maxBodyBytes', 'embedding', 'textEmotion'];
/** The most texts one embeddings request may carry. */
const MAX_EMBEDDING_INPUTS = 256;

export function parseModelServiceConfig(raw: unknown): Result<ModelServiceConfig> {
  if (!isRecord(raw)) return invalid('the model service configuration must be a JSON object');
  const issues: string[] = [];
  for (const key of Object.keys(raw)) if (!CONFIG_KEYS.includes(key)) issues.push(`${key} is not a model service setting`);
  for (const key of CONFIG_KEYS) if (!Object.hasOwn(raw, key)) issues.push(`${key} is required`);
  const text = (owner: Readonly<Record<string, unknown>>, key: string, at: string): string => {
    const value = owner[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (Object.hasOwn(owner, key)) issues.push(`${at} must be a non-empty string`);
    return '';
  };
  const integer = (owner: Readonly<Record<string, unknown>>, key: string, at: string, min: number, max: number): number => {
    const value = owner[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
    if (Object.hasOwn(owner, key)) issues.push(`${at} must be an integer from ${min} to ${max}`);
    return min;
  };
  const section = (key: string, allowed: readonly string[]): Readonly<Record<string, unknown>> => {
    const value = raw[key];
    if (!isRecord(value)) {
      if (Object.hasOwn(raw, key)) issues.push(`${key} must be an object`);
      return {};
    }
    for (const name of Object.keys(value)) if (!allowed.includes(name)) issues.push(`${key}.${name} is not a setting`);
    for (const name of allowed) if (!Object.hasOwn(value, name)) issues.push(`${key}.${name} is required`);
    return value;
  };
  const tokenEnv = text(raw, 'tokenEnv', 'tokenEnv');
  if (tokenEnv !== '' && !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) issues.push('tokenEnv must be an environment variable name');
  const cacheDir = text(raw, 'cacheDir', 'cacheDir');
  const em = section('embedding', ['model', 'dimensions']);
  const te = section('textEmotion', ['model', 'dtype']);
  const config: ModelServiceConfig = {
    host: text(raw, 'host', 'host'),
    port: integer(raw, 'port', 'port', 0, 65_535),
    cacheDir: cacheDir === '' ? '' : resolve(cacheDir),
    tokenEnv,
    maxBodyBytes: integer(raw, 'maxBodyBytes', 'maxBodyBytes', 1_024, 16_777_216),
    embedding: { model: text(em, 'model', 'embedding.model'), dimensions: integer(em, 'dimensions', 'embedding.dimensions', 1, 16_000) },
    textEmotion: { model: text(te, 'model', 'textEmotion.model'), dtype: text(te, 'dtype', 'textEmotion.dtype') },
  };
  return issues.length > 0 ? invalid(...issues) : ok(config);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
}

/** The request body as JSON, or null after the refusal has been sent. */
async function readJson(req: IncomingMessage, res: ServerResponse, maxBodyBytes: number): Promise<Readonly<Record<string, unknown>> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      reply(res, 413, { error: 'body_too_large' });
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    reply(res, 400, { error: 'invalid_json' });
    return null;
  }
  if (!isRecord(parsed)) {
    reply(res, 400, { error: 'invalid_request' });
    return null;
  }
  return parsed;
}

export async function startModelService(input: {
  readonly config: ModelServiceConfig;
  readonly token: string;
  readonly ports: ModelServicePorts;
  /** Reports a request the models failed; the caller only learns that it failed. */
  readonly onError: (route: string, error: unknown) => void;
}): Promise<ModelService> {
  const { config, ports, onError } = input;
  const expected = digest(input.token);
  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    return timingSafeEqual(digest(header.slice('Bearer '.length)), expected);
  };

  const embeddings = async (body: Readonly<Record<string, unknown>>, res: ServerResponse): Promise<void> => {
    if (body['model'] !== config.embedding.model) return reply(res, 400, { error: 'model_not_served', served: config.embedding.model });
    const texts = body['input'];
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_EMBEDDING_INPUTS || !texts.every((t): t is string => typeof t === 'string' && t.length > 0)) {
      return reply(res, 400, { error: 'invalid_input' });
    }
    const vectors = await ports.embed(texts);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== config.embedding.dimensions)) throw new Error('the embedding model returned vectors of an unexpected count or size');
    reply(res, 200, {
      object: 'list',
      model: config.embedding.model,
      data: vectors.map((vector, index) => ({ object: 'embedding', index, embedding: Array.from(vector) })),
    });
  };

  const textEmotion = async (body: Readonly<Record<string, unknown>>, res: ServerResponse): Promise<void> => {
    if (body['model'] !== config.textEmotion.model) return reply(res, 400, { error: 'model_not_served', served: config.textEmotion.model });
    const text = body['input'];
    if (typeof text !== 'string' || text.length === 0) return reply(res, 400, { error: 'invalid_input' });
    reply(res, 200, { model: config.textEmotion.model, data: await ports.classify(text) });
  };

  const routes: Readonly<Record<string, (body: Readonly<Record<string, unknown>>, res: ServerResponse) => Promise<void>>> = {
    '/v1/embeddings': embeddings,
    '/v1/text-emotion': textEmotion,
  };

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET' && path === '/health') return reply(res, 200, { ok: true });
    const route = routes[path];
    if (route === undefined) return reply(res, 404, { error: 'not_found' });
    if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' });
    if (!authorized(req)) return reply(res, 401, { error: 'unauthorized' });
    void (async () => {
      try {
        const body = await readJson(req, res, config.maxBodyBytes);
        if (body !== null) await route(body, res);
      } catch (error) {
        onError(path, error);
        if (!res.headersSent) reply(res, 500, { error: 'model_failed' });
        else res.destroy();
      }
    })();
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeAllConnections();
      }),
  };
}

/**
 * A text-emotion pipeline that asks a model service instead of running the
 * model in this process. Any refusal, failure or malformed reply throws:
 * the classifier's caller sees a failed classification, never an invented one.
 */
export function remoteTextEmotionPipeline(input: { readonly url: string; readonly token: string | null }): TextEmotionPipelineFactory {
  return (config) =>
    Promise.resolve(async (text: string) => {
      const response = await fetch(input.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(input.token === null ? {} : { authorization: `Bearer ${input.token}` }) },
        body: JSON.stringify({ model: config.model, input: text }),
      });
      if (!response.ok) throw new Error(`text emotion service error ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = (await response.json()) as unknown;
      if (!isRecord(body) || !Array.isArray(body['data'])) throw new Error('text emotion service returned no classification list');
      return body['data'] as unknown[];
    });
}
