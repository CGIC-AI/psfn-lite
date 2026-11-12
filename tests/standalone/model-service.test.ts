/**
 * The shared model service: several companions ask one process for
 * embeddings and text-emotion labels instead of each loading the models.
 * The companion core's own clients are run against it here (the `api`
 * embedding provider and the classifier class over the remote pipeline), so
 * the wire shapes are the ones a companion really sends and reads. The
 * service refuses a caller without its token and a request for a model it
 * does not serve, and a failing model is reported as a failure.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseLiteConfig,
  parseModelServiceConfig,
  readSecrets,
  remoteTextEmotionPipeline,
  runCli,
  startModelService,
  type CliIo,
  type ModelService,
  type ModelServiceConfig,
  type ModelServicePorts,
} from '../../apps/standalone/src/index.ts';
import { TextEmotionClassifier } from '../../packages/companion/src/core/emotion/text-classifier.ts';
import { ApiEmbeddingProvider } from '../../packages/companion/src/faculties/memory/embedding.ts';
import { DATABASE_URL_ENV, liteConfigDocument } from '../support/lite-install.ts';

const TOKEN = 'model-service-test-token';
const document = () => ({
  host: '127.0.0.1',
  port: 0,
  cacheDir: '/srv/models',
  tokenEnv: 'LITE_MODELS_TOKEN',
  maxBodyBytes: 4096,
  embedding: { model: 'test-embedding', dimensions: 3 },
  textEmotion: { model: 'test-emotion', dtype: 'fp32' },
});
const configOf = (raw: unknown = document()): ModelServiceConfig => {
  const parsed = parseModelServiceConfig(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};
const issuesOf = (raw: unknown) => {
  const parsed = parseModelServiceConfig(raw);
  return parsed.ok ? [] : parsed.error.kind === 'invalid' ? parsed.error.issues : [parsed.error.kind];
};

/** Fake models: a vector made from the text's length, and labels that name the text. */
const ports = (): ModelServicePorts & { embedded: string[][] } => {
  const embedded: string[][] = [];
  return {
    embedded,
    embed: (texts) => {
      embedded.push(texts);
      return Promise.resolve(texts.map((text) => Float32Array.from([text.length, 0.5, -1])));
    },
    classify: (text) =>
      text === 'boom'
        ? Promise.reject(new Error('the classifier broke'))
        : Promise.resolve([
            { label: 'joy', score: 0.75 },
            { label: 'neutral', score: 0.25 },
          ]),
  };
};

describe('model service', () => {
  const open: ModelService[] = [];
  const errors: string[] = [];
  afterEach(async () => {
    for (const service of open.splice(0)) await service.close();
    errors.length = 0;
  });
  const start = async (models = ports()) => {
    const service = await startModelService({ config: configOf(), token: TOKEN, ports: models, onError: (route, error) => errors.push(`${route}: ${String(error)}`) });
    open.push(service);
    return { service, models };
  };
  const post = (url: string, body: unknown, token: string | null = TOKEN) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('requires every setting and refuses unknown ones', () => {
    expect(configOf()).toMatchObject({ host: '127.0.0.1', embedding: { model: 'test-embedding', dimensions: 3 }, textEmotion: { model: 'test-emotion', dtype: 'fp32' } });
    const { tokenEnv, ...without } = document();
    expect(issuesOf({ ...without, tokenenv: tokenEnv })).toEqual(['tokenenv is not a model service setting', 'tokenEnv is required']);
    expect(issuesOf({ ...document(), tokenEnv: 'lower-case', embedding: { model: 'm' } })).toEqual(['tokenEnv must be an environment variable name', 'embedding.dimensions is required']);
  });

  it("serves the companion's api embedding provider the vectors of the served model", async () => {
    const { service, models } = await start();
    const provider = new ApiEmbeddingProvider({ endpoint: `${service.url}/v1/embeddings`, model: 'test-embedding', dims: 3, apiKey: TOKEN });
    const vectors = await provider.embedBatch(['one', 'three']);
    expect(vectors.map((v) => Array.from(v))).toEqual([
      [3, 0.5, -1],
      [5, 0.5, -1],
    ]);
    expect(models.embedded).toEqual([['one', 'three']]);
  });

  it("serves the companion's classifier through the remote pipeline", async () => {
    const { service } = await start();
    const classifier = new TextEmotionClassifier({ model: 'test-emotion', dtype: 'fp32', pipelineFactory: remoteTextEmotionPipeline({ url: `${service.url}/v1/text-emotion`, token: TOKEN }) });
    expect(await classifier.classify('what a day')).toEqual([
      { label: 'joy', score: 0.75 },
      { label: 'neutral', score: 0.25 },
    ]);
  });

  it('refuses a caller without the token, and answers health without one', async () => {
    const { service, models } = await start();
    expect((await post(`${service.url}/v1/embeddings`, { model: 'test-embedding', input: ['x'] }, null)).status).toBe(401);
    expect((await post(`${service.url}/v1/text-emotion`, { model: 'test-emotion', input: 'x' }, 'wrong')).status).toBe(401);
    expect(models.embedded).toEqual([]);
    const health = await fetch(`${service.url}/health`);
    expect([health.status, await health.json()]).toEqual([200, { ok: true }]);
    const classifier = new TextEmotionClassifier({ model: 'test-emotion', dtype: 'fp32', pipelineFactory: remoteTextEmotionPipeline({ url: `${service.url}/v1/text-emotion`, token: null }) });
    await expect(classifier.classify('hello')).rejects.toThrow('text emotion service error 401');
  });

  it('refuses another model, malformed input and an oversized body', async () => {
    const { service, models } = await start();
    const other = await post(`${service.url}/v1/embeddings`, { model: 'another-embedding', input: ['x'] });
    expect([other.status, await other.json()]).toEqual([400, { error: 'model_not_served', served: 'test-embedding' }]);
    expect((await post(`${service.url}/v1/text-emotion`, { model: 'another-emotion', input: 'x' })).status).toBe(400);
    expect((await post(`${service.url}/v1/embeddings`, { model: 'test-embedding', input: 'not a list' })).status).toBe(400);
    expect((await post(`${service.url}/v1/embeddings`, { model: 'test-embedding', input: [] })).status).toBe(400);
    expect((await post(`${service.url}/v1/embeddings`, '{not json')).status).toBe(400);
    expect((await post(`${service.url}/v1/embeddings`, { model: 'test-embedding', input: ['x'.repeat(5000)] })).status).toBe(413);
    expect((await fetch(`${service.url}/v1/embeddings`)).status).toBe(405);
    expect((await post(`${service.url}/v1/unknown`, {})).status).toBe(404);
    expect(models.embedded).toEqual([]);
  });

  it('reports a failing model as a failure, to the caller and to the operator', async () => {
    const { service } = await start();
    const classifier = new TextEmotionClassifier({ model: 'test-emotion', dtype: 'fp32', pipelineFactory: remoteTextEmotionPipeline({ url: `${service.url}/v1/text-emotion`, token: TOKEN }) });
    await expect(classifier.classify('boom')).rejects.toThrow('text emotion service error 500');
    expect(errors).toEqual(['/v1/text-emotion: Error: the classifier broke']);
    const wrongSize = await start({ ...ports(), embed: (texts) => Promise.resolve(texts.map(() => Float32Array.from([1]))) });
    expect((await post(`${wrongSize.service.url}/v1/embeddings`, { model: 'test-embedding', input: ['x'] })).status).toBe(500);
  });

  describe('the models command', () => {
    const io = (env: Record<string, string>, onReady: (url: string, stop: () => void) => void): CliIo & { err: string[] } => {
      const err: string[] = [];
      let interrupt: (() => void) | null = null;
      return {
        err,
        stdout: (text) => {
          const url = /^models (\S+)/.exec(text)?.[1];
          if (url !== undefined) onReady(url, () => interrupt?.());
        },
        stderr: (text) => err.push(text),
        env,
        readFile: () => Promise.resolve(JSON.stringify(document())),
        lines: async function* () {},
        onInterrupt: (handler) => {
          interrupt = handler;
          return () => undefined;
        },
      };
    };

    it('serves until interrupted, and needs its token', async () => {
      let answered: Promise<number> | null = null;
      const running = io({ LITE_MODELS_TOKEN: TOKEN }, (url, stop) => {
        answered = post(`${url}/v1/embeddings`, { model: 'test-embedding', input: ['abcd'] }).then((response) => {
          stop();
          return response.status;
        });
      });
      expect(await runCli(['models', '--config', 'models.json'], running, {}, ports())).toBe(0);
      expect(await answered).toBe(200);

      const missing = io({}, () => undefined);
      expect(await runCli(['models', '--config', 'models.json'], missing, {}, ports())).toBe(2);
      expect(missing.err.join('')).toContain('environment variable LITE_MODELS_TOKEN is not set');
    });

    it('does not start over a model that fails or returns another size', async () => {
      const broken = io({ LITE_MODELS_TOKEN: TOKEN }, () => undefined);
      expect(await runCli(['models', '--config', 'models.json'], broken, {}, { ...ports(), classify: () => Promise.reject(new Error('no weights')) })).toBe(1);
      expect(broken.err.join('')).toContain('the model service could not start: no weights');
      const sized = io({ LITE_MODELS_TOKEN: TOKEN }, () => undefined);
      expect(await runCli(['models', '--config', 'models.json'], sized, {}, { ...ports(), embed: () => Promise.resolve([Float32Array.from([1, 2])]) })).toBe(1);
      expect(sized.err.join('')).toContain('returns 2 dimensions, not the configured 3');
    });
  });
});

describe('a companion configured for a remote text-emotion classifier', () => {
  const COMPANION_ID = '5e1f0c3a-7b2d-4c8e-9a10-2b3c4d5e6f70';
  const base = () => liteConfigDocument('/srv/lite/data', COMPANION_ID);

  it('loads its own classifier unless a textEmotion block names a service', () => {
    const local = parseLiteConfig(base());
    if (!local.ok) throw new Error(JSON.stringify(local.error));
    expect(local.value.textEmotion).toBeNull();
    const remote = parseLiteConfig({ ...base(), textEmotion: { model: 'test-emotion', provider: { kind: 'api', url: 'http://models.example:8791/v1/text-emotion', apiKeyEnv: 'LITE_MODELS_TOKEN' } } });
    if (!remote.ok) throw new Error(JSON.stringify(remote.error));
    expect(remote.value.textEmotion).toEqual({ model: 'test-emotion', provider: { kind: 'api', url: 'http://models.example:8791/v1/text-emotion', apiKeyEnv: 'LITE_MODELS_TOKEN' } });
    expect(readSecrets(remote.value, { [DATABASE_URL_ENV]: 'postgres://x', LITE_MODELS_TOKEN: TOKEN })).toMatchObject({ ok: true, value: { textEmotionApiKey: TOKEN } });
    expect(readSecrets(remote.value, { [DATABASE_URL_ENV]: 'postgres://x' })).toEqual({ ok: false, error: { kind: 'invalid', issues: ['environment variable LITE_MODELS_TOKEN is not set'] } });
  });

  it('refuses an incomplete or unknown provider', () => {
    const parsed = parseLiteConfig({ ...base(), textEmotion: { model: 'm', provider: { kind: 'local', url: 'ftp://x', apiKeyEnv: null } } });
    expect(parsed.ok ? [] : parsed.error.kind === 'invalid' ? parsed.error.issues : []).toEqual(['textEmotion.provider.kind must be one of api', 'textEmotion.provider.url must be an http(s) URL']);
  });
});
