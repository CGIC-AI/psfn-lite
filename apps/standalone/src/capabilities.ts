/**
 * The production host capabilities, built from the config and the secrets
 * read from the environment: the system clock, random ids, the configured
 * pi-ai provider and model, and the configured embedding provider (or none).
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ok, type Id, type IdSource, type Result } from './core.ts';
import { createCatalogModelRuntime, createDisabledEmbeddings, createOpenAiCompatibleEmbeddings } from './harness.ts';
import type { LiteConfig, LiteSecrets } from './config.ts';
import type { OperatorChannel } from './local-host.ts';
import type { LiteDiagnostic, LiteHostCapabilities } from './runtime.ts';

/** Builds what the host supplies; the CLI takes it as a parameter so another host can supply its own. */
export type HostFactory = (input: {
  readonly config: LiteConfig;
  readonly secrets: LiteSecrets;
  readonly channel: OperatorChannel;
  readonly onDiagnostic: (diagnostic: LiteDiagnostic) => void;
}) => Result<LiteHostCapabilities>;

export const randomIds: IdSource = {
  next: <Kind extends string>(kind: Kind) => `${kind}:${randomUUID()}` as Id<Kind>,
};

export const productionHost: HostFactory = ({ config, secrets, channel, onDiagnostic }) => {
  const model = createCatalogModelRuntime({
    provider: config.model.provider,
    modelId: config.model.modelId,
    apiKey: secrets.modelApiKey,
    maxOutputTokens: config.model.maxOutputTokens,
  });
  if (!model.ok) return model;
  const provider = config.embedding.provider;
  const embeddings =
    provider.kind === 'disabled'
      ? createDisabledEmbeddings()
      : createOpenAiCompatibleEmbeddings({
          baseUrl: provider.baseUrl,
          model: provider.model,
          dimensions: config.embedding.space.dimensions,
          apiKey: secrets.embeddingApiKey ?? '',
          timeoutMs: provider.timeoutMs,
        });
  return ok({
    clock: { now: () => new Date() },
    ids: randomIds,
    model: model.value,
    embeddings,
    channel,
    instance: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    onDiagnostic,
  });
};
